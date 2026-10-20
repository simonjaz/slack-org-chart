// Stands in for the Node service: answers the page's /api/* calls from the
// sample workspace in memory. The chart tree comes from the real
// buildChart(), so admin edits show up on the chart the same way they would.
import type { ChartNode, ChartResponse, PersonType } from '../src/shared/chart';
import type {
  AdminEntry,
  AdminPerson,
  AuditEntry,
  ImportRowResult,
  OverrideFields,
  PersonIssue,
  ProfileLinkSettings,
  SyncRunInfo,
  WorkspaceSettings,
} from '../src/shared/admin';
import { MAX_GROUP_DM_OTHERS, channelName, inviteReason } from '../src/shared/actions';
import { UNPLACED_GROUP_ID, buildChart, resolveFocus, type EffectivePerson } from '../src/server/chart/tree';
import { parseCsv } from '../src/server/admin/csv';
import { PEOPLE, TEAM_ID, WORKSPACE_NAME, type DemoPerson } from './data';

export interface Conversation {
  id: string;
  kind: 'dm' | 'group' | 'channel';
  name: string;
  isPrivate?: boolean;
  members: string[];
  notInvited?: { userId: string; reason: string }[];
}

// What the shell (the mock Slack around the page) provides.
export interface DemoHooks {
  // Slack's "Allow Org Chart to..." screen. Resolves true on Allow.
  askPermission(kind: 'actions' | 'profile'): Promise<boolean>;
  onChange(): void;
}

const EMPTY: OverrideFields = {
  managerSlackId: null,
  userType: null,
  externalOrg: null,
  title: null,
  department: null,
  hidden: null,
  sortOrder: null,
};
const KEYS = Object.keys(EMPTY) as (keyof OverrideFields)[];
const EXTERNAL_TYPES: PersonType[] = ['multi_channel_guest', 'single_channel_guest', 'slack_connect'];
const GUEST_TYPES: PersonType[] = ['multi_channel_guest', 'single_channel_guest'];

const minutesAgo = (m: number) => new Date(Date.now() - m * 60_000).toISOString();

export const state = {
  viewer: 'U007',
  focus: null as string | null,
  overrides: new Map<string, { fields: OverrideFields; by: string; at: string }>(),
  admins: [{ slackUserId: 'U007', grantedBy: 'install', grantedAt: minutesAgo(60 * 24 * 6) }],
  settings: { allowGuestViewers: false, autoAdminSlackAdmins: true } as WorkspaceSettings,
  audit: [] as AuditEntry[],
  syncRuns: [
    { kind: 'full', startedAt: minutesAgo(60 * 7), finishedAt: minutesAgo(60 * 7 - 2), counts: { members: 27, slackConnect: 2 }, errorCount: 0 },
    { kind: 'full', startedAt: minutesAgo(60 * 31), finishedAt: minutesAgo(60 * 31 - 2), counts: { members: 26, slackConnect: 2 }, errorCount: 0 },
  ] as SyncRunInfo[],
  profileLink: {
    fieldId: 'Xf06ORGCHART' as string | null,
    writer: { slackUserId: 'U001', name: 'Maya Okafor' } as ProfileLinkSettings['writer'],
    lastRun: { kind: 'profile_links', startedAt: minutesAgo(60 * 7 - 3), finishedAt: minutesAgo(60 * 7 - 4), counts: { written: 3, unchanged: 22 }, errorCount: 0 } as SyncRunInfo | null,
  },
  // The viewer allowed Org Chart to start group DMs and channels for them.
  granted: new Set<string>(),
  conversations: new Map<string, Conversation>(),
  channelNames: new Set(['general', 'engineering', 'random']),
};

const byId = new Map(PEOPLE.map((p) => [p.id, p]));
export const person = (id: string): DemoPerson | undefined => byId.get(id);

let hooks: DemoHooks = { askPermission: async () => true, onChange: () => {} };
let seq = 1;

class Fail extends Error {
  constructor(
    readonly status: number,
    readonly code: string,
    message: string,
  ) {
    super(message);
  }
}

function effectiveManager(p: DemoPerson): string | null {
  const o = state.overrides.get(p.id)?.fields;
  const value = o?.managerSlackId ?? p.managerId;
  return value ? value : null;
}

