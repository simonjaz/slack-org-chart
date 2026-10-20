import type { NextFunction, Request, Response } from 'express';
import type { PrismaClient } from '@prisma/client';
import { prisma as defaultPrisma, withTenant, type Tx } from '../db.js';
import { isExternal } from '../slack/classify.js';

export type AdminSource = 'role' | 'slack_admin';

// Who may use the admin page, checked on every request so a removed role or
// a deactivation applies at once:
//   - an active member of the workspace,
//   - who is internal both in Slack and after admin overrides (guests and
//     Slack Connect people can never be admins, and marking someone a
//     contractor or external takes their admin rights away), and
//   - who has an admin_role row, or is a Slack owner or admin while the
//     workspace's automatic setting is on.
export async function adminSource(tx: Tx, tenant: string, slackUserId: string): Promise<AdminSource | null> {
  const [workspace, person, role] = await Promise.all([
    tx.workspace.findUnique({ where: { teamId: tenant }, select: { uninstalledAt: true, autoAdminSlackAdmins: true } }),
    tx.person.findUnique({ where: { teamId_slackUserId: { teamId: tenant, slackUserId } }, include: { override: true } }),
    tx.adminRole.findUnique({ where: { teamId_slackUserId: { teamId: tenant, slackUserId } } }),
  ]);
  if (!workspace || workspace.uninstalledAt || !person || person.isDeleted) return null;
  if (!canBeAdmin(person)) return null;
  if (role) return 'role';
  if (workspace.autoAdminSlackAdmins && person.isSlackAdmin) return 'slack_admin';
  return null;
}

export function canBeAdmin(person: {
  userType: Parameters<typeof isExternal>[0];
  isDeleted: boolean;
  override?: { userType: Parameters<typeof isExternal>[0] | null } | null;
}): boolean {
  if (person.isDeleted || person.userType === 'bot') return false;
  if (isExternal(person.userType)) return false;
  const effective = person.override?.userType ?? person.userType;
  return !isExternal(effective) && effective !== 'bot';
}

// Runs after requireViewer. Answers 403 for anyone who is not an admin.
export function requireAdmin(db: PrismaClient = defaultPrisma) {
  return async (req: Request, res: Response, next: NextFunction) => {
    try {
      const viewer = req.viewer!;
      const source = await withTenant(viewer.tenant, (tx) => adminSource(tx, viewer.tenant, viewer.slackUserId), db);
      if (!source) {
        return res.status(403).json({ error: 'not_admin', message: 'Only org chart admins can open this page.' });
      }
      next();
    } catch (err) {
      next(err);
    }
  };
}
