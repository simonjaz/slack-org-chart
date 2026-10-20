import type { AuditEntry, OverrideFields, PersonIssue } from '../../../src/shared/admin';
import type { PersonType } from '../../../src/shared/chart';

export const TYPE_LABEL: Record<PersonType, string> = {
  employee: 'Employee',
  multi_channel_guest: 'Multi-channel guest',
  single_channel_guest: 'Single-channel guest',
  slack_connect: 'Slack Connect',
  contractor: 'Contractor',
  external: 'External',
  bot: 'Bot',
};

export const ISSUE_LABEL: Record<PersonIssue, string> = {
  unplaced: 'No manager',
  rerouted: 'Manager deactivated',
  loop: 'Reporting loop',
  unknown_manager: 'Unknown manager',
};

export const ISSUE_HELP: Record<PersonIssue, string> = {
  unplaced: 'Nobody is set as their manager and nobody reports to them, so they sit in "Not placed yet".',
  rerouted: 'Their manager is deactivated in Slack, so the chart shows them under the next manager up. Pick a new manager.',
  loop: 'Slack has a reporting loop through this person. The chart cut it here.',
  unknown_manager: 'Their manager in Slack is not a member the app knows. Pick a manager here.',
};

const FIELD_LABEL: Record<keyof OverrideFields, string> = {
  managerSlackId: 'manager',
  userType: 'type',
  externalOrg: 'company',
  title: 'title',
  department: 'department',
  hidden: 'hidden',
  sortOrder: 'order',
};

// What an admin did, for the history list, after their name: "edited Erin:
// manager → Theo, hidden from the chart".
export function describeChange(entry: AuditEntry, nameOf: (id: string) => string): string {
  const who = entry.personName ?? 'someone';
  const before = (entry.before ?? {}) as Partial<OverrideFields> & { slackUserId?: string };
  const after = (entry.after ?? {}) as Partial<OverrideFields> & { slackUserId?: string };
  switch (entry.action) {
    case 'admin.add':
      return `made ${who} an admin`;
    case 'admin.remove':
      return `removed ${who} as an admin`;
    case 'settings.update': {
      const parts: string[] = [];
      const s = after as Record<string, unknown>;
      const b = before as Record<string, unknown>;
      if (s.allowGuestViewers !== b.allowGuestViewers) {
        parts.push(s.allowGuestViewers ? 'guests may view the chart' : 'guests may not view the chart');
      }
      if (s.autoAdminSlackAdmins !== b.autoAdminSlackAdmins) {
        parts.push(s.autoAdminSlackAdmins ? 'Slack admins are admins' : 'Slack admins are not automatically admins');
      }
      return `changed settings: ${parts.join(', ') || 'no change'}`;
    }
    case 'profile_link.connect':
      return 'connected the profile link field';
    case 'profile_link.disconnect':
      return 'disconnected the profile link field';
    case 'profile_link.field':
      return (after as { fieldId?: string | null }).fieldId
        ? 'picked the field for profile links'
        : 'turned off profile links';
  }
  const keys = Object.keys(FIELD_LABEL) as (keyof OverrideFields)[];
  const parts = keys
    .filter((k) => (before[k] ?? null) !== (after[k] ?? null))
    .map((k) => {
      const value = after[k] ?? null;
      if (k === 'hidden' && !value) return 'shown on the chart';
      if (value === null) return `${FIELD_LABEL[k]} back to Slack`;
      if (k === 'managerSlackId') return value === '' ? 'no manager' : `manager → ${nameOf(String(value))}`;
      if (k === 'hidden') return 'hidden from the chart';
      if (k === 'userType') return `type → ${TYPE_LABEL[value as PersonType] ?? value}`;
      return `${FIELD_LABEL[k]} → ${value}`;
    });
  const how = entry.action === 'person.import' ? 'imported a change for' : 'edited';
  return `${how} ${who}: ${parts.join(', ') || 'no change'}`;
}

export function formatTime(iso: string | null): string {
  if (!iso) return '';
  return new Date(iso).toLocaleString(undefined, { dateStyle: 'medium', timeStyle: 'short' });
}
