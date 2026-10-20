import { Prisma, type Person, type PersonOverride } from '@prisma/client';
import type {
  AdminEntry,
  AdminPerson,
  AuditEntry,
  ImportResponse,
  ImportRowResult,
  OverrideFields,
  PersonIssue,
  PersonPatch,
  ProfileLinkSettings,
  SyncRunInfo,
  WorkspaceSettings,
} from '../../shared/admin.js';
import type { Tx } from '../db.js';
import { buildChart, UNPLACED_GROUP_ID } from '../chart/tree.js';
import { loadEffectivePeople } from '../chart/service.js';
import { isExternal } from '../slack/classify.js';
import { canBeAdmin } from './access.js';
import { parseCsv } from './csv.js';

// A refusal the admin page can show as is.
export class AdminError extends Error {
  constructor(
    readonly status: number,
    readonly code: string,
    message: string,
  ) {
    super(message);
  }
}

const OVERRIDE_KEYS = [
  'managerSlackId',
  'userType',
  'externalOrg',
  'title',
  'department',
  'hidden',
  'sortOrder',
] as const satisfies readonly (keyof OverrideFields)[];

const EMPTY_OVERRIDE: OverrideFields = {
  managerSlackId: null,
  userType: null,
  externalOrg: null,
  title: null,
  department: null,
  hidden: null,
  sortOrder: null,
};

type PersonWithOverride = Person & { override: PersonOverride | null };

function overrideFields(o: PersonOverride | null): OverrideFields | null {
  if (!o) return null;
  return {
    managerSlackId: o.managerSlackId,
    userType: o.userType,
    externalOrg: o.externalOrg,
    title: o.title,
    department: o.department,
    hidden: o.hidden,
    sortOrder: o.sortOrder,
  };
}

// The manager the chart uses: the override when set ('' means none),
// otherwise Slack's.
function effectiveManager(slackManagerId: string | null, override: { managerSlackId: string | null } | null) {
  const value = override?.managerSlackId ?? slackManagerId;
  return value ? value : null;
}

