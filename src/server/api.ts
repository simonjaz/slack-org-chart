import { Router } from 'express';
import type { PrismaClient } from '@prisma/client';
import { prisma as defaultPrisma } from './db.js';
import { requireViewer } from './auth.js';
import { getChart } from './chart/service.js';

export function apiRouter(db: PrismaClient = defaultPrisma): Router {
  const router = Router();
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

  return router;
}
