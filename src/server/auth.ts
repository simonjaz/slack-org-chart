import { Router, type NextFunction, type Request, type Response } from 'express';
import { WebClient } from '@slack/web-api';
import type { PrismaClient } from '@prisma/client';
import { randomToken, sha256 } from './crypto.js';
import { prisma as defaultPrisma, withSystem, withTenant } from './db.js';
import { isExternal } from './slack/classify.js';
import { SIGN_IN_SCOPES } from './config.js';

export const SESSION_COOKIE = 'oc_session';
const STATE_COOKIE = 'oc_oauth_state';
export const SESSION_HOURS = 8;

export interface Viewer {
  tenant: string;
  slackUserId: string;
}

declare global {
  // eslint-disable-next-line @typescript-eslint/no-namespace
  namespace Express {
    interface Request {
      viewer?: Viewer;
    }
  }
}

export interface AuthDeps {
  baseUrl: string;
  clientId: string;
  clientSecret: string;
  secureCookies: boolean;
  // Makes sure the person exists before their first chart load (a brand new
  // member may sign in before the next sync sees them).
  ensurePerson: (tenant: string, slackUserId: string) => Promise<void>;
  // Called after a sign-out, to revoke the person's user token.
  onSignOut?: (tenant: string, slackUserId: string) => Promise<void>;
  db?: PrismaClient;
  slack?: WebClient;
}

// Sign in with Slack (OpenID Connect). The session cookie is
// "<tenant>.<random>"; only a hash of the random part is stored.
export function authRouter(deps: AuthDeps): Router {
  const router = Router();
  const db = deps.db ?? defaultPrisma;
  const slack = deps.slack ?? new WebClient();
  const redirectUri = `${deps.baseUrl}/auth/callback`;
  const cookieBase = { httpOnly: true, secure: deps.secureCookies, sameSite: 'lax' as const, path: '/' };

  router.get('/auth/login', (req, res) => {
    const state = randomToken(16);
    const nonce = randomToken(16);
    const next = safeNext(req.query.next);
    res.cookie(STATE_COOKIE, JSON.stringify({ state, nonce, next }), { ...cookieBase, maxAge: 10 * 60_000 });
    const url = new URL('https://slack.com/openid/connect/authorize');
    url.search = new URLSearchParams({
      response_type: 'code',
      scope: SIGN_IN_SCOPES.join(' '),
      client_id: deps.clientId,
      redirect_uri: redirectUri,
      state,
      nonce,
      ...(typeof req.query.team === 'string' ? { team: req.query.team } : {}),
    }).toString();
    res.redirect(url.toString());
  });

  router.get('/auth/callback', async (req, res, next) => {
    try {
      const saved = parseJson<{ state: string; nonce: string; next: string }>(req.cookies?.[STATE_COOKIE]);
      res.clearCookie(STATE_COOKIE, cookieBase);
      if (!saved || typeof req.query.code !== 'string' || req.query.state !== saved.state) {
        return res.status(400).send(page('Sign-in expired', 'Please go back to Slack and open the org chart again.'));
      }
      const token = await slack.openid.connect.token({
        client_id: deps.clientId,
        client_secret: deps.clientSecret,
        code: req.query.code,
        redirect_uri: redirectUri,
      });
      const claims = decodeJwtPayload(token.id_token);
      if (!claims || claims.nonce !== saved.nonce) {
        return res.status(400).send(page('Sign-in failed', 'Slack returned an unexpected answer. Please try again.'));
      }
      const slackUserId = claims['https://slack.com/user_id'] as string;
      const teamId = claims['https://slack.com/team_id'] as string;
      const enterpriseId = claims['https://slack.com/enterprise_id'] as string | undefined;

      const tenant = await findTenant(teamId, enterpriseId, db);
      if (!tenant) {
        return res
          .status(403)
          .send(page('Org Chart is not installed', 'Ask a Slack admin to add Org Chart to your workspace first.'));
      }
      await deps.ensurePerson(tenant, slackUserId);
      const denied = await accessDenied(tenant, slackUserId, db);
      if (denied) return res.status(403).send(page('No access', denied));

      const secret = randomToken();
      await withTenant(
        tenant,
        (tx) =>
          tx.userSession.create({
            data: {
              id: sha256(secret),
              teamId: tenant,
              slackUserId,
              expiresAt: new Date(Date.now() + SESSION_HOURS * 3_600_000),
            },
          }),
        db,
      );
      res.cookie(SESSION_COOKIE, `${tenant}.${secret}`, { ...cookieBase, maxAge: SESSION_HOURS * 3_600_000 });
      res.redirect(saved.next);
    } catch (err) {
      next(err);
    }
  });

  router.post('/auth/logout', requireSameOrigin(deps.baseUrl), async (req, res) => {
    const parsed = parseSessionCookie(req.cookies?.[SESSION_COOKIE]);
    if (parsed) {
      const session = await withTenant(
        parsed.tenant,
        async (tx) => {
          const row = await tx.userSession.findUnique({ where: { id: sha256(parsed.secret) } });
          await tx.userSession.deleteMany({ where: { id: sha256(parsed.secret) } });
          return row;
        },
        db,
      );
      // Signing out also gives back the token used for group DMs and channels.
      if (session) await deps.onSignOut?.(parsed.tenant, session.slackUserId);
    }
    res.clearCookie(SESSION_COOKIE, cookieBase);
    res.status(204).end();
  });

  return router;
}

