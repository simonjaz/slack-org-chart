import { loadConfig } from './config.js';
import { prisma, withTenant } from './db.js';
import { createApp } from './app.js';
import { startJobs } from './jobs.js';
import { botClientFor } from './slack/clients.js';
import { createInstallationStore } from './slack/installationStore.js';
import { syncOneUser } from './slack/sync.js';

const config = loadConfig();
const log = (msg: string, extra?: unknown) => console.log(JSON.stringify({ msg, ...(extra as object) }));

let jobs: Awaited<ReturnType<typeof startJobs>> | undefined;

const installationStore = createInstallationStore({
  encryptionKey: config.TOKEN_ENCRYPTION_KEY,
  // First full sync right after someone adds the app.
  onInstalled: async (tenant) => {
    await jobs?.enqueueWorkspaceSync(tenant);
  },
});

jobs = await startJobs({
  databaseUrl: config.DATABASE_URL,
  installationStore,
  nightlyHourUtc: config.NIGHTLY_SYNC_HOUR_UTC,
  log,
});

const { web } = createApp({
  config,
  installationStore,
  enqueueUserSync: (tenant, userId) => jobs!.enqueueUserSync(tenant, userId),
  enqueueWorkspaceSync: (tenant) => jobs!.enqueueWorkspaceSync(tenant),
  // A member who joined since the last sync gets synced before their first
  // chart load instead of being turned away.
  ensurePerson: async (tenant, userId) => {
    const exists = await withTenant(tenant, (tx) =>
      tx.person.findUnique({ where: { teamId_slackUserId: { teamId: tenant, slackUserId: userId } } }),
    );
    if (!exists) await syncOneUser(tenant, await botClientFor(installationStore, tenant), userId);
  },
});

const server = web.listen(config.PORT, () => log('listening', { port: config.PORT }));

for (const signal of ['SIGTERM', 'SIGINT'] as const) {
  process.on(signal, async () => {
    server.close();
    await jobs?.stop();
    await prisma.$disconnect();
    process.exit(0);
  });
}