function effectivePeople(): EffectivePerson[] {
  return PEOPLE.map((p) => {
    const o = state.overrides.get(p.id)?.fields ?? EMPTY;
    return {
      slackUserId: p.id,
      name: p.name,
      title: o.title ?? p.title,
      department: o.department ?? p.department,
      avatarUrl: p.avatarUrl,
      userType: o.userType ?? p.userType,
      externalOrg: o.externalOrg ?? p.externalOrg,
      managerSlackId: effectiveManager(p),
      hidden: o.hidden ?? false,
      isDeleted: p.isDeleted,
      sortOrder: o.sortOrder,
    };
  });
}

export function chartNodes(): ChartNode[] {
  return buildChart(effectivePeople(), WORKSPACE_NAME);
}

const canBeAdmin = (p: DemoPerson) => !p.isDeleted && !EXTERNAL_TYPES.includes(p.userType) && p.userType !== 'bot';

function isAdmin(id: string): boolean {
  const p = person(id);
  if (!p || !canBeAdmin(p)) return false;
  return state.admins.some((a) => a.slackUserId === id) || (state.settings.autoAdminSlackAdmins && p.isSlackAdmin);
}

function viewerType(): PersonType {
  const p = person(state.viewer)!;
  return state.overrides.get(p.id)?.fields.userType ?? p.userType;
}

function requireViewer() {
  if (GUEST_TYPES.includes(viewerType()) && !state.settings.allowGuestViewers) {
    throw new Fail(403, 'guest', 'Guests cannot view the org chart in this workspace. An org chart admin can allow it.');
  }
}

function requireAdmin() {
  if (!isAdmin(state.viewer)) throw new Fail(403, 'not_admin', 'Only org chart admins can open this page.');
}

function log(action: string, personId: string | null, before: unknown, after: unknown) {
  state.audit.unshift({
    id: String(seq++),
    actor: state.viewer,
    actorName: person(state.viewer)?.name ?? null,
    action,
    personId,
    personName: personId ? (person(personId)?.name ?? null) : null,
    before,
    after,
    at: new Date().toISOString(),
  });
}

function saveOverride(p: DemoPerson, next: OverrideFields, action: string) {
  const before = state.overrides.get(p.id)?.fields ?? null;
  if (KEYS.every((k) => (before?.[k] ?? null) === next[k])) return false;
  if (KEYS.every((k) => next[k] === null)) state.overrides.delete(p.id);
  else state.overrides.set(p.id, { fields: next, by: state.viewer, at: new Date().toISOString() });
  log(action, p.id, before, KEYS.every((k) => next[k] === null) ? null : next);
  return true;
}

function createsLoop(managerOf: Map<string, string | null>, start: string): boolean {
  const seen = new Set<string>();
  let cursor = managerOf.get(start) ?? null;
  while (cursor) {
    if (cursor === start) return true;
    if (seen.has(cursor)) return false;
    seen.add(cursor);
    cursor = managerOf.get(cursor) ?? null;
  }
  return false;
}

function checkManager(target: DemoPerson, manager: DemoPerson | undefined) {
  if (!manager) throw new Fail(400, 'unknown_manager', 'That manager is not in this workspace.');
  if (manager.id === target.id) throw new Fail(400, 'self_manager', 'Someone cannot be their own manager.');
  if (manager.isDeleted) throw new Fail(400, 'manager_deactivated', `${manager.name} is deactivated in Slack.`);
}

