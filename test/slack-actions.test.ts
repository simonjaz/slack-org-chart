import { randomBytes } from 'node:crypto';
import express from 'express';
import cookieParser from 'cookie-parser';
import request from 'supertest';
import { PrismaClient, type UserType } from '@prisma/client';
import type { WebClient } from '@slack/web-api';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { withTenant } from '../src/server/db.js';
import { apiRouter } from '../src/server/api.js';
import { SESSION_COOKIE } from '../src/server/auth.js';
import { decrypt, encrypt, randomToken, sha256 } from '../src/server/crypto.js';
import { purgeWorkspace } from '../src/server/jobs.js';
import type { ActionsClient } from '../src/server/actions.js';
import { forgetRevokedUsers, grantRouter } from '../src/server/slack/grants.js';
import { fillProfileLinks } from '../src/server/slack/profileLinks.js';
import { slackSurfaces } from '../src/server/slack/surfaces.js';
import { createInstallationStore } from '../src/server/slack/installationStore.js';
import { savePeople, type PersonRecord } from '../src/server/slack/sync.js';

// Group DMs, channels, the grant flow, the profile link fill and the Slack
// surfaces, against a real Postgres like db.test.ts. Set TEST_DATABASE_URL.
const url = process.env.TEST_DATABASE_URL;
const suite = url ? describe : describe.skip;

// A Slack error as WebClient throws it.
const slackErr = (error: string, extra: object = {}) => Object.assign(new Error(error), { data: { ok: false, error, ...extra } });

