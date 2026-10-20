import { badgeFor, type ChartNode, type PersonType } from '../../shared/chart.js';

export interface EffectivePerson {
  slackUserId: string;
  name: string;
  title: string | null;
  department: string | null;
  avatarUrl: string | null;
  userType: PersonType;
  externalOrg: string | null;
  managerSlackId: string | null;
  hidden: boolean;
  isDeleted: boolean;
  sortOrder: number | null;
}

export const COMPANY_ID = '__company';
export const EXTERNAL_GROUP_ID = '__external';
export const UNPLACED_GROUP_ID = '__unplaced';

// Builds the nodes d3-org-chart needs: one tree under a company root.
//
// - Bots, deactivated and hidden people are left out. Their reports move up
//   to the next visible manager and are flagged.
// - Reporting loops in Slack data (A reports to B, B to A) are broken at one
//   person, who becomes a root and is flagged.
// - Roots with reports hang under the company. Lone external people go in an
//   "External people" group, lone internal people in "Not placed yet", so a
//   company with an empty Manager field still gets a readable chart.
export function buildChart(people: EffectivePerson[], companyName: string | null): ChartNode[] {
  const byId = new Map(people.map((p) => [p.slackUserId, p]));
  const visible = people.filter(isVisible);
  const visibleIds = new Set(visible.map((p) => p.slackUserId));

  const parent = new Map<string, string | null>();
  const rerouted = new Set<string>();
  for (const p of visible) {
    let managerId = p.managerSlackId;
    const walked = new Set<string>([p.slackUserId]);
    while (managerId && !visibleIds.has(managerId)) {
      const hiddenManager = byId.get(managerId);
      if (!hiddenManager || walked.has(managerId)) {
        managerId = null;
        break;
      }
      walked.add(managerId);
      rerouted.add(p.slackUserId);
      managerId = hiddenManager.managerSlackId;
    }
    if (managerId === p.slackUserId) managerId = null;
    parent.set(p.slackUserId, managerId ?? null);
  }

  const cycleBroken = breakCycles(parent);

  const children = new Map<string | null, string[]>();
  for (const [id, pid] of parent) {
    const list = children.get(pid) ?? [];
    list.push(id);
    children.set(pid, list);
  }

  const descendants = new Map<string, number>();
  const countBelow = (id: string): number => {
    const cached = descendants.get(id);
    if (cached !== undefined) return cached;
    const kids = children.get(id) ?? [];
    const total = kids.reduce((sum, k) => sum + 1 + countBelow(k), 0);
    descendants.set(id, total);
    return total;
  };

  const roots = children.get(null) ?? [];
  const rootParent = (id: string): string => {
    if ((children.get(id) ?? []).length > 0) return COMPANY_ID;
    return badgeFor(byId.get(id)!.userType) ? EXTERNAL_GROUP_ID : UNPLACED_GROUP_ID;
  };

  const personNodes: ChartNode[] = visible.map((p) => {
    const pid = parent.get(p.slackUserId) ?? rootParent(p.slackUserId);
    return {
      id: p.slackUserId,
      parentId: pid,
      kind: 'person',
      name: p.name,
      title: p.title,
      department: p.department,
      avatarUrl: p.avatarUrl,
      userType: p.userType,
      badge: badgeFor(p.userType),
      externalOrg: p.externalOrg,
      descendants: countBelow(p.slackUserId),
      ...(rerouted.has(p.slackUserId) ? { rerouted: true } : {}),
      ...(cycleBroken.has(p.slackUserId) ? { cycleBroken: true } : {}),
    };
  });
  personNodes.sort(compareNodes(byId));

  const groupCounts = { [EXTERNAL_GROUP_ID]: 0, [UNPLACED_GROUP_ID]: 0, [COMPANY_ID]: 0 };
  for (const r of roots) {
    const g = rootParent(r) as keyof typeof groupCounts;
    groupCounts[g] += 1 + (g === COMPANY_ID ? countBelow(r) : 0);
  }

  const nodes: ChartNode[] = [];
  const groups: ChartNode[] = [];
  if (groupCounts[UNPLACED_GROUP_ID]) {
    groups.push({
      id: UNPLACED_GROUP_ID,
      parentId: COMPANY_ID,
      kind: 'group',
      name: 'Not placed yet',
      descendants: groupCounts[UNPLACED_GROUP_ID],
    });
  }
  if (groupCounts[EXTERNAL_GROUP_ID]) {
    groups.push({
      id: EXTERNAL_GROUP_ID,
      parentId: COMPANY_ID,
      kind: 'group',
      name: 'External people',
      descendants: groupCounts[EXTERNAL_GROUP_ID],
    });
  }
  nodes.push({
    id: COMPANY_ID,
    parentId: null,
    kind: 'company',
    name: companyName ?? 'Company',
    descendants: visible.length,
  });
  // People first so the real hierarchy sits left of the catch-all groups.
  nodes.push(...personNodes, ...groups);
  return nodes;
}

// Picks where the chart opens: the requested person if they are on it,
// otherwise the viewer, otherwise the company root.
export function resolveFocus(nodes: ChartNode[], viewerId: string, requested?: string | null): string {
  const ids = new Set(nodes.filter((n) => n.kind === 'person').map((n) => n.id));
  if (requested && ids.has(requested)) return requested;
  if (ids.has(viewerId)) return viewerId;
  return COMPANY_ID;
}

// The people around someone: manager chain (nearest first), peers, reports.
// App Home shows this as a list.
export function neighborhood(nodes: ChartNode[], focusId: string) {
  const byId = new Map(nodes.map((n) => [n.id, n]));
  const focus = byId.get(focusId);
  if (!focus || focus.kind !== 'person') return null;
  const managers: ChartNode[] = [];
  let cursor = focus.parentId ? byId.get(focus.parentId) : undefined;
  while (cursor && cursor.kind === 'person') {
    managers.push(cursor);
    cursor = cursor.parentId ? byId.get(cursor.parentId) : undefined;
  }
  const manager = managers[0];
  const peers = manager
    ? nodes.filter((n) => n.kind === 'person' && n.parentId === manager.id && n.id !== focusId)
    : [];
  const reports = nodes.filter((n) => n.parentId === focusId);
  return { person: focus, managers, peers, reports };
}

function isVisible(p: EffectivePerson): boolean {
  return !p.isDeleted && !p.hidden && p.userType !== 'bot';
}

// Mutates parent so it holds no loops. Returns the people cut loose.
function breakCycles(parent: Map<string, string | null>): Set<string> {
  const broken = new Set<string>();
  const state = new Map<string, 'visiting' | 'done'>();
  for (const start of [...parent.keys()].sort()) {
    const path: string[] = [];
    let id: string | null = start;
    while (id && !state.has(id)) {
      state.set(id, 'visiting');
      path.push(id);
      id = parent.get(id) ?? null;
    }
    if (id && state.get(id) === 'visiting') {
      // id is on the current path, so path[from..] is a loop. Cut it at the
      // smallest id so the result does not depend on iteration order.
      const loop = path.slice(path.indexOf(id)).sort();
      const cut = loop[0]!;
      parent.set(cut, null);
      broken.add(cut);
    }
    for (const p of path) state.set(p, 'done');
  }
  return broken;
}

function compareNodes(byId: Map<string, EffectivePerson>) {
  return (a: ChartNode, b: ChartNode) => {
    const sa = byId.get(a.id)?.sortOrder ?? Number.MAX_SAFE_INTEGER;
    const sb = byId.get(b.id)?.sortOrder ?? Number.MAX_SAFE_INTEGER;
    return sa - sb || a.name.localeCompare(b.name);
  };
}