function listPeople(): AdminPerson[] {
  const nodes = new Map(chartNodes().map((n) => [n.id, n]));
  const reports = new Map<string, number>();
  for (const n of nodes.values()) {
    if (n.kind === 'person' && n.parentId) reports.set(n.parentId, (reports.get(n.parentId) ?? 0) + 1);
  }
  return [...PEOPLE]
    .sort((a, b) => a.name.localeCompare(b.name))
    .map((p) => {
      const saved = state.overrides.get(p.id);
      const o = saved?.fields ?? null;
      const node = nodes.get(p.id);
      const managerId = effectiveManager(p);
      const issues: PersonIssue[] = [];
      if (node?.rerouted && managerId && person(managerId)?.isDeleted) issues.push('rerouted');
      if (node?.cycleBroken) issues.push('loop');
      if (node?.parentId === UNPLACED_GROUP_ID) issues.push('unplaced');
      return {
        slackUserId: p.id,
        name: p.name,
        email: p.email,
        avatarUrl: p.avatarUrl,
        isDeleted: p.isDeleted,
        isSlackAdmin: p.isSlackAdmin,
        isAdmin: isAdmin(p.id),
        slack: {
          managerSlackId: p.managerId,
          userType: p.userType,
          externalOrg: p.externalOrg,
          title: p.title,
          department: p.department,
        },
        override: o,
        effective: {
          managerSlackId: managerId,
          userType: o?.userType ?? p.userType,
          externalOrg: o?.externalOrg ?? p.externalOrg,
          title: o?.title ?? p.title,
          department: o?.department ?? p.department,
          hidden: o?.hidden ?? false,
        },
        chartParentId: node?.kind === 'person' && node.parentId && byId.has(node.parentId) ? node.parentId : null,
        reports: reports.get(p.id) ?? 0,
        issues,
        updatedBy: saved?.by ?? null,
        updatedAt: saved?.at ?? null,
      };
    });
}

function cleanText(value: unknown): string | null | undefined {
  if (value === undefined || value === null) return value as null | undefined;
  const trimmed = String(value).trim().slice(0, 200);
  return trimmed === '' ? null : trimmed;
}

function updatePerson(id: string, raw: Partial<OverrideFields>) {
  const p = person(id);
  if (!p) throw new Fail(404, 'not_found', 'That person is not in this workspace.');
  const patch: Partial<OverrideFields> = { ...raw };
  for (const k of ['title', 'department', 'externalOrg'] as const) if (k in raw) patch[k] = cleanText(raw[k]);
  const next: OverrideFields = { ...(state.overrides.get(id)?.fields ?? EMPTY) };
  for (const k of KEYS) if (k in patch) (next as unknown as Record<string, unknown>)[k] = patch[k] ?? null;
  if (next.userType === 'employee' && EXTERNAL_TYPES.includes(p.userType)) {
    throw new Fail(400, 'cannot_make_employee', `Slack lists ${p.name} as a guest or external person.`);
  }
  if ('managerSlackId' in patch && next.managerSlackId) {
    const manager = person(next.managerSlackId);
    checkManager(p, manager);
    const managers = new Map(PEOPLE.map((q) => [q.id, effectiveManager(q)]));
    managers.set(p.id, next.managerSlackId);
    if (createsLoop(managers, p.id)) {
      throw new Fail(
        409,
        'reporting_loop',
        `${manager!.name} already reports to ${p.name}, directly or further down. Move ${manager!.name} first.`,
      );
    }
  }
  saveOverride(p, next, 'person.update');
}

