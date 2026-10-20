import type { Prisma, PrismaClient, UserType } from '@prisma/client';
import { prisma as defaultPrisma, withTenant } from '../db.js';
import { classifyUser } from './classify.js';
import { findDepartmentField, findManagerField, readManagerId, type ProfileFieldDef } from './profileFields.js';
import type { SlackProfile, SlackUser, WorkspaceIdentity } from './types.js';

// The Slack Web API methods the sync calls. A WebClient satisfies it; tests
// pass a fake.
type Call = (args?: any) => Promise<any>;
export interface SyncClient {
  team: { info: Call; profile: { get: Call } };
  users: { list: Call; info: Call; profile: { get: Call } };
  conversations: { list: Call; members: Call };
}

export interface PersonRecord {
  slackUserId: string;
  homeTeamId: string | null;
  name: string;
  displayName: string | null;
  title: string | null;
  department: string | null;
  email: string | null;
  avatarUrl: string | null;
  userType: UserType;
  externalOrg: string | null;
  slackManagerId: string | null;
  isSlackAdmin: boolean;
  isDeleted: boolean;
}

export interface SyncCounts {
  members: number;
  slackConnect: number;
  profilesRead: number;
  markedDeleted: number;
}

export interface SyncOptions {
  db?: PrismaClient;
  // Parallel users.profile.get calls. Slack allows about 100 a minute;
  // WebClient waits and retries when Slack says slow down.
  profileConcurrency?: number;
  log?: (msg: string, extra?: unknown) => void;
}

interface FieldIds {
  managerFieldId: string | null;
  departmentFieldId: string | null;
}

export function toPersonRecord(
  user: SlackUser,
  workspace: WorkspaceIdentity,
  fields: FieldIds,
  extra: { profile?: SlackProfile; externalOrg?: string | null } = {},
): PersonRecord {
  const profile = { ...user.profile, ...extra.profile };
  const custom = profile.fields ?? {};
  const userType = classifyUser(user, workspace);
  const name =
    profile.real_name?.trim() || user.real_name?.trim() || profile.display_name?.trim() || user.name || user.id;
  return {
    slackUserId: user.id,
    homeTeamId: user.team_id ?? profile.team ?? null,
    name,
    displayName: profile.display_name?.trim() || null,
    title: profile.title?.trim() || null,
    department: (fields.departmentFieldId && custom[fields.departmentFieldId]?.value?.trim()) || null,
    email: profile.email ?? null,
    avatarUrl: profile.image_192 ?? profile.image_72 ?? null,
    userType,
    externalOrg: userType === 'slack_connect' ? (extra.externalOrg ?? null) : null,
    slackManagerId: fields.managerFieldId ? readManagerId(custom[fields.managerFieldId]?.value) : null,
    isSlackAdmin: Boolean(user.is_admin || user.is_owner),
    isDeleted: Boolean(user.deleted),
  };
}

