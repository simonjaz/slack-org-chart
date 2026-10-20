import PgBoss from 'pg-boss';
import type { InstallationStore } from '@slack/bolt';
import type { PrismaClient } from '@prisma/client';
import { prisma as defaultPrisma, withSystem, withTenant } from './db.js';
import { botClientFor } from './slack/clients.js';
import { fullSync, syncOneUser } from './slack/sync.js';
import { fillProfileLinks } from './slack/profileLinks.js';

export const QUEUES = {
  syncWorkspace: 'sync-workspace',
  syncUser: 'sync-user',
  nightly: 'nightly-sync',
  purge: 'purge-uninstalled',
  profileLinks: 'profile-links',
} as const;

// How many workspaces sync at once. Each workspace has at most one sync
// queued and one running (stately policy keyed by team), so a 10,000 person
// company never blocks a 50 person one behind several of its own runs.
const SYNC_WORKERS = 3;

export interface Jobs {
  boss: PgBoss;
  enqueueWorkspaceSync(tenant: string): Promise<void>;
  enqueueUserSync(tenant: string, userId: string): Promise<void>;
  enqueueProfileLinks(tenant: string): Promise<void>;
  stop(): Promise<void>;
}

export async function startJobs(opts: {
  databaseUrl: string;
  installationStore: InstallationStore;
  nightlyHourUtc: number;
  // For the profile link fill.
  baseUrl: string;
  encryptionKey: string;
  db?: PrismaClient;
  log?: (msg: string, extra?: unknown) => void;
}): Promise<Jobs> {
  const db = opts.db ?? defaultPrisma;
  const log = opts.log ?? console.log;
  const boss = new PgBoss({ connectionString: opts.databaseUrl, schema: 'pgboss' });
  boss.on('error', (err) => log('pg-boss error', err));
  await boss.start();

  await boss.createQueue(QUEUES.syncWorkspace, { name: QUEUES.syncWorkspace, policy: 'stately', retryLimit: 3, retryBackoff: true });
  await boss.createQueue(QUEUES.syncUser, { name: QUEUES.syncUser, policy: 'stately', retryLimit: 5, retryBackoff: true });
  await boss.createQueue(QUEUES.nightly, { name: QUEUES.nightly, policy: 'singleton' });
  await boss.createQueue(QUEUES.purge, { name: QUEUES.purge, policy: 'singleton' });
  await boss.createQueue(QUEUES.profileLinks, { name: QUEUES.profileLinks, policy: 'stately', retryLimit: 2, retryBackoff: true });

  const clientFor = (tenant: string) => botClientFor(opts.installationStore, tenant);

  for (let i = 0; i < SYNC_WORKERS; i++) {
    await boss.work<{ tenant: string }>(QUEUES.syncWorkspace, async ([job]) => {
      if (!job) return;
      await fullSync(job.data.tenant, await clientFor(job.data.tenant), { db, log });
      // New people get their profile link after each full sync. The job
      // does nothing when the workspace has not set the field up.
      await enqueueProfileLinks(job.data.tenant);
    });
  }

  await boss.work<{ tenant: string }>(QUEUES.profileLinks, async ([job]) => {
    if (!job) return;
    await fillProfileLinks(job.data.tenant, { baseUrl: opts.baseUrl, encryptionKey: opts.encryptionKey, db, log });
  });

  await boss.work<{ tenant: string; userId: string }>(QUEUES.syncUser, { batchSize: 1 }, async ([job]) => {
    if (!job) return;
    await syncOneUser(job.data.tenant, await clientFor(job.data.tenant), job.data.userId, { db });
  });

  await boss.work(QUEUES.nightly, async () => {
    const tenants = await withSystem(
      (tx) => tx.workspace.findMany({ where: { uninstalledAt: null }, select: { teamId: true } }),
      db,
    );
    for (const t of tenants) await enqueueWorkspaceSync(t.teamId);
    log('nightly sync queued', { workspaces: tenants.length });
  });

  await boss.work(QUEUES.purge, async () => {
    const due = await withSystem(
      (tx) => tx.workspace.findMany({ where: { deleteAfter: { lte: new Date() } }, select: { teamId: true } }),
      db,
    );
    for (const t of due) await purgeWorkspace(t.teamId, db);
    if (due.length) log('purged uninstalled workspaces', { count: due.length });
  });

  await boss.schedule(QUEUES.nightly, `0 ${opts.nightlyHourUtc} * * *`, {}, { tz: 'UTC' });
  await boss.schedule(QUEUES.purge, `30 ${opts.nightlyHourUtc} * * *`, {}, { tz: 'UTC' });

  async function enqueueWorkspaceSync(tenant: string) {
    await boss.send(QUEUES.syncWorkspace, { tenant }, { singletonKey: tenant });
  }

  async function enqueueProfileLinks(tenant: string) {
    await boss.send(QUEUES.profileLinks, { tenant }, { singletonKey: tenant });
  }

  return {
    boss,
    enqueueWorkspaceSync,
    enqueueProfileLinks,
    async enqueueUserSync(tenant, userId) {
      await boss.send(QUEUES.syncUser, { tenant, userId }, { singletonKey: `${tenant}:${userId}` });
    },
    stop: () => boss.stop({ graceful: true }),
  };
}

// Removes everything stored for a workspace.
export async function purgeWorkspace(tenant: string, db: PrismaClient = defaultPrisma) {
  await withTenant(
    tenant,
    async (tx) => {
      await tx.personOverride.deleteMany({ where: { teamId: tenant } });
      await tx.person.deleteMany({ where: { teamId: tenant } });
      await tx.userSession.deleteMany({ where: { teamId: tenant } });
      await tx.userGrant.deleteMany({ where: { teamId: tenant } });
      await tx.profileLink.deleteMany({ where: { teamId: tenant } });
      await tx.adminRole.deleteMany({ where: { teamId: tenant } });
      await tx.auditLog.deleteMany({ where: { teamId: tenant } });
      await tx.syncRun.deleteMany({ where: { teamId: tenant } });
      await tx.workspace.deleteMany({ where: { teamId: tenant } });
    },
    db,
  );
}
