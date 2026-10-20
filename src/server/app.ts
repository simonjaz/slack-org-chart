import path from 'node:path';
import { fileURLToPath } from 'node:url';
import express from 'express';
import cookieParser from 'cookie-parser';
import { App, ExpressReceiver, LogLevel, type Context, type InstallationStore } from '@slack/bolt';
import type { PrismaClient } from '@prisma/client';
import { BOT_SCOPES, type Config } from './config.js';
import { prisma as defaultPrisma } from './db.js';
import { apiRouter } from './api.js';
import { authRouter, requireSameOrigin } from './auth.js';
import { markUninstalled, tenantKey } from './slack/installationStore.js';
import { forgetRevokedUsers, grantRouter, revokeUserGrant } from './slack/grants.js';
import { slackSurfaces } from './slack/surfaces.js';
import type { ActionsClient } from './actions.js';
import type { LinkField } from './admin/service.js';
import { decrypt } from './crypto.js';

export interface AppDeps {
  config: Config;
  installationStore: InstallationStore;
  enqueueUserSync: (tenant: string, userId: string) => Promise<void>;
  enqueueWorkspaceSync?: (tenant: string) => Promise<void>;
  enqueueProfileLinks?: (tenant: string) => Promise<void>;
  listLinkFields?: (tenant: string) => Promise<LinkField[]>;
  // Builds the client group DMs and channels are made with. Tests pass a fake.
  userClient?: (token: string) => ActionsClient;
  ensurePerson: (tenant: string, userId: string) => Promise<void>;
  db?: PrismaClient;
  webDistDir?: string;
}

export function createApp(deps: AppDeps) {
  const { config } = deps;
  const db = deps.db ?? defaultPrisma;

  const receiver = new ExpressReceiver({
    signingSecret: config.SLACK_SIGNING_SECRET,
    clientId: config.SLACK_CLIENT_ID,
    clientSecret: config.SLACK_CLIENT_SECRET,
    stateSecret: config.SLACK_STATE_SECRET,
    scopes: BOT_SCOPES,
    installationStore: deps.installationStore,
    installerOptions: {
      directInstall: true,
      installPath: '/slack/install',
      redirectUriPath: '/slack/oauth_redirect',
    },
    redirectUri: `${config.BASE_URL}/slack/oauth_redirect`,
    endpoints: '/slack/events',
  });

  const bolt = new App({
    receiver,
    logLevel: config.NODE_ENV === 'production' ? LogLevel.INFO : LogLevel.DEBUG,
  });

  const tenantOf = (ctx: Context) =>
    tenantKey({ teamId: ctx.teamId, enterpriseId: ctx.enterpriseId, isEnterpriseInstall: ctx.isEnterpriseInstall });
  const surfaces = slackSurfaces({ baseUrl: config.BASE_URL, ensurePerson: deps.ensurePerson, db });

  // App Home: the viewer's manager, peers and reports, and the full chart.
  bolt.event('app_home_opened', async ({ event, context, client }) => {
    if (event.tab !== 'home') return;
    const view = await surfaces.home(tenantOf(context), event.user);
    await client.views.publish({ user_id: event.user, view });
  });

  // /orgchart, /orgchart @name or /orgchart Jane: a private reply.
  bolt.command('/orgchart', async ({ command, ack, respond, context }) => {
    await ack();
    const reply = await surfaces.command(tenantOf(context), command.user_id, command.text);
    await respond({ response_type: 'ephemeral', ...reply });
  });

  // Message shortcut "View in org chart": the message's author.
  bolt.shortcut('view_in_org_chart', async ({ shortcut, ack, client, context }) => {
    await ack();
    if (shortcut.type !== 'message_action') return;
    const view = await surfaces.authorModal(tenantOf(context), shortcut.user.id, shortcut.message.user);
    await client.views.open({ trigger_id: shortcut.trigger_id, view });
  });

  // Link buttons still send an action, which Slack wants acknowledged.
  bolt.action('open_chart', async ({ ack }) => {
    await ack();
  });

  // Live updates: one person, within seconds.
  bolt.event('user_change', async ({ event, context }) => {
    await deps.enqueueUserSync(tenantOf(context), event.user.id);
  });
  bolt.event('team_join', async ({ event, context }) => {
    await deps.enqueueUserSync(tenantOf(context), event.user.id);
  });
  bolt.event('user_profile_changed', async ({ event, context }) => {
    await deps.enqueueUserSync(tenantOf(context), event.user.id);
  });

  // Uninstall stops the sync; the purge job deletes the data after 30 days.
  bolt.event('app_uninstalled', async ({ context }) => {
    await markUninstalled(tenantOf(context), db);
  });
  bolt.event('tokens_revoked', async ({ event, context }) => {
    if (event.tokens.bot?.length) await markUninstalled(tenantOf(context), db);
    // People who removed the app from their account, or were deactivated.
    if (event.tokens.oauth?.length) await forgetRevokedUsers(tenantOf(context), event.tokens.oauth, db);
  });

  const web = receiver.app;
  web.disable('x-powered-by');
  web.set('trust proxy', 1);
  web.use(cookieParser());
  // Slack's own POSTs to /slack/* carry no Origin and are checked by signature.
  web.use(['/api', '/auth'], requireSameOrigin(config.BASE_URL));
  web.get('/healthz', (_req, res) => {
    res.json({ ok: true });
  });
  web.use(
    authRouter({
      baseUrl: config.BASE_URL,
      clientId: config.SLACK_CLIENT_ID,
      clientSecret: config.SLACK_CLIENT_SECRET,
      secureCookies: config.NODE_ENV === 'production',
      ensurePerson: deps.ensurePerson,
      onSignOut: (tenant, userId) => revokeUserGrant(tenant, userId, { encryptionKey: config.TOKEN_ENCRYPTION_KEY, db }),
      db,
    }),
  );
  web.use(
    grantRouter({
      baseUrl: config.BASE_URL,
      clientId: config.SLACK_CLIENT_ID,
      clientSecret: config.SLACK_CLIENT_SECRET,
      encryptionKey: config.TOKEN_ENCRYPTION_KEY,
      secureCookies: config.NODE_ENV === 'production',
      onProfileWriter: deps.enqueueProfileLinks,
      db,
    }),
  );
  web.use(
    apiRouter({
      db,
      enqueueWorkspaceSync: deps.enqueueWorkspaceSync,
      enqueueProfileLinks: deps.enqueueProfileLinks,
      listLinkFields: deps.listLinkFields,
      revokeToken: async (sealed) => {
        await bolt.client.auth.revoke({ token: decrypt(sealed, config.TOKEN_ENCRYPTION_KEY) });
      },
      actions: { encryptionKey: config.TOKEN_ENCRYPTION_KEY, userClient: deps.userClient },
    }),
  );

  const dist = deps.webDistDir ?? path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../web');
  web.use(express.static(dist, { index: false, maxAge: '1h' }));
  // The landing page, the chart and the admin page are one single page app.
  web.get(['/', '/chart', '/admin'], (_req, res) => {
    res.sendFile(path.join(dist, 'index.html'));
  });

  return { bolt, receiver, web };
}
