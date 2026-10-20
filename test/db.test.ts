import { randomBytes } from 'node:crypto';
import { PrismaClient } from '@prisma/client';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { withTenant } from '../src/server/db.js';
import { createInstallationStore, markUninstalled } from '../src/server/slack/installationStore.js';
import { fullSync, syncOneUser } from '../src/server/slack/sync.js';
import { getChart } from '../src/server/chart/service.js';
import { accessDenied } from '../src/server/auth.js';
import { purgeWorkspace } from '../src/server/jobs.js';
import { EXTERNAL_GROUP_ID } from '../src/server/chart/tree.js';
import { fakeSlack, user, type FakeWorkspace } from './fakeSlack.js';

// Runs against a real Postgres with the migrations applied, because the
// tenant isolation lives in the database. Set TEST_DATABASE_URL to run.
const url = process.env.TEST_DATABASE_URL;
const suite = url ? describe : describe.skip;

suite('database', () => {
  const db = new PrismaClient({ datasourceUrl: url });
  const key = randomBytes(32).toString('base64');
  const store = createInstallationStore({ encryptionKey: key, db });

  const install = (teamId: string, userId = 'UADMIN') =>
    store.storeInstallation({
      team: { id: teamId, name: `Team ${teamId}` },
      enterprise: undefined,
      user: { id: userId, token: undefined, scopes: undefined },
      bot: { id: 'B1', userId: 'UBOT', token: `xoxb-${teamId}-secret`, scopes: ['users:read'] },
      tokenType: 'bot',
      isEnterpriseInstall: false,
      appId: 'A1',
    });

  const workspace = (): FakeWorkspace => ({
    team: { id: 'T1', name: 'Acme', domain: 'acme' },
    fields: [
      { id: 'XfMGR', label: 'Manager', type: 'user' },
      { id: 'XfDEPT', label: 'Department', type: 'text' },
    ],
    members: [
      user('UCEO', 'Carla'),
      user('UCTO', 'Theo'),
      user('UENG', 'Erin'),
      user('UGUEST', 'Gwen', { is_restricted: true }),
      user('UOLD', 'Olaf', { deleted: true }),
      user('UBOT', 'Robo', { is_bot: true }),
    ],
    profiles: {
      UCTO: { XfMGR: 'UCEO', XfDEPT: 'Engineering' },
      UENG: { XfMGR: 'UCTO', XfDEPT: 'Engineering' },
      UGUEST: { XfMGR: 'UCTO' },
    },
    channels: [
      { id: 'C1', is_ext_shared: false, members: ['UCEO', 'UCTO'] },
      { id: 'C2', is_ext_shared: true, members: ['UCTO', 'UPARTNER', 'UENG', 'UUNKNOWN'] },
    ],
    strangers: { UPARTNER: user('UPARTNER', 'Pat', {}, 'T9') },
    otherTeams: { T9: 'Globex' },
  });

  beforeAll(async () => {
    await db.$connect();
  });

  beforeEach(async () => {
    await db.$executeRawUnsafe(
      'TRUNCATE workspace, person, person_override, user_session, admin_role, audit_log, sync_run',
    );
  });

  afterAll(async () => {
    await db.$disconnect();
  });

  it('stores installations encrypted and makes the installer the first admin', async () => {
    await install('T1');
    const fetched = await store.fetchInstallation({ teamId: 'T1', isEnterpriseInstall: false, enterpriseId: undefined });
    expect(fetched.bot?.token).toBe('xoxb-T1-secret');
    const row = await withTenant('T1', (tx) => tx.workspace.findUniqueOrThrow({ where: { teamId: 'T1' } }), db);
    expect(row.installation).not.toContain('xoxb');
    const admins = await withTenant('T1', (tx) => tx.adminRole.findMany(), db);
    expect(admins.map((a) => a.slackUserId)).toEqual(['UADMIN']);

    // A reinstall by someone else does not add a second automatic admin.
    await install('T1', 'UOTHER');
    expect(await withTenant('T1', (tx) => tx.adminRole.count(), db)).toBe(1);
  });

  it('refuses installations after uninstall', async () => {
    await install('T1');
    await markUninstalled('T1', db);
    await expect(
      store.fetchInstallation({ teamId: 'T1', isEnterpriseInstall: false, enterpriseId: undefined }),
    ).rejects.toThrow();
  });

  it('syncs members, managers, photos, guests and Slack Connect people', async () => {
    await install('T1');
    const slack = fakeSlack(workspace());
    const counts = await fullSync('T1', slack, { db });

    expect(counts).toMatchObject({ members: 6, slackConnect: 1 });
    // Profiles are read only for active humans: 4 of 6 members.
    expect(slack.calls['users.profile.get']).toBe(4);

    const people = await withTenant('T1', (tx) => tx.person.findMany({ orderBy: { slackUserId: 'asc' } }), db);
    const by = Object.fromEntries(people.map((p) => [p.slackUserId, p]));
    expect(by.UENG).toMatchObject({
      name: 'Erin',
      userType: 'employee',
      slackManagerId: 'UCTO',
      department: 'Engineering',
      avatarUrl: 'https://avatars.slack-edge.com/UENG_192.png',
    });
    expect(by.UGUEST?.userType).toBe('multi_channel_guest');
    expect(by.UBOT?.userType).toBe('bot');
    expect(by.UOLD?.isDeleted).toBe(true);
    expect(by.UPARTNER).toMatchObject({ userType: 'slack_connect', externalOrg: 'Globex', homeTeamId: 'T9' });

    const ws = await withTenant('T1', (tx) => tx.workspace.findUniqueOrThrow({ where: { teamId: 'T1' } }), db);
    expect(ws).toMatchObject({ name: 'Acme', managerFieldId: 'XfMGR', departmentFieldId: 'XfDEPT' });

    const run = await withTenant('T1', (tx) => tx.syncRun.findFirstOrThrow(), db);
    expect(run.finishedAt).not.toBeNull();
    // UUNKNOWN could not be looked up and is recorded, not fatal.
    expect(JSON.stringify(run.errors)).toContain('UUNKNOWN');
  });

  it('builds the chart centered on the viewer with external people badged', async () => {
    await install('T1');
    await fullSync('T1', fakeSlack(workspace()), { db });

    const chart = await getChart('T1', 'UENG', null, db);
    expect(chart.focusId).toBe('UENG');
    const node = (id: string) => chart.nodes.find((n) => n.id === id);
    expect(node('UENG')?.parentId).toBe('UCTO');
    expect(node('UGUEST')).toMatchObject({ parentId: 'UCTO', badge: 'guest' });
    expect(node('UPARTNER')).toMatchObject({ parentId: EXTERNAL_GROUP_ID, badge: 'external', externalOrg: 'Globex' });
    expect(node('UBOT')).toBeUndefined();
    expect(node('UOLD')).toBeUndefined();

    expect((await getChart('T1', 'UENG', 'UCEO', db)).focusId).toBe('UCEO');
  });

  it('applies admin overrides through the effective view and keeps them across syncs', async () => {
    await install('T1');
    const ws = workspace();
    await fullSync('T1', fakeSlack(ws), { db });
    await withTenant(
      'T1',
      async (tx) => {
        const eng = await tx.person.findUniqueOrThrow({ where: { teamId_slackUserId: { teamId: 'T1', slackUserId: 'UENG' } } });
        await tx.personOverride.create({
          data: { personId: eng.id, teamId: 'T1', managerSlackId: 'UCEO', userType: 'contractor', updatedBy: 'UADMIN' },
        });
      },
      db,
    );
    await fullSync('T1', fakeSlack(ws), { db });
    const chart = await getChart('T1', 'UENG', null, db);
    expect(chart.nodes.find((n) => n.id === 'UENG')).toMatchObject({ parentId: 'UCEO', badge: 'contractor' });
  });

  it('marks people deleted when they disappear, and live events update one person', async () => {
    await install('T1');
    const ws = workspace();
    await fullSync('T1', fakeSlack(ws), { db });

    ws.channels = ws.channels.filter((c) => c.id !== 'C2');
    const counts = await fullSync('T1', fakeSlack(ws), { db });
    expect(counts.markedDeleted).toBe(1);

    ws.members.push(user('UNEW', 'Nina'));
    ws.profiles.UNEW = { XfMGR: 'UCTO' };
    const record = await syncOneUser('T1', fakeSlack(ws), 'UNEW', { db });
    expect(record).toMatchObject({ slackManagerId: 'UCTO', userType: 'employee' });
    const chart = await getChart('T1', 'UNEW', null, db);
    expect(chart.nodes.find((n) => n.id === 'UNEW')?.parentId).toBe('UCTO');
  });

  it('lets employees view the chart and keeps guests out unless allowed', async () => {
    await install('T1');
    await fullSync('T1', fakeSlack(workspace()), { db });
    expect(await accessDenied('T1', 'UENG', db)).toBeNull();
    expect(await accessDenied('T1', 'UGUEST', db)).toMatch(/only available to employees/);
    expect(await accessDenied('T1', 'UOLD', db)).toMatch(/not part of this workspace/);
    expect(await accessDenied('T1', 'UNOBODY', db)).toMatch(/not part of this workspace/);

    await withTenant('T1', (tx) => tx.workspace.update({ where: { teamId: 'T1' }, data: { allowGuestViewers: true } }), db);
    expect(await accessDenied('T1', 'UGUEST', db)).toBeNull();
  });

  describe('tenant isolation', () => {
    beforeEach(async () => {
      await install('T1');
      await install('T2');
      await fullSync('T1', fakeSlack(workspace()), { db });
      const other = workspace();
      other.team = { id: 'T2', name: 'Initech', domain: 'initech' };
      other.members = [user('UZED', 'Zed', {}, 'T2')];
      other.channels = [];
      await fullSync('T2', fakeSlack(other), { db });
    });

    it('only shows the current workspace, even to queries without a filter', async () => {
      const t1 = await withTenant('T1', (tx) => tx.person.findMany(), db);
      expect(t1.length).toBeGreaterThan(1);
      expect(t1.every((p) => p.teamId === 'T1')).toBe(true);

      const t2 = await withTenant('T2', (tx) => tx.$queryRaw<{ slack_user_id: string }[]>`SELECT slack_user_id FROM effective_person`, db);
      expect(t2.map((r) => r.slack_user_id)).toEqual(['UZED']);
    });

    it('sees nothing when no workspace is set', async () => {
      expect(await db.person.count()).toBe(0);
      expect(await db.workspace.count()).toBe(0);
    });

    it("refuses writes into another workspace's rows", async () => {
      await expect(
        withTenant(
          'T1',
          (tx) =>
            tx.person.create({ data: { teamId: 'T2', slackUserId: 'UEVIL', name: 'Evil', userType: 'employee' } }),
          db,
        ),
      ).rejects.toThrow(/row-level security/);

      const updated = await withTenant(
        'T1',
        (tx) => tx.person.updateMany({ where: { slackUserId: 'UZED' }, data: { name: 'Hacked' } }),
        db,
      );
      expect(updated.count).toBe(0);
    });

    it('purges one workspace without touching another', async () => {
      await purgeWorkspace('T1', db);
      expect(await withTenant('T1', (tx) => tx.person.count(), db)).toBe(0);
      expect(await withTenant('T1', (tx) => tx.workspace.count(), db)).toBe(0);
      expect(await withTenant('T2', (tx) => tx.person.count(), db)).toBe(1);
    });
  });
});
