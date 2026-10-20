// Shapes shared by the actions API and the chart page.

// A group DM holds at most 9 people: the viewer plus 8 others.
export const MAX_GROUP_DM_OTHERS = 8;
// conversations.invite takes up to 1,000 people a call; one call is enough.
export const MAX_CHANNEL_INVITES = 1000;

export interface ActionsStatus {
  // The viewer granted their own token, so group DMs and channels work.
  granted: boolean;
}

export interface ConversationResult {
  channelId: string;
  // The workspace to open it in (slack://channel?team=...).
  teamId: string;
}

export interface ChannelResult extends ConversationResult {
  name: string;
  invited: string[];
  notInvited: { userId: string; reason: string }[];
}

// Slack's invite error codes, in words the page can show after a name.
const INVITE_REASONS: Record<string, string> = {
  user_is_restricted: 'is a guest, so only a Slack admin can add them',
  user_is_ultra_restricted: 'is a single-channel guest',
  ura_max_channels: 'is a single-channel guest already in a channel',
  cant_invite: 'cannot be added to this channel',
  user_not_found: 'is no longer in Slack',
  user_disabled: 'is deactivated',
  not_in_channel: 'cannot be added to this channel',
  external_teams_not_allowed: 'is from another company',
  restricted_action: 'cannot be added because of a workspace setting',
};

export function inviteReason(code: string): string {
  return INVITE_REASONS[code] ?? `could not be added (${code})`;
}

// Slack channel names: lowercase letters, numbers, hyphens and underscores,
// at most 80 characters. Turns "Q4 Launch Team!" into "q4-launch-team".
export function channelName(input: string): string {
  return input
    .normalize('NFKD')
    .replace(/[̀-ͯ]/g, '')
    .toLowerCase()
    .replace(/^#/, '')
    .replace(/[\s.]+/g, '-')
    .replace(/[^a-z0-9_-]/g, '')
    .replace(/-{2,}/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 80);
}
