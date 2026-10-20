import { Router, type NextFunction, type Request, type Response } from 'express';
import type { PrismaClient } from '@prisma/client';
import { z } from 'zod';
import { ASSIGNABLE_TYPES } from '../../shared/admin.js';
import { prisma as defaultPrisma, withTenant, type Tx } from '../db.js';
import { requireAdmin } from './access.js';
import {
  AdminError,
  addAdmin,
  disconnectProfileWriter,
  getProfileLink,
  getSettings,
  importCsv,
  listAdmins,
  listAudit,
  listPeople,
  listSyncRuns,
  removeAdmin,
  setProfileLinkField,
  updatePerson,
  updateSettings,
  type LinkField,
} from './service.js';

const slackId = z.string().regex(/^[UW][A-Z0-9]{2,}$/, 'Not a Slack user id');

const personPatch = z
  .object({
    managerSlackId: z.union([slackId, z.literal(''), z.null()]),
    userType: z.enum(ASSIGNABLE_TYPES).nullable(),
    externalOrg: z.string().max(200).nullable(),
    title: z.string().max(200).nullable(),
    department: z.string().max(200).nullable(),
    hidden: z.boolean().nullable(),
    sortOrder: z.number().int().min(-10_000).max(10_000).nullable(),
  })
  .partial()
  .strict();

const settingsPatch = z
  .object({ allowGuestViewers: z.boolean(), autoAdminSlackAdmins: z.boolean() })
  .partial()
  .strict();

const importBody = z.object({ csv: z.string().max(2_000_000), apply: z.boolean().default(false) }).strict();

export interface AdminApiDeps {
  db?: PrismaClient;
  // Queues a full sync of one workspace. Absent in tests.
  enqueueWorkspaceSync?: (tenant: string) => Promise<void>;
  // Link-type custom profile fields, read from Slack with the bot token.
  listLinkFields?: (tenant: string) => Promise<LinkField[]>;
  // Queues a profile link fill. Absent in tests.
  enqueueProfileLinks?: (tenant: string) => Promise<void>;
  // Gives an encrypted token back to Slack (best effort).
  revokeToken?: (sealed: string) => Promise<void>;
}