// Full sync of one workspace: every member, their Manager field and photo,
// plus Slack Connect people found in shared channels. People we did not see
// this time are marked deleted, never removed, so admin overrides survive.
export async function fullSync(teamId: string, client: SyncClient, opts: SyncOptions = {}): Promise<SyncCounts> {
  const db = opts.db ?? defaultPrisma;
  const log = opts.log ?? (() => {});
  const run = await withTenant(teamId, (tx) => tx.syncRun.create({ data: { teamId, kind: 'full' } }), db);
  const errors: string[] = [];

  try {
    const workspace = await refreshWorkspace(teamId, client, db);
    const identity: WorkspaceIdentity = { teamId, enterpriseId: workspace.enterpriseId };
    const fields: FieldIds = {
      managerFieldId: workspace.managerFieldId,
      departmentFieldId: workspace.departmentFieldId,
    };

    const members = await listAllMembers(client);
    const seen = new Set(members.map((m) => m.id));

    // users.list leaves out custom fields, so each active person needs a
    // users.profile.get call when there is a field to read.
    const needsProfile = fields.managerFieldId || fields.departmentFieldId;
    let profilesRead = 0;
    const records = await mapLimit(members, opts.profileConcurrency ?? 3, async (user) => {
      if (!needsProfile || user.deleted || user.is_bot || user.is_app_user || user.id === 'USLACKBOT') {
        return toPersonRecord(user, identity, fields);
      }
      try {
        const res = await client.users.profile.get({ user: user.id, include_labels: false });
        profilesRead++;
        return toPersonRecord(user, identity, fields, { profile: res.profile });
      } catch (err) {
        errors.push(`profile ${user.id}: ${errorMessage(err)}`);
        return toPersonRecord(user, identity, fields);
      }
    });

    const external = await discoverSlackConnect(client, identity, fields, seen, errors);
    for (const r of external) seen.add(r.slackUserId);

    await savePeople(teamId, [...records, ...external], db);
    const markedDeleted = await withTenant(
      teamId,
      async (tx) =>
        (
          await tx.person.updateMany({
            where: { teamId, isDeleted: false, slackUserId: { notIn: [...seen] } },
            data: { isDeleted: true },
          })
        ).count,
      db,
    );

    const counts: SyncCounts = {
      members: records.length,
      slackConnect: external.length,
      profilesRead,
      markedDeleted,
    };
    log('full sync done', { teamId, ...counts, errors: errors.length });
    await finishRun(teamId, run.id, counts, errors, db);
    return counts;
  } catch (err) {
    errors.push(errorMessage(err));
    await finishRun(teamId, run.id, null, errors, db);
    throw err;
  }
}

// One person, for live events (user_change, team_join, user_profile_changed).
export async function syncOneUser(
  teamId: string,
  client: SyncClient,
  userId: string,
  opts: { db?: PrismaClient } = {},
): Promise<PersonRecord> {
  const db = opts.db ?? defaultPrisma;
  const workspace = await withTenant(teamId, (tx) => tx.workspace.findUniqueOrThrow({ where: { teamId } }), db);
  const identity = { teamId, enterpriseId: workspace.enterpriseId };
  const fields = { managerFieldId: workspace.managerFieldId, departmentFieldId: workspace.departmentFieldId };

  const { user } = (await client.users.info({ user: userId })) as { user: SlackUser };
  let profile: SlackProfile | undefined;
  if ((fields.managerFieldId || fields.departmentFieldId) && !user.deleted && !user.is_bot) {
    profile = (await client.users.profile.get({ user: userId })).profile;
  }
  let externalOrg: string | null = null;
  if (classifyUser(user, identity) === 'slack_connect' && user.team_id) {
    externalOrg = await teamName(client, user.team_id, new Map());
  }
  const record = toPersonRecord(user, identity, fields, { profile, externalOrg });
  await savePeople(teamId, [record], db);
  return record;
}

async function refreshWorkspace(teamId: string, client: SyncClient, db: PrismaClient) {
  const [teamRes, fieldsRes] = await Promise.all([
    client.team.info(),
    client.team.profile.get().catch(() => ({ profile: { fields: [] } })),
  ]);
  const defs: ProfileFieldDef[] = fieldsRes.profile?.fields ?? [];
  return withTenant(
    teamId,
    async (tx) => {
      const current = await tx.workspace.findUniqueOrThrow({ where: { teamId } });
      return tx.workspace.update({
        where: { teamId },
        data: {
          name: teamRes.team?.name ?? current.name,
          domain: teamRes.team?.domain ?? current.domain,
          enterpriseId: teamRes.team?.enterprise_id ?? current.enterpriseId,
          // An admin's choice of field wins over discovery.
          managerFieldId: current.managerFieldId ?? findManagerField(defs) ?? null,
          departmentFieldId: current.departmentFieldId ?? findDepartmentField(defs) ?? null,
        },
      });
    },
    db,
  );
}

