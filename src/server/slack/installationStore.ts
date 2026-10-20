import type { Installation, InstallationQuery, InstallationStore } from '@slack/bolt';
import type { PrismaClient } from '@prisma/client';
import { decrypt, encrypt } from '../crypto.js';
import { prisma as defaultPrisma, withTenant } from '../db.js';

// The workspace key every table is partitioned by. An Enterprise Grid
// org-wide install covers many workspaces and is keyed by the enterprise id.
export function tenantKey(q: {
  teamId?: string | null;
  enterpriseId?: string | null;
  isEnterpriseInstall?: boolean;
}): string {
  const key = q.isEnterpriseInstall ? q.enterpriseId : q.teamId;
  if (!key) throw new Error('Cannot tell which workspace this request is for');
  return key;
}

export function createInstallationStore(opts: {
  encryptionKey: string;
  onInstalled?: (tenant: string, installation: Installation) => Promise<void>;
  db?: PrismaClient;
}): InstallationStore {
  const db = opts.db ?? defaultPrisma;
  return {
    async storeInstallation(installation) {
      const tenant = tenantKey({
        teamId: installation.team?.id,
        enterpriseId: installation.enterprise?.id,
        isEnterpriseInstall: installation.isEnterpriseInstall,
      });
      const sealed = encrypt(JSON.stringify(installation), opts.encryptionKey);
      await withTenant(
        tenant,
        async (tx) => {
          const data = {
            enterpriseId: installation.enterprise?.id ?? null,
            isEnterpriseInstall: Boolean(installation.isEnterpriseInstall),
            name: installation.team?.name ?? installation.enterprise?.name ?? null,
            installation: sealed,
            installedBy: installation.user.id,
            uninstalledAt: null,
            deleteAfter: null,
          };
          await tx.workspace.upsert({
            where: { teamId: tenant },
            create: { teamId: tenant, ...data },
            update: data,
          });
          // The installer becomes the workspace's first admin.
          const admins = await tx.adminRole.count({ where: { teamId: tenant } });
          if (admins === 0) {
            await tx.adminRole.create({
              data: { teamId: tenant, slackUserId: installation.user.id, grantedBy: 'install' },
            });
          }
        },
        db,
      );
      await opts.onInstalled?.(tenant, installation);
    },

    async fetchInstallation(query: InstallationQuery<boolean>) {
      const tenant = tenantKey(query);
      const row = await withTenant(tenant, (tx) => tx.workspace.findUnique({ where: { teamId: tenant } }), db);
      if (!row || row.uninstalledAt) throw new Error(`No installation for ${tenant}`);
      return JSON.parse(decrypt(row.installation, opts.encryptionKey)) as Installation;
    },

    async deleteInstallation(query: InstallationQuery<boolean>) {
      await markUninstalled(tenantKey(query), db);
    },
  };
}

// Data is deleted 30 days after uninstall, as the Slack Marketplace requires.
export const RETENTION_DAYS = 30;

export async function markUninstalled(tenant: string, db: PrismaClient = defaultPrisma) {
  const now = new Date();
  await withTenant(
    tenant,
    (tx) =>
      tx.workspace.updateMany({
        where: { teamId: tenant },
        data: { uninstalledAt: now, deleteAfter: new Date(now.getTime() + RETENTION_DAYS * 86_400_000) },
      }),
    db,
  );
}