function importCsv(csv: string, apply: boolean) {
  const rows = parseCsv(csv);
  const header = rows.shift();
  if (!header) throw new Fail(400, 'empty_csv', 'The file is empty.');
  const columns = header.cells.map((c) => c.trim().toLowerCase().replace(/[\s-]+/g, '_'));
  const col = (name: string) => columns.indexOf(name);
  const emailCol = col('email');
  const managerCol = col('manager_email');
  if (emailCol < 0 || managerCol < 0) {
    throw new Fail(400, 'bad_header', 'The first line must name the columns email and manager_email.');
  }
  const titleCol = col('title');
  const deptCol = col('department');
  const byEmail = new Map(PEOPLE.map((p) => [p.email.toLowerCase(), p]));
  const managers = new Map(PEOPLE.map((p) => [p.id, effectiveManager(p)]));
  const results: ImportRowResult[] = [];
  const pending: { p: DemoPerson; next: OverrideFields }[] = [];
  const seen = new Set<string>();
  for (const row of rows) {
    const cell = (i: number) => (i >= 0 ? (row.cells[i] ?? '').trim() : '');
    const email = cell(emailCol);
    const fail = (message: string) => results.push({ line: row.line, email, status: 'error', message });
    const p = byEmail.get(email.toLowerCase());
    if (!email) {
      fail('No email.');
      continue;
    }
    if (!p || p.isDeleted) {
      fail('No active Slack member has this email.');
      continue;
    }
    if (seen.has(p.id)) {
      fail('This person is already in the file.');
      continue;
    }
    seen.add(p.id);
    const next: OverrideFields = { ...(state.overrides.get(p.id)?.fields ?? EMPTY) };
    const managerEmail = cell(managerCol);
    if (managerEmail) {
      const manager = byEmail.get(managerEmail.toLowerCase());
      try {
        checkManager(p, manager);
      } catch (err) {
        fail(err instanceof Fail ? err.message.replace('That manager', managerEmail) : String(err));
        continue;
      }
      const previous = managers.get(p.id) ?? null;
      managers.set(p.id, manager!.id);
      if (createsLoop(managers, p.id)) {
        managers.set(p.id, previous);
        fail(`${manager!.name} already reports to ${p.name}, so this would make a loop.`);
        continue;
      }
      next.managerSlackId = manager!.id === p.managerId ? null : manager!.id;
    }
    const title = cleanText(cell(titleCol));
    if (title) next.title = title === p.title ? null : title;
    const department = cleanText(cell(deptCol));
    if (department) next.department = department === p.department ? null : department;
    const before = state.overrides.get(p.id)?.fields ?? null;
    const changed = KEYS.some((k) => (before?.[k] ?? null) !== next[k]);
    results.push({ line: row.line, email, status: changed ? 'ok' : 'unchanged', slackUserId: p.id, managerSlackId: managers.get(p.id) ?? null });
    if (changed) pending.push({ p, next });
  }
  if (apply) for (const { p, next } of pending) saveOverride(p, next, 'person.import');
  return { applied: apply, rows: results, changed: pending.length, errors: results.filter((r) => r.status === 'error').length };
}

function listAdmins(): AdminEntry[] {
  const entries: AdminEntry[] = state.admins.map((a) => ({
    slackUserId: a.slackUserId,
    name: person(a.slackUserId)?.name ?? null,
    avatarUrl: person(a.slackUserId)?.avatarUrl ?? null,
    source: 'role',
    grantedBy: a.grantedBy,
    grantedAt: a.grantedAt,
  }));
  if (state.settings.autoAdminSlackAdmins) {
    for (const p of PEOPLE) {
      if (!p.isSlackAdmin || state.admins.some((a) => a.slackUserId === p.id) || !canBeAdmin(p)) continue;
      entries.push({ slackUserId: p.id, name: p.name, avatarUrl: p.avatarUrl, source: 'slack_admin', grantedBy: null, grantedAt: null });
    }
  }
  return entries;
}

function profileLinkSettings(): ProfileLinkSettings {
  return {
    fieldId: state.profileLink.fieldId,
    fields: [
      { id: 'Xf06ORGCHART', label: 'Org chart' },
      { id: 'Xf02WEBSITE', label: 'Website' },
    ],
    writer: state.profileLink.writer,
    lastRun: state.profileLink.lastRun,
    canFill: true,
  };
}

// Group DMs and channels need the viewer's permission the first time, as in
// the real app. The mock asks in the shell instead of leaving the page.
async function ensureGranted() {
  if (state.granted.has(state.viewer)) return;
  if (!(await hooks.askPermission('actions'))) {
    throw new Fail(403, 'not_granted', 'Org Chart was not allowed to start conversations, so nothing was created.');
  }
  state.granted.add(state.viewer);
}

function visibleOthers(userIds: unknown): string[] {
  if (!Array.isArray(userIds) || !userIds.length) throw new Fail(400, 'invalid', 'Pick at least one person.');
  const visible = new Set(
    effectivePeople()
      .filter((p) => !p.isDeleted && !p.hidden)
      .map((p) => p.slackUserId),
  );
  const others = [...new Set(userIds as string[])].filter((id) => id !== state.viewer);
  if (others.some((id) => !visible.has(id))) throw new Fail(400, 'unknown_people', 'Some of the people you picked are not on the chart.');
  if (!others.length) throw new Fail(400, 'no_people', 'Pick at least one person besides yourself.');
  return others;
}

