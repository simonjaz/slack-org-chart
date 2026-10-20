import { Router, type Request } from 'express';
import { WebClient } from '@slack/web-api';
import type { PrismaClient } from '@prisma/client';
import { ACTION_USER_SCOPES, PROFILE_WRITER_SCOPES } from '../config.js';
import { decrypt, encrypt, randomToken } from '../crypto.js';
import { prisma as defaultPrisma, withTenant, type Tx } from '../db.js';
import { loadViewer, page, safeNext, type Viewer } from '../auth.js';
import { adminSource } from '../admin/access.js';

const STATE_COOKIE = 'oc_grant_state';

// What a person can grant the app beyond signing in:
//   actions: their own token, to start group DMs and create channels as them.
//   profile: an admin's token, to fill the profile link field for everyone.
export const GRANT_SCOPES = {
  actions: ACTION_USER_SCOPES,
  profile: PROFILE_WRITER_SCOPES,
} as const;
export type GrantKind = keyof typeof GRANT_SCOPES;

export interface GrantDeps {
  baseUrl: string;
  clientId: string;
  clientSecret: string;
  encryptionKey: string;
  secureCookies: boolean;
  // Queues a profile link fill once an admin connects the writer token.
  onProfileWriter?: (tenant: string) => Promise<void>;
  db?: PrismaClient;
  slack?: WebClient;
}

// Slack's oauth.v2.access answer for a user-scope-only grant.
interface UserGrantResponse {
  team?: { id?: string };
  enterprise?: { id?: string } | null;
  authed_user?: { id?: string; access_token?: string; scope?: string };
}

// A second OAuth step, separate from Sign in with Slack (whose OpenID scopes
// cannot be mixed with others). Asked for the first time someone needs it.
export function grantRouter(deps: GrantDeps): Router {
  const router = Router();
  const db = deps.db ?? defaultPrisma;
  const slack = deps.slack ?? new WebClient();
  const redirectUri = `${deps.baseUrl}/auth/grant/callback`;
  const cookieBase = { httpOnly: true, secure: deps.secureCookies, sameSite: 'lax' as const, path: '/' };

  // Signed in, and allowed to grant this kind. Otherwise a page to show.
  const check = async (req: Request, kind: GrantKind) => {
    const result = await loadViewer(req, db);
    if (!('viewer' in result)) return { error: result.denied ?? null };
    if (kind === 'profile') {
      const { tenant, slackUserId } = result.viewer;
      const admin = await withTenant(tenant, (tx) => adminSource(tx, tenant, slackUserId), db);
      if (!admin) return { error: 'Only org chart admins can connect the profile link field.' };
    }
    return { viewer: result.viewer };
  };

  router.get('/auth/grant', async (req, res, next) => {
    try {
      const kind = parseKind(req.query.kind);
      if (!kind) return res.status(400).send(page('Unknown request', 'Please go back and try again.'));
      const nextPath = safeNext(req.query.next);
      const checked = await check(req, kind);
      if (!checked.viewer) {
        if (checked.error) return res.status(403).send(page('No access', checked.error));
        return res.redirect(`/auth/login?next=${encodeURIComponent(req.originalUrl)}`);
      }
      const state = randomToken(16);
      res.cookie(STATE_COOKIE, JSON.stringify({ state, kind, next: nextPath }), { ...cookieBase, maxAge: 10 * 60_000 });
      const url = new URL('https://slack.com/oauth/v2/authorize');
      url.search = new URLSearchParams({
        client_id: deps.clientId,
        user_scope: GRANT_SCOPES[kind].join(','),
        redirect_uri: redirectUri,
        state,
        // Keeps people in several workspaces on the right one.
        ...(checked.viewer.tenant.startsWith('T') ? { team: checked.viewer.tenant } : {}),
      }).toString();
      res.redirect(url.toString());
    } catch (err) {
      next(err);
    }
  });

  router.get('/auth/grant/callback', async (req, res, next) => {
    try {
      const saved = parseJson<{ state: string; kind: GrantKind; next: string }>(req.cookies?.[STATE_COOKIE]);
      res.clearCookie(STATE_COOKIE, cookieBase);
      if (!saved || !parseKind(saved.kind) || req.query.state !== saved.state) {
        return res.status(400).send(page('Request expired', 'Please go back to the org chart and try again.'));
      }
      if (typeof req.query.code !== 'string') {
        // The person pressed Cancel on Slack's screen.
        return res.redirect(withParam(saved.next, 'grant', 'cancelled'));
      }
      const checked = await check(req, saved.kind);
      if (!checked.viewer) return res.status(403).send(page('No access', checked.error ?? 'Please sign in again.'));
      const viewer = checked.viewer;

      const answer = (await slack.oauth.v2.access({
        client_id: deps.clientId,
        client_secret: deps.clientSecret,
        code: req.query.code,
        redirect_uri: redirectUri,
      })) as UserGrantResponse;
      const granted = answer.authed_user;
      const teamId = answer.team?.id;
      // The token must belong to the signed-in person, in the same workspace.
      if (!granted?.access_token || !teamId || granted.id !== viewer.slackUserId || !sameTenant(viewer, answer)) {
        if (granted?.access_token) await slack.auth.revoke({ token: granted.access_token }).catch(() => {});
        return res
          .status(400)
          .send(page('Wrong Slack account', 'Slack answered for a different person or workspace. Please try again.'));
      }
      const scopes = (granted.scope ?? '').split(',').filter(Boolean);
      const missing = GRANT_SCOPES[saved.kind].filter((s) => !scopes.includes(s));
      if (missing.length) {
        return res.status(400).send(page('Not all permissions granted', `Slack did not grant ${missing.join(', ')}.`));
      }

      const sealed = encrypt(granted.access_token, deps.encryptionKey);
      await withTenant(
        viewer.tenant,
        (tx) => saveGrant(tx, saved.kind, viewer, { teamId, sealed, scopes: scopes.join(',') }),
        db,
      );
      if (saved.kind === 'profile') await deps.onProfileWriter?.(viewer.tenant);
      res.redirect(withParam(saved.next, 'grant', 'ok'));
    } catch (err) {
      next(err);
    }
  });

  return router;
}

