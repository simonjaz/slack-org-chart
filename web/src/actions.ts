import type { ActionsStatus, ChannelResult, ConversationResult } from '../../src/shared/actions';

// Group DMs and channels run with the viewer's own Slack token. The first
// time, Slack asks them to allow it; NeedsGrant tells the page to send them.
export class NeedsGrant extends Error {}

export class ActionFailed extends Error {
  constructor(
    readonly code: string,
    message: string,
  ) {
    super(message);
  }
}

async function post<T>(path: string, body: unknown): Promise<T> {
  const res = await fetch(path, {
    method: 'POST',
    credentials: 'same-origin',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  });
  const data = await res.json().catch(() => ({}));
  if (res.status === 401) {
    if (data.error === 'needs_grant') throw new NeedsGrant(data.message);
    const next = window.location.pathname + window.location.search;
    window.location.assign(`/auth/login?next=${encodeURIComponent(next)}`);
    return new Promise(() => {}); // the page is leaving
  }
  if (!res.ok)
    throw new ActionFailed(data.error ?? 'error', data.message ?? `Slack could not do that (${res.status}).`);
  return data as T;
}

export const actionsApi = {
  status: async (): Promise<ActionsStatus> => {
    const res = await fetch('/api/actions/status', { credentials: 'same-origin' });
    return res.ok ? ((await res.json()) as ActionsStatus) : { granted: false };
  },
  conversation: (userIds: string[]) => post<ConversationResult>('/api/actions/conversation', { userIds }),
  channel: (name: string, isPrivate: boolean, userIds: string[]) =>
    post<ChannelResult>('/api/actions/channel', { name, isPrivate, userIds }),
};

// Opens a DM with one person. Slack's own link, so no token is needed.
export const dmLink = (teamId: string, userId: string) =>
  `slack://user?team=${encodeURIComponent(teamId)}&id=${encodeURIComponent(userId)}`;

export const channelLink = (teamId: string, channelId: string) =>
  `slack://channel?team=${encodeURIComponent(teamId)}&id=${encodeURIComponent(channelId)}`;

// For browsers without the Slack app.
export const webChannelLink = (teamId: string, channelId: string) =>
  `https://app.slack.com/client/${encodeURIComponent(teamId)}/${encodeURIComponent(channelId)}`;

// What the person was doing when Slack's permission screen took them away,
// so the chart can pick up where they left off.
const PENDING_KEY = 'orgchart.pending';
export interface Pending {
  userIds: string[];
  action: 'conversation' | 'channel';
  name?: string;
  isPrivate?: boolean;
}

export function savePending(p: Pending) {
  try {
    sessionStorage.setItem(PENDING_KEY, JSON.stringify(p));
  } catch {
    /* storage blocked: the selection is just not restored */
  }
}

export function takePending(): Pending | null {
  try {
    const raw = sessionStorage.getItem(PENDING_KEY);
    sessionStorage.removeItem(PENDING_KEY);
    return raw ? (JSON.parse(raw) as Pending) : null;
  } catch {
    return null;
  }
}

export function grantUrl(next: string) {
  return `/auth/grant?kind=actions&next=${encodeURIComponent(next)}`;
}