export function openDm(userId: string): Conversation {
  const id = `D${userId}`;
  const existing = state.conversations.get(id);
  if (existing) return existing;
  const conv: Conversation = { id, kind: 'dm', name: person(userId)?.name ?? userId, members: [state.viewer, userId] };
  state.conversations.set(id, conv);
  return conv;
}

function inviteError(id: string): string | null {
  const type = effectivePeople().find((p) => p.slackUserId === id)?.userType;
  if (type === 'multi_channel_guest') return 'user_is_restricted';
  if (type === 'single_channel_guest') return 'user_is_ultra_restricted';
  if (type === 'slack_connect') return 'external_teams_not_allowed';
  return null;
}

type Handler = (req: { method: string; parts: string[]; query: URLSearchParams; body: any }) => unknown;

const routes: Handler = async ({ method, parts, query, body }) => {
  const route = `${method} /${parts.join('/')}`;
  const [, section, a, b] = parts; // parts[0] is 'api'

  if (route === 'GET /api/me') {
    return { slackUserId: state.viewer, teamId: TEAM_ID, isAdmin: isAdmin(state.viewer) };
  }
  if (route === 'GET /api/chart') {
    requireViewer();
    const nodes = chartNodes();
    const requested = state.focus ?? query.get('user');
    return {
      workspace: { teamId: TEAM_ID, name: WORKSPACE_NAME },
      viewerId: state.viewer,
      focusId: resolveFocus(nodes, state.viewer, requested),
      nodes,
    } satisfies ChartResponse;
  }

  if (section === 'actions') {
    requireViewer();
    if (route === 'GET /api/actions/status') return { granted: state.granted.has(state.viewer) };
    if (route === 'POST /api/actions/conversation') {
      const others = visibleOthers(body.userIds);
      if (others.length > MAX_GROUP_DM_OTHERS) {
        throw new Fail(400, 'too_many', `A group DM holds up to ${MAX_GROUP_DM_OTHERS} people besides you. Create a channel instead.`);
      }
      await ensureGranted();
      if (others.length === 1) return { channelId: openDm(others[0]!).id, teamId: TEAM_ID };
      const members = [state.viewer, ...others].sort();
      const id = `G${members.join('').replace(/U/g, '')}`;
      if (!state.conversations.has(id)) {
        state.conversations.set(id, { id, kind: 'group', name: others.map((o) => person(o)?.name.split(' ')[0]).join(', '), members });
      }
      return { channelId: id, teamId: TEAM_ID };
    }
    if (route === 'POST /api/actions/channel') {
      const name = channelName(String(body.name ?? ''));
      if (!name) throw new Fail(400, 'invalid_name', 'Use letters, numbers, hyphens or underscores in the name.');
      const others = visibleOthers(body.userIds);
      await ensureGranted();
      if (state.channelNames.has(name)) throw new Fail(409, 'name_taken', `#${name} already exists. Pick another name.`);
      const id = `C${String(seq++).padStart(6, '0')}`;
      const notInvited = others.flatMap((o) => {
        const code = inviteError(o);
        return code ? [{ userId: o, reason: inviteReason(code) }] : [];
      });
      const invited = others.filter((o) => !notInvited.some((n) => n.userId === o));
      state.channelNames.add(name);
      state.conversations.set(id, { id, kind: 'channel', name, isPrivate: Boolean(body.isPrivate), members: [state.viewer, ...invited], notInvited });
      return { channelId: id, teamId: TEAM_ID, name, invited, notInvited };
    }
  }

  if (section === 'admin') {
    requireAdmin();
    if (route === 'GET /api/admin/people') return { people: listPeople() };
    if (method === 'PATCH' && a === 'people' && b) {
      updatePerson(decodeURIComponent(b), body);
      return { ok: true };
    }
    if (route === 'POST /api/admin/import') return importCsv(String(body.csv ?? ''), Boolean(body.apply));
    if (route === 'GET /api/admin/admins') return { admins: listAdmins() };
    if (route === 'POST /api/admin/admins') {
      const p = person(body.slackUserId);
      if (!p || !canBeAdmin(p)) throw new Fail(400, 'not_eligible', 'Only active employees and contractors can be admins.');
      if (!state.admins.some((x) => x.slackUserId === p.id)) {
        state.admins.push({ slackUserId: p.id, grantedBy: state.viewer, grantedAt: new Date().toISOString() });
        log('admin.add', p.id, null, { slackUserId: p.id });
      }
      return { admins: listAdmins() };
    }
    if (method === 'DELETE' && a === 'admins' && b) {
      const id = decodeURIComponent(b);
      if (id === state.viewer) throw new Fail(400, 'self', 'In this demo you cannot remove yourself as an admin.');
      state.admins = state.admins.filter((x) => x.slackUserId !== id);
      log('admin.remove', id, { slackUserId: id }, null);
      return { admins: listAdmins() };
    }
    if (route === 'GET /api/admin/settings') return state.settings;
    if (route === 'PATCH /api/admin/settings') {
      const before = { ...state.settings };
      state.settings = { ...state.settings, ...body };
      log('settings.update', null, before, { ...state.settings });
      return state.settings;
    }
    if (route === 'GET /api/admin/audit') return { entries: state.audit, next: null };
    if (route === 'GET /api/admin/sync') return { runs: state.syncRuns, canStart: Boolean(state.syncRuns[0]?.finishedAt) };
    if (route === 'POST /api/admin/sync') {
      const run: SyncRunInfo = { kind: 'full', startedAt: new Date().toISOString(), finishedAt: null, counts: null, errorCount: 0 };
      state.syncRuns.unshift(run);
      setTimeout(() => {
        run.finishedAt = new Date().toISOString();
        run.counts = { members: 27, slackConnect: 2 };
      }, 2500);
      return { ok: true };
    }
    if (route === 'GET /api/admin/profile-link') return profileLinkSettings();
    if (route === 'PATCH /api/admin/profile-link') {
      state.profileLink.fieldId = body.fieldId ?? null;
      log('profile_link.field', null, null, { fieldId: state.profileLink.fieldId });
      return profileLinkSettings();
    }
    if (route === 'POST /api/admin/profile-link/fill') {
      const run: SyncRunInfo = { kind: 'profile_links', startedAt: new Date().toISOString(), finishedAt: null, counts: null, errorCount: 0 };
      state.profileLink.lastRun = run;
      setTimeout(() => {
        run.finishedAt = new Date().toISOString();
        run.counts = { written: 1, unchanged: 24 };
      }, 2500);
      return { ok: true };
    }
    if (route === 'DELETE /api/admin/profile-link/writer') {
      state.profileLink.writer = null;
      log('profile_link.disconnect', null, { writer: 'U001' }, null);
      return profileLinkSettings();
    }
  }
  throw new Fail(404, 'not_found', `The demo has no ${route}.`);
};

