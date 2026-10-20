import express, { Router } from 'express';
import type { PrismaClient } from '@prisma/client';
import { prisma as defaultPrisma, withTenant } from './db.js';
import { requireViewer } from './auth.js';
import { getChart } from './chart/service.js';
import { adminSource } from './admin/access.js';
import { adminRouter } from './admin/api.js';

export interface ApiDeps {
  db?: PrismaClient;
  enqueueWorkspaceSync?: (tenant: string) => Promise<void>;
}

export function apiRouter(deps: ApiDeps = {}): Router {
  const db = deps.db ?? defaultPrisma;
  const router = Router();
  router.use('/api', express.json({ limit: '2mb' }));
  router.use('/api', requireViewer(db));

  // The whole chart for the viewer's workspace plus where to center it.
  // ?user=U123 centers on someone else (the profile link and /orgchart use it).
  router.get('/api/chart', async (req, res, next) => {
    try {
      const viewer = req.viewer!;
      const requested = typeof req.query.user === 'string' ? req.query.user : null;
      res.set('Cache-Control', 'private, no-store');
      res.json(await getChart(viewer.tenant, viewer.slackUserId, requested, db));
    } catch (err) {
      next(err);
    }
  });

  // Who is signed in, so the chart can show the Admin link.
  router.get('/api/me', async (req, res, next) => {
    try {
      const { tenant, slackUserId } = req.viewer!;
      const source = await withTenant(tenant, (tx) => adminSource(tx, tenant, slackUserId), db);
      res.set('Cache-Control', 'private, no-store');
      res.json({ slackUserId, teamId: tenant, isAdmin: Boolean(source) });
    } catch (err) {
      next(err);
    }
  });

  router.use('/api/admin', adminRouter({ db, enqueueWorkspaceSync: deps.enqueueWorkspaceSync }));

  return router;
}
