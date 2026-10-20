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

export interface AppDeps {
  config: Config;
  installationStore: InstallationStore;
  enqueueUserSync: (tenant: string, userId: string) => Promise<void>;
  enqueueWorkspaceSync?: (tenant: string) => Promise<void>;
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
      db,
    }),
  );
  web.use(apiRouter({ db, enqueueWorkspaceSync: deps.enqueueWorkspaceSync }));

  const dist = deps.webDistDir ?? path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../web');
  web.use(express.static(dist, { index: false, maxAge: '1h' }));
  // The landing page, the chart and the admin page are one single page app.
  web.get(['/', '/chart', '/admin'], (_req, res) => {
    res.sendFile(path.join(dist, 'index.html'));
  });

  return { bolt, receiver, web };
}