// The admin's "Connect a Slack admin account" for profile links.
export async function connectProfileWriter(): Promise<boolean> {
  if (!(await hooks.askPermission('profile'))) return false;
  state.profileLink.writer = { slackUserId: state.viewer, name: person(state.viewer)?.name ?? null };
  log('profile_link.connect', null, null, { writer: state.viewer });
  return true;
}

export function setHooks(h: DemoHooks) {
  hooks = h;
}

export function installMockApi() {
  const realFetch = window.fetch.bind(window);
  window.fetch = async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = new URL(typeof input === 'string' ? input : input instanceof URL ? input.href : input.url, 'https://demo.invalid');
    if (!url.pathname.startsWith('/api/')) return realFetch(input, init);
    const method = (init?.method ?? 'GET').toUpperCase();
    const body = init?.body ? JSON.parse(String(init.body)) : {};
    await new Promise((r) => setTimeout(r, 120));
    try {
      const data = await routes({ method, parts: url.pathname.split('/').filter(Boolean), query: url.searchParams, body });
      if (method !== 'GET') hooks.onChange();
      return json(200, data);
    } catch (err) {
      if (err instanceof Fail) return json(err.status, { error: err.code, message: err.message });
      console.error(err);
      return json(500, { error: 'demo_error', message: String(err) });
    }
  };
}

const json = (status: number, data: unknown) =>
  new Response(JSON.stringify(data), { status, headers: { 'Content-Type': 'application/json' } });
