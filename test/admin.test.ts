import { randomBytes } from 'node:crypto';
import express from 'express';
import cookieParser from 'cookie-parser';
import request from 'supertest';
import { PrismaClient, type UserType } from '@prisma/client';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { withTenant } from '../src/server/db.js';
import { apiRouter } from '../src/server/api.js';
import { SESSION_COOKIE } from '../src/server/auth.js';
import { randomToken, sha256 } from '../src/server/crypto.js';
import { createInstallationStore } from '../src/server/slack/installationStore.js';
import { savePeople, type PersonRecord } from '../src/server/slack/sync.js';
import type { AdminPerson } from '../src/shared/admin.js';

// Admin API against a real Postgres, like db.test.ts. Set TEST_DATABASE_URL.
const url = process.env.TEST_DATABASE_URL;
const suite = url ? describe : describe.skip;

suite('admin api', () => {
  const db = new PrismaClient({ datasourceUrl: url });
  const store = createInstallationStore({ encryptionKey: randomBytes(32).toString('base64'), db });
  const synced: string[] = [];
  const app = express();
  app.use(cookieParser());
  app.use(apiRouter({ db, enqueueWorkspaceSync: async (t) => void synced.push(t) }));

  const install = (teamId: string, installer = 'UADMIN') =>
    store.storeInstallation({
      team: { id: teamId, name: `Team ${teamId}` },
      enterprise: undefined,
      user: { id: installer, token: undefined, scopes: undefined },
      bot: { id: 'B1', userId: 'UBOT', token: 'xoxb-1', scopes: [] },
      tokenType: 'bot',
      isEnterpriseInstall: false,
      appId: 'A1',
    });

  const person = (
    id: string,
    name: string,
    manager: string | null,
    extra: Partial<PersonRecord> & { userType?: UserType } = {},
  ): PersonRecord => ({
    slackUserId: id,
    homeTeamId: 'T1',
    name,
    displayName: null,
    title: `${name}'s title`,
    department: null,
    email: `${name.toLowerCase()}@acme.test`,
    avatarUrl: null,
    userType: 'employee',
    externalOrg: null,
    slackManagerId: manager,
    isSlackAdmin: false,
    isDeleted: false,
    ...extra,
  });

  const cookieFor = async (teamId: string, slackUserId: string) => {
    const secret = randomToken();
    await withTenant(
      teamId,
      (tx) =>
        tx.userSession.create({
          data: { id: sha256(secret), teamId, slackUserId, expiresAt: new Date(Date.now() + 3_600_000) },
        }),
      db,
    );
    return `${SESSION_COOKIE}=${teamId}.${secret}`;
  };

  let admin: string;
  let member: string;

  beforeAll(async () => {
    await db.$connect();
  });

  beforeEach(async () => {
    await db.$executeRawUnsafe(
      'TRUNCATE workspace, person, person_override, user_session, admin_role, audit_log, sync_run',
    );
    synced.length = 0;
    await install('T1');
    await savePeople(
      'T1',
      [
        person('UADMIN', 'Ada', null),
        person('UCEO', 'Carla', null),
        person('UCTO', 'Theo', 'UCEO'),
        person('UENG', 'Erin', 'UCTO'),
        person('ULONE', 'Lena', null),
        person('UGUEST', 'Gwen', 'UCTO', { userType: 'multi_channel_guest' }),
        person('UBOSS', 'Boris', null, { isSlackAdmin: true }),
        person('UOLD', 'Olaf', 'UCEO', { isDeleted: true }),
        person('UORPHAN', 'Oscar', 'UOLD'),
      ],
      db,
    );
    admin = await cookieFor('T1', 'UADMIN');
    member = await cookieFor('T1', 'UENG');
  });

  afterAll(async () => {
    await db.$disconnect();
  });

  const people = async (cookie = admin) => {
    const res = await request(app).get('/api/admin/people').set('Cookie', cookie).expect(200);
    return Object.fromEntries((res.body.people as AdminPerson[]).map((p) => [p.slackUserId, p]));
  };

  it('tells the page who is an admin', async () => {
    expect((await request(app).get('/api/me').set('Cookie', admin)).body).toMatchObject({ isAdmin: true });
    expect((await request(app).get('/api/me').set('Cookie', member)).body).toMatchObject({ isAdmin: false });
  });

  it('refuses everyone who is not an admin', async () => {
    await request(app).get('/api/admin/people').expect(401);
    const res = await request(app).get('/api/admin/people').set('Cookie', member).expect(403);
    expect(res.body.error).toBe('not_admin');
    await request(app).patch('/api/admin/people/UENG').set('Cookie', member).send({ hidden: true }).expect(403);
  });

  it('lists people with Slack values, overrides and problems', async () => {
    const by = await people();
    expect(by.UENG).toMatchObject({ effective: { managerSlackId: 'UCTO' }, chartParentId: 'UCTO', issues: [] });
    expect(by.ULONE?.issues).toContain('unplaced');
    // Olaf is deactivated, so Oscar hangs under Olaf's manager until fixed.
    expect(by.UORPHAN).toMatchObject({ issues: ['rerouted'], chartParentId: 'UCEO' });
    expect(by.UADMIN?.isAdmin).toBe(true);
    expect(by.UCTO?.reports).toBe(2);
  });

  it('fixes reporting lines, refuses loops and records every change', async () => {
    await request(app).patch('/api/admin/people/ULONE').set('Cookie', admin).send({ managerSlackId: 'UCTO' }).expect(200);
    let by = await people();
    expect(by.ULONE).toMatchObject({ chartParentId: 'UCTO', issues: [], override: { managerSlackId: 'UCTO' } });

    // Carla reporting to Erin would make Carla -> Erin -> Theo -> Carla.
    const loop = await request(app)
      .patch('/api/admin/people/UCEO')
      .set('Cookie', admin)
      .send({ managerSlackId: 'UENG' })
      .expect(409);
    expect(loop.body).toMatchObject({ error: 'reporting_loop' });

    await request(app).patch('/api/admin/people/UENG').set('Cookie', admin).send({ managerSlackId: 'UENG' }).expect(400);
    await request(app).patch('/api/admin/people/UENG').set('Cookie', admin).send({ managerSlackId: 'UOLD' }).expect(400);
    await request(app).patch('/api/admin/people/UENG').set('Cookie', admin).send({ managerSlackId: 'UNOPE' }).expect(400);

    // '' means "no manager"; null goes back to Slack's value.
    await request(app).patch('/api/admin/people/UENG').set('Cookie', admin).send({ managerSlackId: '' }).expect(200);
    expect((await people()).UENG?.effective.managerSlackId).toBeNull();
    await request(app).patch('/api/admin/people/UENG').set('Cookie', admin).send({ managerSlackId: null }).expect(200);
    by = await people();
    expect(by.UENG?.effective.managerSlackId).toBe('UCTO');
    expect(by.UENG?.override).toBeNull();

    const audit = await request(app).get('/api/admin/audit').set('Cookie', admin).expect(200);
    expect(audit.body.entries.map((e: { action: string }) => e.action)).toEqual([
      'person.update',
      'person.update',
      'person.update',
    ]);
    expect(audit.body.entries[0]).toMatchObject({ actorName: 'Ada', personName: 'Erin', after: null });
  });

  it('hides people, marks them external and edits titles, keeping Slack data intact', async () => {
    await request(app).patch('/api/admin/people/UCTO').set('Cookie', admin).send({ hidden: true }).expect(200);
    await request(app)
      .patch('/api/admin/people/UENG')
      .set('Cookie', admin)
      .send({ userType: 'contractor', externalOrg: ' Initech ', title: 'Platform contractor' })
      .expect(200);
    // Only employee, contractor and external can be set by hand, and a Slack
    // guest can never be relabeled an employee.
    await request(app).patch('/api/admin/people/UENG').set('Cookie', admin).send({ userType: 'bot' }).expect(400);
    const guest = await request(app).patch('/api/admin/people/UGUEST').set('Cookie', admin).send({ userType: 'employee' });
    expect(guest.body.error).toBe('cannot_make_employee');
    await request(app).patch('/api/admin/people/UGUEST').set('Cookie', admin).send({ userType: 'contractor' }).expect(200);

    const by = await people();
    expect(by.UENG).toMatchObject({
      slack: { userType: 'employee', title: "Erin's title" },
      effective: { userType: 'contractor', externalOrg: 'Initech', title: 'Platform contractor' },
      // Rerouted past a manager the admin hid on purpose: not a problem.
      issues: [],
      chartParentId: 'UCEO',
    });

    const chart = await request(app).get('/api/chart').set('Cookie', admin).expect(200);
    const nodes = new Map(chart.body.nodes.map((n: { id: string }) => [n.id, n]));
    expect(nodes.has('UCTO')).toBe(false);
    expect(nodes.get('UENG')).toMatchObject({ parentId: 'UCEO', badge: 'contractor', externalOrg: 'Initech' });
  });

  it('manages admins: guests never, the last admin stays, removal applies at once', async () => {
    const guest = await request(app).post('/api/admin/admins').set('Cookie', admin).send({ slackUserId: 'UGUEST' });
    expect(guest.status).toBe(400);
    expect(guest.body.error).toBe('not_eligible');

    const last = await request(app).delete('/api/admin/admins/UADMIN').set('Cookie', admin).expect(400);
    expect(last.body.error).toBe('last_admin');

    const added = await request(app).post('/api/admin/admins').set('Cookie', admin).send({ slackUserId: 'UENG' }).expect(200);
    expect(added.body.admins.map((a: { slackUserId: string }) => a.slackUserId)).toEqual(['UADMIN', 'UENG']);
    await request(app).get('/api/admin/people').set('Cookie', member).expect(200);

    await request(app).delete('/api/admin/admins/UENG').set('Cookie', admin).expect(200);
    await request(app).get('/api/admin/people').set('Cookie', member).expect(403);

    // Marking an admin as a contractor takes the admin rights away too.
    await request(app).post('/api/admin/admins').set('Cookie', admin).send({ slackUserId: 'UENG' }).expect(200);
    await request(app).patch('/api/admin/people/UENG').set('Cookie', admin).send({ userType: 'contractor' }).expect(200);
    await request(app).get('/api/admin/people').set('Cookie', member).expect(403);
  });

  it('makes Slack admins org chart admins only when the setting is on', async () => {
    const boss = await cookieFor('T1', 'UBOSS');
    await request(app).get('/api/admin/people').set('Cookie', boss).expect(403);
    const res = await request(app)
      .patch('/api/admin/settings')
      .set('Cookie', admin)
      .send({ autoAdminSlackAdmins: true })
      .expect(200);
    expect(res.body).toEqual({ allowGuestViewers: false, autoAdminSlackAdmins: true });
    await request(app).get('/api/admin/people').set('Cookie', boss).expect(200);

    const admins = await request(app).get('/api/admin/admins').set('Cookie', admin).expect(200);
    expect(admins.body.admins).toContainEqual(expect.objectContaining({ slackUserId: 'UBOSS', source: 'slack_admin' }));
    const remove = await request(app).delete('/api/admin/admins/UBOSS').set('Cookie', admin).expect(400);
    expect(remove.body.error).toBe('not_a_role');
  });

  it('imports reporting lines from CSV with a preview first', async () => {
    const csv = [
      'Email,Manager Email,Title',
      'lena@acme.test,theo@acme.test,Designer',
      'erin@acme.test,theo@acme.test,',
      'carla@acme.test,erin@acme.test,',
      'nobody@acme.test,theo@acme.test,',
      'theo@acme.test,olaf@acme.test,',
    ].join('\n');

    const preview = await request(app).post('/api/admin/import').set('Cookie', admin).send({ csv }).expect(200);
    expect(preview.body).toMatchObject({ applied: false, changed: 1, errors: 3 });
    expect(preview.body.rows.map((r: { status: string }) => r.status)).toEqual(['ok', 'unchanged', 'error', 'error', 'error']);
    expect((await people()).ULONE?.override).toBeNull();

    await request(app).post('/api/admin/import').set('Cookie', admin).send({ csv, apply: true }).expect(200);
    const by = await people();
    expect(by.ULONE).toMatchObject({ effective: { managerSlackId: 'UCTO', title: 'Designer' } });
    // Matching Slack's own value adds no override.
    expect(by.UENG?.override).toBeNull();

    const bad = await request(app).post('/api/admin/import').set('Cookie', admin).send({ csv: 'name,boss\nx,y' }).expect(400);
    expect(bad.body.error).toBe('bad_header');
  });

  it('shows sync runs and can start a sync', async () => {
    const res = await request(app).get('/api/admin/sync').set('Cookie', admin).expect(200);
    expect(res.body).toMatchObject({ canStart: true });
    await request(app).post('/api/admin/sync').set('Cookie', admin).expect(202);
    expect(synced).toEqual(['T1']);
  });

  it("cannot reach another workspace's people", async () => {
    await install('T2', 'UZED');
    await savePeople('T2', [person('UZED', 'Zed', null), person('UOTHER', 'Otto', null)], db);
    // The T1 admin edits a T2 id: it does not exist in T1.
    await request(app).patch('/api/admin/people/UOTHER').set('Cookie', admin).send({ hidden: true }).expect(404);
    await request(app).post('/api/admin/admins').set('Cookie', admin).send({ slackUserId: 'UZED' }).expect(404);
    const otto = await withTenant('T2', (tx) => tx.person.findFirst({ where: { slackUserId: 'UOTHER' }, include: { override: true } }), db);
    expect(otto?.override).toBeNull();
  });
});