// Attaches req.viewer, or answers 401 so the page can send the person to sign in.
export function requireViewer(db: PrismaClient = defaultPrisma) {
  return async (req: Request, res: Response, next: NextFunction) => {
    try {
      const result = await loadViewer(req, db);
      if ('viewer' in result) {
        req.viewer = result.viewer;
        return next();
      }
      if (result.denied) return res.status(403).json({ error: 'forbidden', message: result.denied });
      res.status(401).json({ error: 'signed_out' });
    } catch (err) {
      next(err);
    }
  };
}

// Reads the session cookie. Checked on every request so a guest flag or
// deactivation applies at once.
export async function loadViewer(
  req: Request,
  db: PrismaClient = defaultPrisma,
): Promise<{ viewer: Viewer } | { denied: string | null }> {
  const parsed = parseSessionCookie(req.cookies?.[SESSION_COOKIE]);
  if (!parsed) return { denied: null };
  const session = await withTenant(
    parsed.tenant,
    (tx) => tx.userSession.findUnique({ where: { id: sha256(parsed.secret) } }),
    db,
  );
  if (!session || session.expiresAt < new Date()) return { denied: null };
  const denied = await accessDenied(parsed.tenant, session.slackUserId, db);
  if (denied) return { denied };
  return { viewer: { tenant: parsed.tenant, slackUserId: session.slackUserId } };
}

// Blocks cross-site writes. Browsers always send Origin on POST.
export function requireSameOrigin(baseUrl: string) {
  const origin = new URL(baseUrl).origin;
  return (req: Request, res: Response, next: NextFunction) => {
    if (req.method === 'GET' || req.method === 'HEAD') return next();
    if (req.get('origin') !== origin) return res.status(403).json({ error: 'bad_origin' });
    next();
  };
}

// Returns a reason the person may not view the chart, or null.
export async function accessDenied(tenant: string, slackUserId: string, db: PrismaClient = defaultPrisma) {
  return withTenant(
    tenant,
    async (tx) => {
      const [workspace, person] = await Promise.all([
        tx.workspace.findUnique({ where: { teamId: tenant } }),
        tx.person.findUnique({ where: { teamId_slackUserId: { teamId: tenant, slackUserId } }, include: { override: true } }),
      ]);
      if (!workspace || workspace.uninstalledAt) return 'Org Chart is no longer installed in this workspace.';
      if (!person || person.isDeleted) return 'Your Slack account is not part of this workspace.';
      const type = person.override?.userType ?? person.userType;
      if (isExternal(type) && !workspace.allowGuestViewers) {
        return 'The org chart is only available to employees of this company.';
      }
      return null;
    },
    db,
  );
}

async function findTenant(teamId: string, enterpriseId: string | undefined, db: PrismaClient) {
  const row = await withSystem(
    (tx) =>
      tx.workspace.findFirst({
        where: {
          uninstalledAt: null,
          OR: [{ teamId }, ...(enterpriseId ? [{ enterpriseId, isEnterpriseInstall: true }] : [])],
        },
        orderBy: { isEnterpriseInstall: 'asc' },
        select: { teamId: true },
      }),
    db,
  );
  return row?.teamId ?? null;
}

export function parseSessionCookie(value: unknown): { tenant: string; secret: string } | null {
  if (typeof value !== 'string') return null;
  const dot = value.indexOf('.');
  if (dot <= 0) return null;
  const tenant = value.slice(0, dot);
  const secret = value.slice(dot + 1);
  return /^[TE][A-Z0-9]+$/.test(tenant) && secret.length >= 32 ? { tenant, secret } : null;
}

// Only same-site paths, so the login link cannot bounce people elsewhere.
export function safeNext(value: unknown): string {
  if (typeof value !== 'string' || !value.startsWith('/') || value.startsWith('//') || value.includes('\\')) {
    return '/chart';
  }
  return value;
}

// The id_token comes straight from Slack over TLS in the code exchange, so
// its claims can be read without checking the signature (OIDC Core 3.1.3.7).
function decodeJwtPayload(jwt: string | undefined): Record<string, unknown> | null {
  const part = jwt?.split('.')[1];
  if (!part) return null;
  return parseJson(Buffer.from(part, 'base64url').toString('utf8'));
}

function parseJson<T>(value: unknown): T | null {
  if (typeof value !== 'string') return null;
  try {
    return JSON.parse(value) as T;
  } catch {
    return null;
  }
}

export function page(title: string, body: string): string {
  const esc = (s: string) => s.replace(/[&<>"]/g, (c) => `&#${c.charCodeAt(0)};`);
  return `<!doctype html><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>${esc(title)}</title><body style="font-family:system-ui;max-width:32rem;margin:4rem auto;padding:0 1rem"><h1>${esc(title)}</h1><p>${esc(body)}</p></body>`;
}