// Everything under /api/admin. Mounted after requireViewer, so req.viewer is
// set; requireAdmin then checks the admin role on every request.
export function adminRouter(deps: AdminApiDeps = {}): Router {
  const db = deps.db ?? defaultPrisma;
  const router = Router();
  router.use(requireAdmin(db));
  router.use((_req, res, next) => {
    res.set('Cache-Control', 'private, no-store');
    next();
  });

  // Runs fn in the viewer's workspace and answers with its result as JSON.
  const handle =
    (fn: (tx: Tx, tenant: string, actor: string, req: Request) => Promise<unknown>) =>
    async (req: Request, res: Response, next: NextFunction) => {
      try {
        const { tenant, slackUserId } = req.viewer!;
        res.json(await withTenant(tenant, (tx) => fn(tx, tenant, slackUserId, req), db));
      } catch (err) {
        next(err);
      }
    };

  router.get(
    '/people',
    handle(async (tx, tenant) => ({ people: await listPeople(tx, tenant) })),
  );

  router.patch(
    '/people/:id',
    handle(async (tx, tenant, actor, req) => {
      const id = slackId.parse(req.params.id);
      await updatePerson(tx, tenant, actor, id, personPatch.parse(req.body));
      return { ok: true };
    }),
  );

  router.post(
    '/import',
    handle(async (tx, tenant, actor, req) => {
      const body = importBody.parse(req.body);
      return importCsv(tx, tenant, actor, body.csv, body.apply);
    }),
  );

  router.get(
    '/admins',
    handle(async (tx) => ({ admins: await listAdmins(tx) })),
  );

  router.post(
    '/admins',
    handle(async (tx, tenant, actor, req) => {
      const { slackUserId } = z.object({ slackUserId: slackId }).strict().parse(req.body);
      await addAdmin(tx, tenant, actor, slackUserId);
      return { admins: await listAdmins(tx) };
    }),
  );

  router.delete(
    '/admins/:id',
    handle(async (tx, tenant, actor, req) => {
      await removeAdmin(tx, tenant, actor, slackId.parse(req.params.id));
      return { admins: await listAdmins(tx) };
    }),
  );

  router.get(
    '/settings',
    handle((tx, tenant) => getSettings(tx, tenant)),
  );

  router.patch(
    '/settings',
    handle((tx, tenant, actor, req) => updateSettings(tx, tenant, actor, settingsPatch.parse(req.body))),
  );

  const linkFields = async (tenant: string) => (deps.listLinkFields ? deps.listLinkFields(tenant).catch(() => []) : []);

  router.get('/profile-link', async (req, res, next) => {
    try {
      const { tenant } = req.viewer!;
      const fields = await linkFields(tenant);
      res.json(await withTenant(tenant, (tx) => getProfileLink(tx, tenant, fields, Boolean(deps.enqueueProfileLinks)), db));
    } catch (err) {
      next(err);
    }
  });

  router.patch('/profile-link', async (req, res, next) => {
    try {
      const { tenant, slackUserId } = req.viewer!;
      const { fieldId } = z.object({ fieldId: z.string().min(1).max(40).nullable() }).strict().parse(req.body);
      const fields = await linkFields(tenant);
      const result = await withTenant(
        tenant,
        async (tx) => {
          await setProfileLinkField(tx, tenant, slackUserId, fieldId, fields);
          return getProfileLink(tx, tenant, fields, Boolean(deps.enqueueProfileLinks));
        },
        db,
      );
      if (result.fieldId && result.writer) await deps.enqueueProfileLinks?.(tenant);
      res.json(result);
    } catch (err) {
      next(err);
    }
  });

  router.post('/profile-link/fill', async (req, res, next) => {
    try {
      if (!deps.enqueueProfileLinks) return res.status(503).json({ error: 'unavailable', message: 'Jobs are not running.' });
      await deps.enqueueProfileLinks(req.viewer!.tenant);
      res.status(202).json({ ok: true });
    } catch (err) {
      next(err);
    }
  });

  router.delete('/profile-link/writer', async (req, res, next) => {
    try {
      const { tenant, slackUserId } = req.viewer!;
      const sealed = await withTenant(tenant, (tx) => disconnectProfileWriter(tx, tenant, slackUserId), db);
      if (sealed) await deps.revokeToken?.(sealed).catch(() => {});
      const fields = await linkFields(tenant);
      res.json(await withTenant(tenant, (tx) => getProfileLink(tx, tenant, fields, Boolean(deps.enqueueProfileLinks)), db));
    } catch (err) {
      next(err);
    }
  });

  router.get(
    '/audit',
    handle(async (tx, _tenant, _actor, req) => {
      const before = typeof req.query.before === 'string' && /^\d+$/.test(req.query.before) ? BigInt(req.query.before) : null;
      const entries = await listAudit(tx, before);
      return { entries, next: entries.length === 50 ? entries[entries.length - 1]!.id : null };
    }),
  );

  router.get(
    '/sync',
    handle(async (tx) => ({ runs: await listSyncRuns(tx), canStart: Boolean(deps.enqueueWorkspaceSync) })),
  );

  router.post('/sync', async (req, res, next) => {
    try {
      if (!deps.enqueueWorkspaceSync) return res.status(503).json({ error: 'unavailable', message: 'Sync is not running.' });
      await deps.enqueueWorkspaceSync(req.viewer!.tenant);
      res.status(202).json({ ok: true });
    } catch (err) {
      next(err);
    }
  });

  // Validation and admin refusals become 400s the page can show.
  router.use((err: unknown, _req: Request, res: Response, next: NextFunction) => {
    if (err instanceof AdminError) return res.status(err.status).json({ error: err.code, message: err.message });
    if (err instanceof z.ZodError) {
      return res.status(400).json({ error: 'invalid', message: err.issues.map((i) => i.message).join('; ') });
    }
    next(err);
  });

  return router;
}