async function saveGrant(
  tx: Tx,
  kind: GrantKind,
  viewer: Viewer,
  grant: { teamId: string; sealed: string; scopes: string },
) {
  const { tenant, slackUserId } = viewer;
  if (kind === 'actions') {
    const data = { slackTeamId: grant.teamId, token: grant.sealed, scopes: grant.scopes, grantedAt: new Date() };
    await tx.userGrant.upsert({
      where: { teamId_slackUserId: { teamId: tenant, slackUserId } },
      create: { teamId: tenant, slackUserId, ...data },
      update: data,
    });
    return;
  }
  await tx.workspace.update({
    where: { teamId: tenant },
    data: { profileWriterId: slackUserId, profileWriterToken: grant.sealed },
  });
  await tx.auditLog.create({
    data: { teamId: tenant, actor: slackUserId, action: 'profile_link.connect', after: { writer: slackUserId } },
  });
}

// The person's own token for group DMs and channels, or null.
export async function loadUserGrant(tx: Tx, tenant: string, slackUserId: string, encryptionKey: string) {
  const row = await tx.userGrant.findUnique({ where: { teamId_slackUserId: { teamId: tenant, slackUserId } } });
  if (!row) return null;
  return { token: decrypt(row.token, encryptionKey), slackTeamId: row.slackTeamId, scopes: row.scopes.split(',') };
}

// Deletes the person's token and tells Slack to forget it (best effort).
export async function revokeUserGrant(
  tenant: string,
  slackUserId: string,
  opts: { encryptionKey: string; db?: PrismaClient; slack?: WebClient },
) {
  const db = opts.db ?? defaultPrisma;
  const grant = await withTenant(
    tenant,
    async (tx) => {
      const found = await loadUserGrant(tx, tenant, slackUserId, opts.encryptionKey).catch(() => null);
      await tx.userGrant.deleteMany({ where: { teamId: tenant, slackUserId } });
      return found;
    },
    db,
  );
  if (grant) await (opts.slack ?? new WebClient()).auth.revoke({ token: grant.token }).catch(() => {});
}

// tokens_revoked lists the people whose user tokens Slack revoked.
export async function forgetRevokedUsers(tenant: string, userIds: string[], db: PrismaClient = defaultPrisma) {
  if (!userIds.length) return;
  await withTenant(
    tenant,
    async (tx) => {
      await tx.userGrant.deleteMany({ where: { teamId: tenant, slackUserId: { in: userIds } } });
      await tx.workspace.updateMany({
        where: { teamId: tenant, profileWriterId: { in: userIds } },
        data: { profileWriterId: null, profileWriterToken: null },
      });
    },
    db,
  );
}

function sameTenant(viewer: Viewer, answer: UserGrantResponse): boolean {
  if (viewer.tenant.startsWith('E')) return answer.enterprise?.id === viewer.tenant;
  return answer.team?.id === viewer.tenant;
}

function parseKind(value: unknown): GrantKind | null {
  return value === 'actions' || value === 'profile' ? value : null;
}

function withParam(path: string, key: string, value: string): string {
  const url = new URL(path, 'http://x');
  url.searchParams.set(key, value);
  return url.pathname + url.search + url.hash;
}

function parseJson<T>(value: unknown): T | null {
  if (typeof value !== 'string') return null;
  try {
    return JSON.parse(value) as T;
  } catch {
    return null;
  }
}