suite('slack actions', () => {
  const db = new PrismaClient({ datasourceUrl: url });
  const key = randomBytes(32).toString('base64');
  const store = createInstallationStore({ encryptionKey: key, db });
  const baseUrl = 'https://orgchart.test';

  // What the fake user client was asked, and how it answers.
  const calls: { method: string; args: any; token: string }[] = [];
  let answer: Record<string, (args: any) => any> = {};
  const userClient = (token: string): ActionsClient => {
    const method = (name: string) => async (args: any) => {
      calls.push({ method: name, args, token });
      const fn = answer[name];
      if (!fn) throw new Error(`unexpected ${name}`);
      return fn(args);
    };
    return { conversations: { open: method('open'), create: method('create'), invite: method('invite') } };
  };

  const app = express();
  app.use(cookieParser());
  app.use(apiRouter({ db, actions: { encryptionKey: key, userClient } }));

  const person = (id: string, name: string, manager: string | null, extra: Partial<PersonRecord> & { userType?: UserType } = {}): PersonRecord => ({
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

  const grant = (slackUserId: string, token = `xoxp-${slackUserId}`) =>
    withTenant(
      'T1',
      (tx) =>
        tx.userGrant.create({
          data: { teamId: 'T1', slackUserId, slackTeamId: 'T1', token: encrypt(token, key), scopes: 'im:write' },
        }),
      db,
    );

  let erin: string;

  beforeAll(async () => {
    await db.$connect();
  });

  beforeEach(async () => {
    await db.$executeRawUnsafe(
      'TRUNCATE workspace, person, person_override, user_session, admin_role, audit_log, sync_run, user_grant, profile_link',
    );
    calls.length = 0;
    answer = {};
    await store.storeInstallation({
      team: { id: 'T1', name: 'Acme' },
      enterprise: undefined,
      user: { id: 'UADMIN', token: undefined, scopes: undefined },
      bot: { id: 'B1', userId: 'UBOT', token: 'xoxb-1', scopes: [] },
      tokenType: 'bot',
      isEnterpriseInstall: false,
      appId: 'A1',
    });
    await savePeople(
      'T1',
      [
        person('UADMIN', 'Ada', null),
        person('UCEO', 'Carla', null),
        person('UCTO', 'Theo', 'UCEO'),
        person('UENG', 'Erin', 'UCTO'),
        person('UPEER', 'Pia', 'UCTO'),
        person('UGUEST', 'Gwen', 'UCTO', { userType: 'multi_channel_guest' }),
        person('UPAT', 'Pat', null, { userType: 'slack_connect', homeTeamId: 'T9' }),
        person('UOLD', 'Olaf', 'UCEO', { isDeleted: true }),
        person('UROBO', 'Robo', null, { userType: 'bot' }),
      ],
      db,
    );
    erin = await cookieFor('T1', 'UENG');
  });

  afterAll(async () => {
    await db.$disconnect();
  });

  describe('group DMs and channels', () => {
    it('asks for the person’s own token first', async () => {
      expect((await request(app).get('/api/actions/status').set('Cookie', erin)).body).toEqual({ granted: false });
      const res = await request(app)
        .post('/api/actions/conversation')
        .set('Cookie', erin)
        .send({ userIds: ['UCTO', 'UPEER'] })
        .expect(401);
      expect(res.body.error).toBe('needs_grant');
      expect(calls).toHaveLength(0);
    });

    it('opens a group DM as the viewer, leaving the viewer out of the list', async () => {
      await grant('UENG');
      answer.open = () => ({ ok: true, channel: { id: 'G123' } });
      const res = await request(app)
        .post('/api/actions/conversation')
        .set('Cookie', erin)
        .send({ userIds: ['UCTO', 'UPEER', 'UENG', 'UPEER'] })
        .expect(200);
      expect(res.body).toEqual({ channelId: 'G123', teamId: 'T1' });
      expect(calls).toEqual([{ method: 'open', args: { users: 'UCTO,UPEER', return_im: false }, token: 'xoxp-UENG' }]);
    });

    it('refuses more than 8 people, and people who are not on the chart', async () => {
      await grant('UENG');
      answer.open = () => ({ ok: true, channel: { id: 'G1' } });
      const nine = Array.from({ length: 9 }, (_, i) => `U${100 + i}`);
      await savePeople('T1', nine.map((id) => person(id, `P${id}`, 'UCTO')), db);
      expect((await request(app).post('/api/actions/conversation').set('Cookie', erin).send({ userIds: nine })).body.error).toBe(
        'too_many',
      );
      for (const id of ['UOLD', 'UROBO', 'UNOBODY']) {
        const res = await request(app).post('/api/actions/conversation').set('Cookie', erin).send({ userIds: [id] });
        expect(res.status).toBe(400);
      }
      await withTenant('T1', async (tx) => {
        const p = await tx.person.findUniqueOrThrow({ where: { teamId_slackUserId: { teamId: 'T1', slackUserId: 'UPEER' } } });
        await tx.personOverride.create({ data: { personId: p.id, teamId: 'T1', hidden: true, updatedBy: 'UADMIN' } });
      }, db);
      expect((await request(app).post('/api/actions/conversation').set('Cookie', erin).send({ userIds: ['UPEER'] })).status).toBe(400);
      expect((await request(app).post('/api/actions/conversation').set('Cookie', erin).send({ userIds: ['UENG'] })).body.error).toBe(
        'no_people',
      );
      expect(calls).toHaveLength(0);
    });

    it('creates a channel and names the people Slack would not add', async () => {
      await grant('UENG');
      answer.create = () => ({ ok: true, channel: { id: 'C9', name: 'q4-launch' } });
      answer.invite = () => ({ ok: true, errors: [{ user: 'UGUEST', ok: false, error: 'user_is_restricted' }] });
      const res = await request(app)
        .post('/api/actions/channel')
        .set('Cookie', erin)
        .send({ name: 'Q4 Launch', isPrivate: true, userIds: ['UCTO', 'UGUEST', 'UPAT'] })
        .expect(200);
      expect(res.body).toMatchObject({ channelId: 'C9', name: 'q4-launch', teamId: 'T1', invited: ['UCTO', 'UPAT'] });
      expect(res.body.notInvited).toEqual([{ userId: 'UGUEST', reason: expect.stringContaining('guest') }]);
      expect(calls.map((c) => [c.method, c.args])).toEqual([
        ['create', { name: 'q4-launch', is_private: true }],
        ['invite', { channel: 'C9', users: 'UCTO,UGUEST,UPAT', force: true }],
      ]);
    });

    it('reports everyone as left out when Slack refuses the whole invite', async () => {
      await grant('UENG');
      answer.create = () => ({ ok: true, channel: { id: 'C9', name: 'x' } });
      answer.invite = () => {
        throw slackErr('cant_invite');
      };
      const res = await request(app).post('/api/actions/channel').set('Cookie', erin).send({ name: 'x', userIds: ['UGUEST'] }).expect(200);
      expect(res.body.invited).toEqual([]);
      expect(res.body.notInvited).toEqual([{ userId: 'UGUEST', reason: 'cannot be added to this channel' }]);
    });

    it('explains a taken channel name', async () => {
      await grant('UENG');
      answer.create = () => {
        throw slackErr('name_taken');
      };
      const res = await request(app).post('/api/actions/channel').set('Cookie', erin).send({ name: 'general', userIds: ['UCTO'] });
      expect(res.status).toBe(409);
      expect(res.body.message).toContain('#general already exists');
      await request(app).post('/api/actions/channel').set('Cookie', erin).send({ name: '!!!', userIds: ['UCTO'] }).expect(400);
    });

    it('forgets a token Slack revoked and asks again', async () => {
      await grant('UENG');
      answer.open = () => {
        throw slackErr('token_revoked');
      };
      const res = await request(app).post('/api/actions/conversation').set('Cookie', erin).send({ userIds: ['UCTO'] });
      expect(res.status).toBe(401);
      expect(res.body.error).toBe('needs_grant');
      expect(await withTenant('T1', (tx) => tx.userGrant.count(), db)).toBe(0);
    });

    it('drops tokens when Slack says they were revoked, and on purge', async () => {
      await grant('UENG');
      await grant('UCTO');
      await forgetRevokedUsers('T1', ['UENG'], db);
      expect(await withTenant('T1', (tx) => tx.userGrant.findMany({ select: { slackUserId: true } }), db)).toEqual([
        { slackUserId: 'UCTO' },
      ]);
      await purgeWorkspace('T1', db);
      expect(await withTenant('T1', (tx) => tx.userGrant.count(), db)).toBe(0);
    });
  });

  describe('grant flow', () => {
    let oauthAnswer: any;
    const revoked: string[] = [];
    const slack = {
      oauth: { v2: { access: async () => oauthAnswer } },
      auth: { revoke: async ({ token }: { token: string }) => void revoked.push(token) },
    } as unknown as WebClient;
    const grantApp = express();
    grantApp.use(cookieParser());
    grantApp.use(
      grantRouter({ baseUrl, clientId: 'cid', clientSecret: 'secret', encryptionKey: key, secureCookies: false, db, slack }),
    );

    // Starts a grant and returns the cookies and state Slack would echo.
    const start = async (cookie: string, kind = 'actions') => {
      const res = await request(grantApp).get(`/auth/grant?kind=${kind}&next=/chart%3Fuser%3DUCTO`).set('Cookie', cookie);
      expect(res.status).toBe(302);
      const location = new URL(res.headers.location!);
      const stateCookie = (res.headers['set-cookie'] as unknown as string[]).map((c) => c.split(';')[0]).join('; ');
      return { location, cookies: `${cookie}; ${stateCookie}`, state: location.searchParams.get('state')! };
    };

    it('sends the person to Slack with only the scopes this kind needs', async () => {
      const { location } = await start(erin);
      expect(location.origin + location.pathname).toBe('https://slack.com/oauth/v2/authorize');
      expect(location.searchParams.get('user_scope')).toBe(
        'im:write,mpim:write,channels:manage,channels:write.invites,groups:write,groups:write.invites',
      );
      expect(location.searchParams.get('team')).toBe('T1');
      expect(location.searchParams.get('redirect_uri')).toBe(`${baseUrl}/auth/grant/callback`);
      // Signed out: sign in first, then come back.
      const res = await request(grantApp).get('/auth/grant?kind=actions');
      expect(res.headers.location).toMatch(/^\/auth\/login\?next=/);
    });

    it('stores the token encrypted and returns to the chart', async () => {
      const { cookies, state } = await start(erin);
      oauthAnswer = {
        ok: true,
        team: { id: 'T1' },
        authed_user: {
          id: 'UENG',
          access_token: 'xoxp-erin',
          scope: 'im:write,mpim:write,channels:manage,channels:write.invites,groups:write,groups:write.invites',
        },
      };
      const res = await request(grantApp).get(`/auth/grant/callback?code=abc&state=${state}`).set('Cookie', cookies);
      expect(res.status).toBe(302);
      expect(res.headers.location).toBe('/chart?user=UCTO&grant=ok');
      const row = await withTenant('T1', (tx) => tx.userGrant.findFirstOrThrow(), db);
      expect(row.token).not.toContain('xoxp');
      expect(decrypt(row.token, key)).toBe('xoxp-erin');
    });

    it('refuses a token for someone else and gives it back to Slack', async () => {
      const { cookies, state } = await start(erin);
      oauthAnswer = { ok: true, team: { id: 'T1' }, authed_user: { id: 'UCTO', access_token: 'xoxp-theo', scope: 'im:write' } };
      const res = await request(grantApp).get(`/auth/grant/callback?code=abc&state=${state}`).set('Cookie', cookies);
      expect(res.status).toBe(400);
      expect(revoked).toContain('xoxp-theo');
      expect(await withTenant('T1', (tx) => tx.userGrant.count(), db)).toBe(0);
    });

    it('rejects a forged state and handles Cancel', async () => {
      const { cookies, state } = await start(erin);
      await request(grantApp).get('/auth/grant/callback?code=abc&state=forged').set('Cookie', cookies).expect(400);
      const again = await start(erin);
      const res = await request(grantApp).get(`/auth/grant/callback?error=access_denied&state=${again.state}`).set('Cookie', again.cookies);
      expect(res.headers.location).toBe('/chart?user=UCTO&grant=cancelled');
      expect(state).not.toBe(again.state);
    });

    it('lets only org chart admins connect the profile link writer', async () => {
      await request(grantApp).get('/auth/grant?kind=profile').set('Cookie', erin).expect(403);
      const admin = await cookieFor('T1', 'UADMIN');
      const { cookies, state } = await start(admin, 'profile');
      oauthAnswer = { ok: true, team: { id: 'T1' }, authed_user: { id: 'UADMIN', access_token: 'xoxp-ada', scope: 'users.profile:write' } };
      await request(grantApp).get(`/auth/grant/callback?code=abc&state=${state}`).set('Cookie', cookies).expect(302);
      const ws = await withTenant('T1', (tx) => tx.workspace.findUniqueOrThrow({ where: { teamId: 'T1' } }), db);
      expect(ws.profileWriterId).toBe('UADMIN');
      expect(decrypt(ws.profileWriterToken!, key)).toBe('xoxp-ada');
    });
  });

  describe('profile link field', () => {
    const written: { user: string; profile: any }[] = [];
    let fail: Record<string, string> = {};
    let failAll: string | null = null;
    const writer = () => ({
      users: {
        profile: {
          set: async (args: { user: string; profile: any }) => {
            const code = failAll ?? fail[args.user];
            if (code) throw slackErr(code);
            written.push(args);
            return { ok: true };
          },
        },
      },
    });
    const fill = () => fillProfileLinks('T1', { baseUrl, encryptionKey: key, db, writer });
    const setUp = () =>
      withTenant(
        'T1',
        (tx) =>
          tx.workspace.update({
            where: { teamId: 'T1' },
            data: { profileLinkFieldId: 'XfLINK', profileWriterId: 'UADMIN', profileWriterToken: encrypt('xoxp-ada', key) },
          }),
        db,
      );

    beforeEach(() => {
      written.length = 0;
      fail = {};
      failAll = null;
    });

    it('does nothing until a field and a writer are set', async () => {
      expect(await fill()).toBeNull();
    });

    it('writes each internal person’s chart link once', async () => {
      await setUp();
      const counts = await fill();
      // Ada, Carla, Theo, Erin, Pia and Gwen; not Pat (Slack Connect), Olaf
      // (deactivated) or the bot.
      expect(counts).toEqual({ written: 6, unchanged: 0, failed: 0 });
      expect(written.find((w) => w.user === 'UENG')?.profile).toEqual({
        fields: { XfLINK: { value: `${baseUrl}/chart?team=T1&user=UENG`, alt: 'Org chart' } },
      });
      expect(written.map((w) => w.user)).not.toContain('UPAT');
      expect(await fill()).toEqual({ written: 0, unchanged: 6, failed: 0 });
    });

    it('keeps going past one person Slack refuses', async () => {
      await setUp();
      fail = { UCEO: 'cannot_update_admin_user' };
      expect(await fill()).toEqual({ written: 5, unchanged: 0, failed: 1 });
      // The refused person is tried again next time.
      fail = {};
      expect(await fill()).toEqual({ written: 1, unchanged: 5, failed: 0 });
    });

    it('stops and disconnects when the token no longer works', async () => {
      await setUp();
      failAll = 'token_revoked';
      const counts = await fill();
      expect(counts?.failed).toBe(1);
      expect(written).toHaveLength(0);
      const ws = await withTenant('T1', (tx) => tx.workspace.findUniqueOrThrow({ where: { teamId: 'T1' } }), db);
      expect(ws.profileWriterToken).toBeNull();
    });
  });

  describe('App Home, /orgchart and the message shortcut', () => {
    const surfaces = slackSurfaces({ baseUrl, ensurePerson: async () => {}, db });

    it('shows App Home around the viewer', async () => {
      const view = JSON.stringify(await surfaces.home('T1', 'UENG'));
      expect(view).toContain('"type":"home"');
      expect(view).toContain('Reports to (2)');
      expect(view).toContain('Theo');
    });

    it('turns guests away unless an admin allows them', async () => {
      expect(JSON.stringify(await surfaces.home('T1', 'UGUEST'))).toContain('only available to employees');
      expect((await surfaces.command('T1', 'UGUEST', '')).text).toContain('only available to employees');
    });

    it('answers /orgchart for a mention, a name, several names and nobody', async () => {
      expect((await surfaces.command('T1', 'UENG', '')).text).toBe('Erin in the org chart');
      expect((await surfaces.command('T1', 'UENG', '<@UCTO|theo>')).text).toBe('Theo in the org chart');
      expect((await surfaces.command('T1', 'UENG', 'carla')).text).toBe('Carla in the org chart');
      expect((await surfaces.command('T1', 'UENG', 'a')).text).toMatch(/^\d+ people match "a"$/);
      expect((await surfaces.command('T1', 'UENG', 'zed')).text).toContain('No one called "zed"');
      expect((await surfaces.command('T1', 'UENG', '<@UOLD>')).text).toContain('not on the org chart');
    });

    it('opens a modal on the message author', async () => {
      const view = await surfaces.authorModal('T1', 'UENG', 'UCTO');
      expect(view.type).toBe('modal');
      expect(JSON.stringify(view)).toContain('Theo');
      expect(JSON.stringify(await surfaces.authorModal('T1', 'UENG', undefined))).toContain('not on the org chart');
    });
  });
});
