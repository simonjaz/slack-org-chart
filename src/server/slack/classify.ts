import type { UserType } from '@prisma/client';
import type { SlackUser, WorkspaceIdentity } from './types.js';

// Sorts a Slack user into one type. See "Detecting external users" in the
// architecture doc. Admins can override the result on the admin page.
export function classifyUser(user: SlackUser, workspace: WorkspaceIdentity): UserType {
  if (user.is_bot || user.is_app_user || user.id === 'USLACKBOT') return 'bot';
  if (!isSameOrg(user, workspace)) return 'slack_connect';
  if (user.is_ultra_restricted) return 'single_channel_guest';
  if (user.is_restricted) return 'multi_channel_guest';
  return 'employee';
}

// On Enterprise Grid a colleague can belong to a sibling workspace, so the
// enterprise id counts as "same org" too.
export function isSameOrg(user: SlackUser, workspace: WorkspaceIdentity): boolean {
  const userTeam = user.team_id ?? user.profile?.team;
  if (!userTeam || userTeam === workspace.teamId) return true;
  const userEnterprise = user.enterprise_user?.enterprise_id;
  return Boolean(workspace.enterpriseId && userEnterprise === workspace.enterpriseId);
}

export const EXTERNAL_TYPES: ReadonlySet<UserType> = new Set<UserType>([
  'multi_channel_guest',
  'single_channel_guest',
  'slack_connect',
  'contractor',
  'external',
]);

export function isExternal(type: UserType): boolean {
  return EXTERNAL_TYPES.has(type);
}
