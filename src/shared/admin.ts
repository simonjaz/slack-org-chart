// Shapes shared by the admin API and the admin page.
import type { PersonType } from './chart.js';

// The fields an admin can override. null in an override means "use Slack".
export interface OverrideFields {
  // '' means "explicitly no manager" (a root of the chart).
  managerSlackId: string | null;
  userType: PersonType | null;
  externalOrg: string | null;
  title: string | null;
  department: string | null;
  hidden: boolean | null;
  sortOrder: number | null;
}

// Types an admin may set. Guests and Slack Connect people are detected from
// Slack and cannot be assigned by hand; bots are never shown.
export const ASSIGNABLE_TYPES = ['employee', 'contractor', 'external'] as const;
export type AssignableType = (typeof ASSIGNABLE_TYPES)[number];

export type PersonIssue =
  // Internal person with no manager and no reports.
  | 'unplaced'
  // Their manager is deactivated or hidden, so they sit under the next one up.
  | 'rerouted'
  // Slack's data had a reporting loop and this person was cut loose.
  | 'loop'
  // The manager in Slack is not someone the app knows about.
  | 'unknown_manager';

export interface AdminPerson {
  slackUserId: string;
  name: string;
  email: string | null;
  avatarUrl: string | null;
  isDeleted: boolean;
  isSlackAdmin: boolean;
  isAdmin: boolean;
  // What Slack says.
  slack: {
    managerSlackId: string | null;
    userType: PersonType;
    externalOrg: string | null;
    title: string | null;
    department: string | null;
  };
  override: OverrideFields | null;
  // What the chart shows.
  effective: {
    managerSlackId: string | null;
    userType: PersonType;
    externalOrg: string | null;
    title: string | null;
    department: string | null;
    hidden: boolean;
  };
  // The manager they hang under on the chart, after rerouting.
  chartParentId: string | null;
  reports: number;
  issues: PersonIssue[];
  updatedBy: string | null;
  updatedAt: string | null;
}

export interface AdminPeopleResponse {
  people: AdminPerson[];
}

export type PersonPatch = Partial<OverrideFields>;

export interface AdminEntry {
  slackUserId: string;
  name: string | null;
  avatarUrl: string | null;
  // 'role': granted on the admin page or at install. 'slack_admin': a Slack
  // owner or admin while the automatic setting is on.
  source: 'role' | 'slack_admin';
  grantedBy: string | null;
  grantedAt: string | null;
}

export interface WorkspaceSettings {
  allowGuestViewers: boolean;
  autoAdminSlackAdmins: boolean;
}

export interface AuditEntry {
  id: string;
  actor: string;
  actorName: string | null;
  action: string;
  personId: string | null;
  personName: string | null;
  before: unknown;
  after: unknown;
  at: string;
}

export interface SyncRunInfo {
  kind: string;
  startedAt: string;
  finishedAt: string | null;
  counts: unknown;
  errorCount: number;
}

export interface MeResponse {
  slackUserId: string;
  teamId: string;
  isAdmin: boolean;
}

export interface ImportRowResult {
  line: number;
  email: string;
  status: 'ok' | 'unchanged' | 'error';
  message?: string;
  slackUserId?: string;
  managerSlackId?: string | null;
}

export interface ImportResponse {
  applied: boolean;
  rows: ImportRowResult[];
  changed: number;
  errors: number;
}

export interface ApiError {
  error: string;
  message: string;
}
