import { WebClient } from '@slack/web-api';
import type { Prisma, PrismaClient } from '@prisma/client';
import { decrypt } from '../crypto.js';
import { prisma as defaultPrisma, withTenant } from '../db.js';
import { loadEffectivePeople } from '../chart/service.js';
import { chartUrl } from './surfaces.js';

// Slack has no button for apps on the profile card. Instead an admin adds a
// custom profile field of type link ("Org chart"), and the app writes each
// person's chart link into it. Writing someone else's profile needs an
// admin's user token (users.profile:write) on a paid plan.

type Call = (args?: any) => Promise<any>;
export interface ProfileWriter {
  users: { profile: { set: Call } };
}

export interface ProfileLinkCounts {
  written: number;
  unchanged: number;
  failed: number;
}

// Codes that mean the token itself is no good; the fill stops and the admin
// has to connect again.
const FATAL = new Set([
  'invalid_auth',
  'not_authed',
  'token_revoked',
  'account_inactive',
  'missing_scope',
  'not_admin',
  'paid_only',
]);

export async function fillProfileLinks(
  tenant: string,
  opts: {
    baseUrl: string;
    encryptionKey: string;
    db?: PrismaClient;
    writer?: (token: string) => ProfileWriter;
    log?: (msg: string, extra?: unknown) => void;
  },
): Promise<ProfileLinkCounts | null> {
  const db = opts.db ?? defaultPrisma;
  const log = opts.log ?? (() => {});
  const setup = await withTenant(
    tenant,
    async (tx) => {
      const ws = await tx.workspace.findUnique({ where: { teamId: tenant } });
      if (!ws || ws.uninstalledAt || !ws.profileLinkFieldId || !ws.profileWriterToken) return null;
      // Only the workspace's own people: Slack Connect profiles belong to
      // another company, and bots have none.
      const people = (await loadEffectivePeople(tx)).filter(
        (p) => !p.isDeleted && !p.hidden && p.userType !== 'bot' && p.userType !== 'slack_connect',
      );
      const written = await tx.profileLink.findMany({ where: { teamId: tenant } });
      return { fieldId: ws.profileLinkFieldId, token: ws.profileWriterToken, people, written };
    },
    db,
  );
  if (!setup) return null;

  const client = (opts.writer ?? ((t: string) => new WebClient(t, { retryConfig: { retries: 10 } })))(
    decrypt(setup.token, opts.encryptionKey),
  );
  const previous = new Map(setup.written.map((w) => [w.slackUserId, w]));
  const run = await withTenant(
    tenant,
    (tx) => tx.syncRun.create({ data: { teamId: tenant, kind: 'profile_links' } }),
    db,
  );
  const counts: ProfileLinkCounts = { written: 0, unchanged: 0, failed: 0 };
  const errors: string[] = [];

  for (const person of setup.people) {
    const value = chartUrl(opts.baseUrl, tenant, person.slackUserId);
    const before = previous.get(person.slackUserId);
    if (before && before.value === value && before.fieldId === setup.fieldId) {
      counts.unchanged++;
      continue;
    }
    try {
      await client.users.profile.set({
        user: person.slackUserId,
        profile: { fields: { [setup.fieldId]: { value, alt: 'Org chart' } } },
      });
      await withTenant(
        tenant,
        (tx) =>
          tx.profileLink.upsert({
            where: { teamId_slackUserId: { teamId: tenant, slackUserId: person.slackUserId } },
            create: { teamId: tenant, slackUserId: person.slackUserId, fieldId: setup.fieldId, value },
            update: { fieldId: setup.fieldId, value, writtenAt: new Date() },
          }),
        db,
      );
      counts.written++;
    } catch (err) {
      const code =
        (err as { data?: { error?: string } }).data?.error ?? (err instanceof Error ? err.message : String(err));
      counts.failed++;
      errors.push(`profile link ${person.slackUserId}: ${code}`);
      if (FATAL.has(code)) {
        // Stop at once instead of failing for every person.
        await withTenant(
          tenant,
          (tx) =>
            tx.workspace.update({
              where: { teamId: tenant },
              data: { profileWriterToken: null, profileWriterId: null },
            }),
          db,
        );
        break;
      }
    }
  }

  await withTenant(
    tenant,
    (tx) =>
      tx.syncRun.update({
        where: { id: run.id },
        data: {
          finishedAt: new Date(),
          counts: counts as unknown as Prisma.InputJsonValue,
          errors: errors.length ? errors.slice(0, 100) : undefined,
        },
      }),
    db,
  );
  log('profile links done', { tenant, ...counts });
  return counts;
}
