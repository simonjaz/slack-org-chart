import express, { Router, type NextFunction, type Request, type Response } from 'express';
import { WebClient } from '@slack/web-api';
import type { PrismaClient } from '@prisma/client';
import { z } from 'zod';
import {
  MAX_CHANNEL_INVITES,
  MAX_GROUP_DM_OTHERS,
  channelName,
  inviteReason,
  type ActionsStatus,
  type ChannelResult,
  type ConversationResult,
} from '../shared/actions.js';
import { prisma as defaultPrisma, withTenant } from './db.js';
import { loadEffectivePeople } from './chart/service.js';
import { loadUserGrant } from './slack/grants.js';

// The Slack methods the actions call, made with the viewer's own token. A
// WebClient satisfies it; tests pass a fake.
type Call = (args?: any) => Promise<any>;
export interface ActionsClient {
  conversations: { open: Call; create: Call; invite: Call };
}

export interface ActionsDeps {
  encryptionKey: string;
  db?: PrismaClient;
  userClient?: (token: string) => ActionsClient;
}

export class ActionError extends Error {
  constructor(
    readonly status: number,
    readonly code: string,
    message: string,
  ) {
    super(message);
  }
}

const slackId = z.string().regex(/^[UW][A-Z0-9]{2,}$/, 'Not a Slack user id');
const people = z.array(slackId).min(1).max(MAX_CHANNEL_INVITES);
const conversationBody = z.object({ userIds: people }).strict();
const channelBody = z
  .object({ name: z.string().min(1).max(200), isPrivate: z.boolean().default(false), userIds: people })
  .strict();

// The token is gone or lacks a scope: the page asks the person to grant again.
const GRANT_ERRORS = new Set([
  'missing_scope',
  'invalid_auth',
  'not_authed',
  'token_revoked',
  'token_expired',
  'account_inactive',
]);

const NEEDS_GRANT = () =>
  new ActionError(401, 'needs_grant', 'Allow Org Chart to start conversations for you in Slack first.');

