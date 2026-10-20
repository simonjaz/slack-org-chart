import type { SyncClient } from '../src/server/slack/sync.js';
import type { SlackUser } from '../src/server/slack/types.js';

// An in-memory Slack workspace for sync tests.
export interface FakeWorkspace {
  team: { id: string; name: string; domain: string; enterprise_id?: string };
  fields: { id: string; label: string; type: string }[];
  members: SlackUser[];
  // Custom field values per user id.
  profiles: Record<string, Record<string, string>>;
  channels: { id: string; is_ext_shared: boolean; members: string[] }[];
  // Users outside users.list (Slack Connect), by id.
  strangers: Record<string, SlackUser>;
  otherTeams: Record<string, string>;
}

export function fakeSlack(ws: FakeWorkspace): SyncClient & { calls: Record<string, number> } {
  const calls: Record<string, number> = {};
  const count = (name: string) => (calls[name] = (calls[name] ?? 0) + 1);
  const page = <T>(items: T[], cursor: string | undefined, limit = 2) => {
    const start = cursor ? Number(cursor) : 0;
    const next = start + limit < items.length ? String(start + limit) : '';
    return { items: items.slice(start, start + limit), next };
  };
  const findUser = (id: string) => ws.members.find((m) => m.id === id) ?? ws.strangers[id];

  return {
    calls,
    team: {
      info: async (args?: { team?: string }) => {
        count('team.info');
        if (!args?.team || args.team === ws.team.id) return { team: ws.team };
        const name = ws.otherTeams[args.team];
        if (!name) throw new Error('team_not_found');
        return { team: { id: args.team, name } };
      },
      profile: { get: async () => (count('team.profile.get'), { profile: { fields: ws.fields } }) },
    },
    users: {
      // Small pages so pagination is exercised.
      list: async ({ cursor }: { cursor?: string }) => {
        count('users.list');
        const { items, next } = page(ws.members, cursor);
        return { members: items, response_metadata: { next_cursor: next } };
      },
      info: async ({ user }: { user: string }) => {
        count('users.info');
        const u = findUser(user);
        if (!u) throw new Error('user_not_found');
        return { user: u };
      },
      profile: {
        get: async ({ user }: { user: string }) => {
          count('users.profile.get');
          const u = findUser(user);
          const values = ws.profiles[user] ?? {};
          const fields = Object.fromEntries(Object.entries(values).map(([k, v]) => [k, { value: v, alt: '' }]));
          return { profile: { ...u?.profile, fields } };
        },
      },
    },
    conversations: {
      list: async ({ cursor }: { cursor?: string }) => {
        count('conversations.list');
        const { items, next } = page(ws.channels, cursor);
        return { channels: items, response_metadata: { next_cursor: next } };
      },
      members: async ({ channel, cursor }: { channel: string; cursor?: string }) => {
        count('conversations.members');
        const c = ws.channels.find((ch) => ch.id === channel)!;
        const { items, next } = page(c.members, cursor);
        return { members: items, response_metadata: { next_cursor: next } };
      },
    },
  };
}

export function user(id: string, name: string, extra: Partial<SlackUser> = {}, team = 'T1'): SlackUser {
  return {
    id,
    team_id: team,
    name: name.toLowerCase(),
    ...extra,
    profile: {
      real_name: name,
      title: extra.profile?.title ?? `${name}'s title`,
      email: `${name.toLowerCase()}@example.com`,
      image_192: `https://avatars.slack-edge.com/${id}_192.png`,
      team,
      ...extra.profile,
    },
  };
}
