import type { ChartNode } from './chart.js';

// Hides nodes the viewer filtered out. Anyone who reported to a hidden node
// moves up to the hidden node's nearest visible manager, so the tree stays
// whole. Empty groups disappear too.
export function filterNodes(nodes: ChartNode[], keep: (n: ChartNode) => boolean): ChartNode[] {
  const byId = new Map(nodes.map((n) => [n.id, n]));
  const kept = new Set(nodes.filter((n) => n.kind !== 'person' || keep(n)).map((n) => n.id));

  const visibleParent = (id: string | null): string | null => {
    let cursor = id;
    while (cursor && !kept.has(cursor)) cursor = byId.get(cursor)?.parentId ?? null;
    return cursor;
  };

  const result = nodes
    .filter((n) => kept.has(n.id))
    .map((n) => {
      const parentId = visibleParent(n.parentId);
      return parentId === n.parentId ? n : { ...n, parentId };
    });

  const hasChild = new Set(result.map((n) => n.parentId));
  return result.filter((n) => n.kind !== 'group' || hasChild.has(n.id));
}

// The chain from a node up to the root, root last. Used to expand the path
// to someone found through search.
export function ancestorIds(nodes: ChartNode[], id: string): string[] {
  const byId = new Map(nodes.map((n) => [n.id, n]));
  const out: string[] = [];
  let cursor = byId.get(id)?.parentId ?? null;
  while (cursor) {
    out.push(cursor);
    cursor = byId.get(cursor)?.parentId ?? null;
  }
  return out;
}