// /api/actions/*: group DMs and channels, run as the viewer. Mounted after
// requireViewer. A single DM needs none of this: the page opens it with a
// slack://user link.
export function actionsRouter(deps: ActionsDeps): Router {
  const db = deps.db ?? defaultPrisma;
  const userClient = deps.userClient ?? ((token: string) => new WebClient(token) as unknown as ActionsClient);
  const router = Router();
  router.use('/api/actions', express.json({ limit: '100kb' }));
  router.use('/api/actions', (_req, res, next) => {
    res.set('Cache-Control', 'private, no-store');
    next();
  });

  // The viewer's token, and the people they picked, checked against the chart.
  const prepare = async (req: Request, userIds: string[]) => {
    const { tenant, slackUserId } = req.viewer!;
    return withTenant(
      tenant,
      async (tx) => {
        const grant = await loadUserGrant(tx, tenant, slackUserId, deps.encryptionKey);
        if (!grant) throw NEEDS_GRANT();
        const visible = new Set(
          (await loadEffectivePeople(tx))
            .filter((p) => !p.isDeleted && !p.hidden && p.userType !== 'bot')
            .map((p) => p.slackUserId),
        );
        // The viewer is always in the conversation, so they are not invited.
        const others = [...new Set(userIds)].filter((id) => id !== slackUserId);
        const unknown = others.filter((id) => !visible.has(id));
        if (unknown.length)
          throw new ActionError(400, 'unknown_people', 'Some of the people you picked are not on the chart.');
        if (!others.length) throw new ActionError(400, 'no_people', 'Pick at least one person besides yourself.');
        return { grant, others, client: userClient(grant.token) };
      },
      db,
    );
  };

  // Drops a token Slack no longer accepts, then answers needs_grant.
  const slackFailure = async (req: Request, err: unknown, fallback: string): Promise<never> => {
    const code = slackError(err);
    if (code && GRANT_ERRORS.has(code)) {
      const { tenant, slackUserId } = req.viewer!;
      await withTenant(tenant, (tx) => tx.userGrant.deleteMany({ where: { teamId: tenant, slackUserId } }), db);
      throw NEEDS_GRANT();
    }
    throw new ActionError(502, code ?? 'slack_error', `${fallback}${code ? ` Slack said: ${code}.` : ''}`);
  };

  router.get('/api/actions/status', async (req, res, next) => {
    try {
      const { tenant, slackUserId } = req.viewer!;
      const row = await withTenant(
        tenant,
        (tx) => tx.userGrant.findUnique({ where: { teamId_slackUserId: { teamId: tenant, slackUserId } } }),
        db,
      );
      res.json({ granted: Boolean(row) } satisfies ActionsStatus);
    } catch (err) {
      next(err);
    }
  });

  // One person: a DM. Two to eight: a group DM. Opens the existing one if
  // these people already have one.
  router.post('/api/actions/conversation', async (req, res, next) => {
    try {
      const body = conversationBody.parse(req.body);
      const { grant, others, client } = await prepare(req, body.userIds);
      if (others.length > MAX_GROUP_DM_OTHERS) {
        throw new ActionError(
          400,
          'too_many',
          `A group DM holds up to ${MAX_GROUP_DM_OTHERS} people besides you. Create a channel instead.`,
        );
      }
      const opened = await client.conversations
        .open({ users: others.join(','), return_im: false })
        .catch((err: unknown) => slackFailure(req, err, 'Slack could not open the conversation.'));
      res.json({ channelId: opened.channel.id, teamId: grant.slackTeamId } satisfies ConversationResult);
    } catch (err) {
      next(err);
    }
  });

  // A new channel with everyone picked. People Slack refuses (often guests
  // and people from other companies) are listed so the page can name them.
  router.post('/api/actions/channel', async (req, res, next) => {
    try {
      const body = channelBody.parse(req.body);
      const name = channelName(body.name);
      if (!name)
        throw new ActionError(400, 'invalid_name', 'Use letters, numbers, hyphens or underscores in the name.');
      const { grant, others, client } = await prepare(req, body.userIds);

      const created = await client.conversations.create({ name, is_private: body.isPrivate }).catch((err: unknown) => {
        const code = slackError(err);
        if (code === 'name_taken') throw new ActionError(409, code, `#${name} already exists. Pick another name.`);
        if (code === 'restricted_action') {
          throw new ActionError(403, code, 'Your workspace only lets some people create channels.');
        }
        if (code?.startsWith('invalid_name'))
          throw new ActionError(400, code, 'Slack did not accept that channel name.');
        return slackFailure(req, err, 'Slack could not create the channel.');
      });
      const channelId: string = created.channel.id;

      const failed = new Map<string, string>();
      try {
        // force: invite everyone Slack accepts even if some are refused.
        const invited = await client.conversations.invite({ channel: channelId, users: others.join(','), force: true });
        for (const e of invited.errors ?? []) if (e.user) failed.set(e.user, e.error);
      } catch (err) {
        // Slack fails the whole call when nobody could be added.
        const data = (err as { data?: { errors?: { user?: string; error: string }[] } }).data;
        const code = slackError(err) ?? 'cant_invite';
        if (data?.errors?.length) {
          for (const e of data.errors) if (e.user) failed.set(e.user, e.error);
        } else {
          for (const id of others) failed.set(id, code);
        }
      }

      res.json({
        channelId,
        teamId: grant.slackTeamId,
        name: created.channel.name ?? name,
        invited: others.filter((id) => !failed.has(id)),
        notInvited: [...failed].map(([userId, code]) => ({ userId, reason: inviteReason(code) })),
      } satisfies ChannelResult);
    } catch (err) {
      next(err);
    }
  });

  router.use('/api/actions', (err: unknown, _req: Request, res: Response, next: NextFunction) => {
    if (err instanceof ActionError) return res.status(err.status).json({ error: err.code, message: err.message });
    if (err instanceof z.ZodError) {
      return res.status(400).json({ error: 'invalid', message: err.issues.map((i) => i.message).join('; ') });
    }
    next(err);
  });

  return router;
}

// The error code from a Slack Web API failure ("name_taken"), if any.
export function slackError(err: unknown): string | null {
  const code = (err as { data?: { error?: unknown } })?.data?.error;
  return typeof code === 'string' ? code : null;
}