async function listAllMembers(client: SyncClient): Promise<SlackUser[]> {
  const out: SlackUser[] = [];
  let cursor: string | undefined;
  do {
    const res = await client.users.list({ limit: 200, cursor });
    out.push(...((res.members ?? []) as SlackUser[]));
    cursor = res.response_metadata?.next_cursor || undefined;
  } while (cursor);
  return out;
}

// Slack Connect people are not in users.list. Find them through the members
// of channels shared with other organisations.
async function discoverSlackConnect(
  client: SyncClient,
  identity: WorkspaceIdentity,
  fields: FieldIds,
  known: Set<string>,
  errors: string[],
): Promise<PersonRecord[]> {
  const candidates = new Set<string>();
  let cursor: string | undefined;
  do {
    const res = await client.conversations.list({
      types: 'public_channel,private_channel',
      exclude_archived: true,
      limit: 200,
      cursor,
    });
    for (const channel of res.channels ?? []) {
      if (!channel.is_ext_shared) continue;
      let memberCursor: string | undefined;
      do {
        const m = await client.conversations.members({ channel: channel.id, limit: 200, cursor: memberCursor });
        for (const id of m.members ?? []) if (!known.has(id)) candidates.add(id);
        memberCursor = m.response_metadata?.next_cursor || undefined;
      } while (memberCursor);
    }
    cursor = res.response_metadata?.next_cursor || undefined;
  } while (cursor);

  const teamNames = new Map<string, string | null>();
  const out: PersonRecord[] = [];
  for (const id of candidates) {
    try {
      const { user } = (await client.users.info({ user: id })) as { user: SlackUser };
      if (classifyUser(user, identity) !== 'slack_connect') continue;
      const externalOrg = user.team_id ? await teamName(client, user.team_id, teamNames) : null;
      out.push(toPersonRecord(user, identity, fields, { externalOrg }));
    } catch (err) {
      errors.push(`connect user ${id}: ${errorMessage(err)}`);
    }
  }
  return out;
}

async function teamName(client: SyncClient, team: string, cache: Map<string, string | null>) {
  if (!cache.has(team)) {
    // Slack only answers for teams that share a channel with this one, and
    // not always then. An admin can type the name in when it is missing.
    const name = await client.team
      .info({ team })
      .then((r) => (r.team?.name as string | undefined) ?? null)
      .catch(() => null);
    cache.set(team, name);
  }
  return cache.get(team) ?? null;
}

export async function savePeople(teamId: string, records: PersonRecord[], db: PrismaClient = defaultPrisma) {
  const now = new Date();
  for (let i = 0; i < records.length; i += 200) {
    const batch = records.slice(i, i + 200);
    await withTenant(
      teamId,
      async (tx) => {
        for (const r of batch) {
          const data = { ...r, lastSyncedAt: now } satisfies Omit<Prisma.PersonUncheckedCreateInput, 'teamId'>;
          await tx.person.upsert({
            where: { teamId_slackUserId: { teamId, slackUserId: r.slackUserId } },
            create: { teamId, ...data },
            update: data,
          });
        }
      },
      db,
    );
  }
}

async function finishRun(
  teamId: string,
  id: bigint,
  counts: SyncCounts | null,
  errors: string[],
  db: PrismaClient,
) {
  await withTenant(
    teamId,
    (tx) =>
      tx.syncRun.update({
        where: { id },
        data: {
          finishedAt: new Date(),
          counts: (counts ?? undefined) as Prisma.InputJsonValue | undefined,
          errors: errors.length ? errors.slice(0, 100) : undefined,
        },
      }),
    db,
  );
}

async function mapLimit<T, R>(items: T[], limit: number, fn: (item: T) => Promise<R>): Promise<R[]> {
  const out = new Array<R>(items.length);
  let next = 0;
  const workers = Array.from({ length: Math.min(limit, items.length) }, async () => {
    while (next < items.length) {
      const i = next++;
      out[i] = await fn(items[i]!);
    }
  });
  await Promise.all(workers);
  return out;
}

function errorMessage(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}