// True when following managers up from `start` comes back to `start`.
// Loops elsewhere in the data stop the walk without counting.
export function createsLoop(managerOf: Map<string, string | null>, start: string): boolean {
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

// Every person with Slack's values, the admin's overrides, what the chart
// shows, and anything that needs an admin's attention.
export async function listPeople(tx: Tx, tenant: string): Promise<AdminPerson[]> {
  const [people, roles, workspace, effective] = await Promise.all([
    tx.person.findMany({ include: { override: true }, orderBy: { name: 'asc' } }),
    tx.adminRole.findMany({ select: { slackUserId: true } }),
    tx.workspace.findUniqueOrThrow({ where: { teamId: tenant }, select: { name: true, autoAdminSlackAdmins: true } }),
    loadEffectivePeople(tx),
  ]);
  const nodes = new Map(buildChart(effective, workspace.name).map((n) => [n.id, n]));
  const byId = new Map(people.map((p) => [p.slackUserId, p]));
  const known = new Set(byId.keys());
  const roleIds = new Set(roles.map((r) => r.slackUserId));
  const reports = new Map<string, number>();
  for (const n of nodes.values()) {
    if (n.kind === 'person' && n.parentId) reports.set(n.parentId, (reports.get(n.parentId) ?? 0) + 1);
  }

  return people
    .filter((p) => p.userType !== 'bot')
    .map((p) => {
      const o = p.override;
      const node = nodes.get(p.slackUserId);
      const managerId = effectiveManager(p.slackManagerId, o);
      const issues: PersonIssue[] = [];
      // A hidden manager was the admin's choice; a deactivated one needs fixing.
      if (node?.rerouted && managerId && byId.get(managerId)?.isDeleted) issues.push('rerouted');
      if (node?.cycleBroken) issues.push('loop');
      if (node?.parentId === UNPLACED_GROUP_ID) issues.push('unplaced');
      if (managerId && !known.has(managerId) && !p.isDeleted) issues.push('unknown_manager');
      const isAdmin =
        canBeAdmin(p) && (roleIds.has(p.slackUserId) || (workspace.autoAdminSlackAdmins && p.isSlackAdmin));
      return {
        slackUserId: p.slackUserId,
        name: p.name,
        email: p.email,
        avatarUrl: p.avatarUrl,
        isDeleted: p.isDeleted,
        isSlackAdmin: p.isSlackAdmin,
        isAdmin,
        slack: {
          managerSlackId: p.slackManagerId,
          userType: p.userType,
          externalOrg: p.externalOrg,
          title: p.title,
          department: p.department,
        },
        override: overrideFields(o),
        effective: {
          managerSlackId: managerId,
          userType: o?.userType ?? p.userType,
          externalOrg: o?.externalOrg ?? p.externalOrg,
          title: o?.title ?? p.title,
          department: o?.department ?? p.department,
          hidden: o?.hidden ?? false,
        },
        chartParentId: node?.kind === 'person' && node.parentId && known.has(node.parentId) ? node.parentId : null,
        reports: reports.get(p.slackUserId) ?? 0,
        issues,
        updatedBy: o?.updatedBy ?? null,
        updatedAt: o?.updatedAt.toISOString() ?? null,
      };
    });
}

// Text fields: trimmed, and blank means "use Slack's value".
function cleanText(value: string | null | undefined, max: number): string | null | undefined {
  if (value === undefined || value === null) return value;
  const trimmed = value.trim().slice(0, max);
  return trimmed === '' ? null : trimmed;
}

function normalizePatch(patch: PersonPatch): PersonPatch {
  const out: PersonPatch = { ...patch };
  if ('title' in patch) out.title = cleanText(patch.title, 200);
  if ('department' in patch) out.department = cleanText(patch.department, 200);
  if ('externalOrg' in patch) out.externalOrg = cleanText(patch.externalOrg, 200);
  if (typeof patch.managerSlackId === 'string') out.managerSlackId = patch.managerSlackId.trim();
  return out;
}

async function managerMap(tx: Tx): Promise<Map<string, string | null>> {
  const rows = await tx.person.findMany({
    select: { slackUserId: true, slackManagerId: true, override: { select: { managerSlackId: true } } },
  });
  return new Map(rows.map((r) => [r.slackUserId, effectiveManager(r.slackManagerId, r.override)]));
}

async function findPerson(tx: Tx, tenant: string, slackUserId: string): Promise<PersonWithOverride> {
  const person = await tx.person.findUnique({
    where: { teamId_slackUserId: { teamId: tenant, slackUserId } },
    include: { override: true },
  });
  if (!person) throw new AdminError(404, 'not_found', 'That person is not in this workspace.');
  return person;
}

function checkManager(target: Person, manager: Person | undefined | null) {
  if (!manager) throw new AdminError(400, 'unknown_manager', 'That manager is not in this workspace.');
  if (manager.slackUserId === target.slackUserId) {
    throw new AdminError(400, 'self_manager', 'Someone cannot be their own manager.');
  }
  if (manager.isDeleted) throw new AdminError(400, 'manager_deactivated', `${manager.name} is deactivated in Slack.`);
  if (manager.userType === 'bot') throw new AdminError(400, 'manager_bot', 'A bot cannot be a manager.');
}

// Writes the override row (or removes it when nothing is overridden) and
// records the change. Returns false when nothing changed.
async function saveOverride(
  tx: Tx,
  tenant: string,
  actor: string,
  person: PersonWithOverride,
  next: OverrideFields,
  action: string,
): Promise<boolean> {
  const before = overrideFields(person.override);
  const same = OVERRIDE_KEYS.every((k) => (before?.[k] ?? null) === next[k]);
  if (same) return false;
  const empty = OVERRIDE_KEYS.every((k) => next[k] === null);
  if (empty) {
    await tx.personOverride.deleteMany({ where: { personId: person.id } });
  } else {
    await tx.personOverride.upsert({
      where: { personId: person.id },
      create: { personId: person.id, teamId: tenant, ...next, updatedBy: actor },
      update: { ...next, updatedBy: actor },
    });
  }
  await tx.auditLog.create({
    data: {
      teamId: tenant,
      actor,
      action,
      personId: person.id,
      before: before ? (before as unknown as Prisma.InputJsonObject) : Prisma.DbNull,
      after: empty ? Prisma.DbNull : (next as unknown as Prisma.InputJsonObject),
    },
  });
  return true;
}

// Applies an admin's edit to one person. Fields left out stay as they are;
// a field set to null goes back to Slack's value.
export async function updatePerson(
  tx: Tx,
  tenant: string,
  actor: string,
  slackUserId: string,
  rawPatch: PersonPatch,
): Promise<void> {
  const patch = normalizePatch(rawPatch);
  const person = await findPerson(tx, tenant, slackUserId);
  const current = overrideFields(person.override) ?? EMPTY_OVERRIDE;
  const next: OverrideFields = { ...current };
  for (const k of OVERRIDE_KEYS) if (k in patch) (next as unknown as Record<string, unknown>)[k] = patch[k] ?? null;

  // Slack says this person is a guest or from another company. An admin may
  // relabel them contractor or external, but never make them an employee,
  // which would let them see the chart and become an admin.
  if (next.userType === 'employee' && isExternal(person.userType)) {
    throw new AdminError(400, 'cannot_make_employee', `Slack lists ${person.name} as a guest or external person.`);
  }

  if ('managerSlackId' in patch && next.managerSlackId) {
    const manager = await tx.person.findUnique({
      where: { teamId_slackUserId: { teamId: tenant, slackUserId: next.managerSlackId } },
    });
    checkManager(person, manager);
    const managers = await managerMap(tx);
    managers.set(person.slackUserId, next.managerSlackId);
    if (createsLoop(managers, person.slackUserId)) {
      throw new AdminError(
        409,
        'reporting_loop',
        `${manager!.name} already reports to ${person.name}, directly or further down. Move ${manager!.name} first.`,
      );
    }
  }
  await saveOverride(tx, tenant, actor, person, next, 'person.update');
}

const MAX_IMPORT_ROWS = 5000;

// Reporting lines from a CSV with the columns email and manager_email, plus
// optional title and department. A blank cell leaves that field as it is.
// With apply false nothing is written, so the admin page can show a preview.
export async function importCsv(
  tx: Tx,
  tenant: string,
  actor: string,
  csv: string,
  apply: boolean,
): Promise<ImportResponse> {
  const rows = parseCsv(csv);
  const header = rows.shift();
  if (!header) throw new AdminError(400, 'empty_csv', 'The file is empty.');
  const columns = header.cells.map((c) => c.trim().toLowerCase().replace(/[\s-]+/g, '_'));
  const col = (name: string) => columns.indexOf(name);
  const emailCol = col('email');
  const managerCol = col('manager_email');
  if (emailCol < 0 || managerCol < 0) {
    throw new AdminError(400, 'bad_header', 'The first line must name the columns email and manager_email.');
  }
  if (rows.length > MAX_IMPORT_ROWS) {
    throw new AdminError(400, 'too_many_rows', `Import at most ${MAX_IMPORT_ROWS} people at a time.`);
  }
  const titleCol = col('title');
  const deptCol = col('department');

  const people = await tx.person.findMany({ include: { override: true } });
  const byEmail = new Map<string, PersonWithOverride>();
  for (const p of people) {
    if (!p.email || p.userType === 'bot') continue;
    const key = p.email.toLowerCase();
    // Prefer the active account when an address was reused.
    if (!byEmail.has(key) || byEmail.get(key)!.isDeleted) byEmail.set(key, p);
  }
  const managers = new Map(people.map((p) => [p.slackUserId, effectiveManager(p.slackManagerId, p.override)]));

  const results: ImportRowResult[] = [];
  const pending: { person: PersonWithOverride; next: OverrideFields }[] = [];
  const seen = new Set<string>();
  for (const row of rows) {
    const cell = (i: number) => (i >= 0 ? (row.cells[i] ?? '').trim() : '');
    const email = cell(emailCol);
    const fail = (message: string) => results.push({ line: row.line, email, status: 'error', message });
    const person = byEmail.get(email.toLowerCase());
    if (!email) {
      fail('No email.');
      continue;
    }
    if (!person || person.isDeleted) {
      fail('No active Slack member has this email.');
      continue;
    }
    if (seen.has(person.slackUserId)) {
      fail('This person is already in the file.');
      continue;
    }
    seen.add(person.slackUserId);

    const next: OverrideFields = { ...(overrideFields(person.override) ?? EMPTY_OVERRIDE) };
    const managerEmail = cell(managerCol);
    if (managerEmail) {
      const manager = byEmail.get(managerEmail.toLowerCase());
      try {
        checkManager(person, manager);
      } catch (err) {
        fail(err instanceof AdminError ? err.message.replace('That manager', managerEmail) : String(err));
        continue;
      }
      const previous = managers.get(person.slackUserId) ?? null;
      managers.set(person.slackUserId, manager!.slackUserId);
      if (createsLoop(managers, person.slackUserId)) {
        managers.set(person.slackUserId, previous);
        fail(`${manager!.name} already reports to ${person.name}, so this would make a loop.`);
        continue;
      }
      // Matching Slack needs no override.
      next.managerSlackId = manager!.slackUserId === person.slackManagerId ? null : manager!.slackUserId;
    }
    const title = cleanText(cell(titleCol), 200);
    if (title) next.title = title === person.title ? null : title;
    const department = cleanText(cell(deptCol), 200);
    if (department) next.department = department === person.department ? null : department;

    const before = overrideFields(person.override);
    const changed = OVERRIDE_KEYS.some((k) => (before?.[k] ?? null) !== next[k]);
    results.push({
      line: row.line,
      email,
      status: changed ? 'ok' : 'unchanged',
      slackUserId: person.slackUserId,
      managerSlackId: managers.get(person.slackUserId) ?? null,
    });
    if (changed) pending.push({ person, next });
  }

  if (apply) {
    for (const { person, next } of pending) await saveOverride(tx, tenant, actor, person, next, 'person.import');
  }
  return {
    applied: apply,
    rows: results,
    changed: pending.length,
    errors: results.filter((r) => r.status === 'error').length,
  };
}

export async function listAdmins(tx: Tx): Promise<AdminEntry[]> {
  const [roles, workspace] = await Promise.all([
    tx.adminRole.findMany({ orderBy: { grantedAt: 'asc' } }),
    tx.workspace.findFirstOrThrow({ select: { autoAdminSlackAdmins: true } }),
  ]);
  const roleIds = roles.map((r) => r.slackUserId);
  const people = await tx.person.findMany({
    where: { OR: [{ slackUserId: { in: roleIds } }, ...(workspace.autoAdminSlackAdmins ? [{ isSlackAdmin: true }] : [])] },
    include: { override: true },
  });
  const byId = new Map(people.map((p) => [p.slackUserId, p]));
  const entries: AdminEntry[] = roles.map((r) => ({
    slackUserId: r.slackUserId,
    name: byId.get(r.slackUserId)?.name ?? null,
    avatarUrl: byId.get(r.slackUserId)?.avatarUrl ?? null,
    source: 'role',
    grantedBy: r.grantedBy,
    grantedAt: r.grantedAt.toISOString(),
  }));
  if (workspace.autoAdminSlackAdmins) {
    for (const p of people) {
      if (!p.isSlackAdmin || roleIds.includes(p.slackUserId) || !canBeAdmin(p)) continue;
      entries.push({
        slackUserId: p.slackUserId,
        name: p.name,
        avatarUrl: p.avatarUrl,
        source: 'slack_admin',
        grantedBy: null,
        grantedAt: null,
      });
    }
  }
  return entries;
}

export async function addAdmin(tx: Tx, tenant: string, actor: string, slackUserId: string): Promise<void> {
  const person = await findPerson(tx, tenant, slackUserId);
  if (!canBeAdmin(person)) {
    throw new AdminError(
      400,
      'not_eligible',
      person.isDeleted
        ? `${person.name} is deactivated in Slack.`
        : 'Guests, Slack Connect people, contractors and external people cannot be admins.',
    );
  }
  const existing = await tx.adminRole.findUnique({ where: { teamId_slackUserId: { teamId: tenant, slackUserId } } });
  if (existing) return;
  await tx.adminRole.create({ data: { teamId: tenant, slackUserId, grantedBy: actor } });
  await tx.auditLog.create({
    data: { teamId: tenant, actor, action: 'admin.add', personId: person.id, after: { slackUserId } },
  });
}

export async function removeAdmin(tx: Tx, tenant: string, actor: string, slackUserId: string): Promise<void> {
  const role = await tx.adminRole.findUnique({ where: { teamId_slackUserId: { teamId: tenant, slackUserId } } });
  if (!role) {
    throw new AdminError(
      400,
      'not_a_role',
      'This person is an admin because they are a Slack owner or admin. Turn off that setting to remove them.',
    );
  }
  // Lock the workspace's admin rows so two admins removing each other at
  // the same moment cannot both succeed and leave nobody.
  await tx.$queryRaw`SELECT 1 FROM admin_role WHERE team_id = ${tenant} FOR UPDATE`;
  const count = await tx.adminRole.count();
  if (count <= 1) {
    throw new AdminError(400, 'last_admin', 'Add another admin first. A workspace needs at least one.');
  }
  await tx.adminRole.delete({ where: { teamId_slackUserId: { teamId: tenant, slackUserId } } });
  const person = await tx.person.findUnique({ where: { teamId_slackUserId: { teamId: tenant, slackUserId } } });
  await tx.auditLog.create({
    data: { teamId: tenant, actor, action: 'admin.remove', personId: person?.id ?? null, before: { slackUserId } },
  });
}

export async function getSettings(tx: Tx, tenant: string): Promise<WorkspaceSettings> {
  return tx.workspace.findUniqueOrThrow({
    where: { teamId: tenant },
    select: { allowGuestViewers: true, autoAdminSlackAdmins: true },
  });
}

export async function updateSettings(
  tx: Tx,
  tenant: string,
  actor: string,
  patch: Partial<WorkspaceSettings>,
): Promise<WorkspaceSettings> {
  const before = await getSettings(tx, tenant);
  const after = await tx.workspace.update({
    where: { teamId: tenant },
    data: patch,
    select: { allowGuestViewers: true, autoAdminSlackAdmins: true },
  });
  if (before.allowGuestViewers !== after.allowGuestViewers || before.autoAdminSlackAdmins !== after.autoAdminSlackAdmins) {
    await tx.auditLog.create({ data: { teamId: tenant, actor, action: 'settings.update', before: { ...before }, after: { ...after } } });
  }
  return after;
}

export async function listAudit(tx: Tx, beforeId: bigint | null, limit = 50): Promise<AuditEntry[]> {
  const rows = await tx.auditLog.findMany({
    where: beforeId ? { id: { lt: beforeId } } : {},
    orderBy: { id: 'desc' },
    take: limit,
  });
  const actorIds = [...new Set(rows.map((r) => r.actor))];
  const personIds = [...new Set(rows.map((r) => r.personId).filter((id): id is string => Boolean(id)))];
  const [actors, people] = await Promise.all([
    tx.person.findMany({ where: { slackUserId: { in: actorIds } }, select: { slackUserId: true, name: true } }),
    tx.person.findMany({ where: { id: { in: personIds } }, select: { id: true, name: true } }),
  ]);
  const actorName = new Map(actors.map((a) => [a.slackUserId, a.name]));
  const personName = new Map(people.map((p) => [p.id, p.name]));
  return rows.map((r) => ({
    id: r.id.toString(),
    actor: r.actor,
    actorName: actorName.get(r.actor) ?? null,
    action: r.action,
    personId: r.personId,
    personName: r.personId ? (personName.get(r.personId) ?? null) : null,
    before: r.before,
    after: r.after,
    at: r.at.toISOString(),
  }));
}

export async function listSyncRuns(tx: Tx, limit = 10): Promise<SyncRunInfo[]> {
  const rows = await tx.syncRun.findMany({ orderBy: { startedAt: 'desc' }, take: limit });
  return rows.map((r) => ({
    kind: r.kind,
    startedAt: r.startedAt.toISOString(),
    finishedAt: r.finishedAt?.toISOString() ?? null,
    counts: r.counts,
    errorCount: Array.isArray(r.errors) ? r.errors.length : r.errors ? 1 : 0,
  }));
}

export type LinkField = { id: string; label: string };

export async function getProfileLink(tx: Tx, tenant: string, fields: LinkField[], canFill: boolean): Promise<ProfileLinkSettings> {
  const ws = await tx.workspace.findUniqueOrThrow({
    where: { teamId: tenant },
    select: { profileLinkFieldId: true, profileWriterId: true, profileWriterToken: true },
  });
  const writerId = ws.profileWriterToken ? ws.profileWriterId : null;
  const [writer, run] = await Promise.all([
    writerId ? tx.person.findUnique({ where: { teamId_slackUserId: { teamId: tenant, slackUserId: writerId } } }) : null,
    tx.syncRun.findFirst({ where: { kind: 'profile_links' }, orderBy: { startedAt: 'desc' } }),
  ]);
  return {
    fieldId: ws.profileLinkFieldId,
    fields,
    writer: writerId ? { slackUserId: writerId, name: writer?.name ?? null } : null,
    lastRun: run
      ? {
          kind: run.kind,
          startedAt: run.startedAt.toISOString(),
          finishedAt: run.finishedAt?.toISOString() ?? null,
          counts: run.counts,
          errorCount: Array.isArray(run.errors) ? run.errors.length : run.errors ? 1 : 0,
        }
      : null,
    canFill,
  };
}

// Picks which link field to fill. Choosing a different field rewrites every
// link on the next fill, because profile_link remembers the field per person.
export async function setProfileLinkField(tx: Tx, tenant: string, actor: string, fieldId: string | null, fields: LinkField[]) {
  if (fieldId && !fields.some((f) => f.id === fieldId)) {
    throw new AdminError(400, 'unknown_field', 'That field is not a link field in this workspace.');
  }
  const before = await tx.workspace.findUniqueOrThrow({ where: { teamId: tenant }, select: { profileLinkFieldId: true } });
  if (before.profileLinkFieldId === fieldId) return;
  await tx.workspace.update({ where: { teamId: tenant }, data: { profileLinkFieldId: fieldId } });
  await tx.auditLog.create({
    data: {
      teamId: tenant,
      actor,
      action: 'profile_link.field',
      before: { fieldId: before.profileLinkFieldId },
      after: { fieldId },
    },
  });
}

// Forgets the writer token. Returns it (encrypted) so the caller can revoke it.
export async function disconnectProfileWriter(tx: Tx, tenant: string, actor: string): Promise<string | null> {
  const ws = await tx.workspace.findUniqueOrThrow({
    where: { teamId: tenant },
    select: { profileWriterId: true, profileWriterToken: true },
  });
  if (!ws.profileWriterToken) return null;
  await tx.workspace.update({ where: { teamId: tenant }, data: { profileWriterId: null, profileWriterToken: null } });
  await tx.auditLog.create({
    data: { teamId: tenant, actor, action: 'profile_link.disconnect', before: { writer: ws.profileWriterId } },
  });
  return ws.profileWriterToken;
}
