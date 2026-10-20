import { describe, expect, it } from 'vitest';
import type { ChartNode } from '../src/shared/chart.js';
import { ancestorIds, filterNodes } from '../src/shared/filter.js';

const n = (id: string, parentId: string | null, extra: Partial<ChartNode> = {}): ChartNode => ({
  id,
  parentId,
  kind: 'person',
  name: id,
  descendants: 0,
  ...extra,
});

describe('filterNodes', () => {
  const nodes = [
    n('__company', null, { kind: 'company' }),
    n('CEO', '__company'),
    n('AGENCY', 'CEO', { badge: 'contractor' }),
    n('X', 'AGENCY'),
    n('__external', '__company', { kind: 'group' }),
    n('GUEST', '__external', { badge: 'guest' }),
  ];

  it('removes filtered people and reattaches their reports', () => {
    const out = filterNodes(nodes, (p) => !p.badge);
    expect(out.map((p) => p.id)).toEqual(['__company', 'CEO', 'X']);
    expect(out.find((p) => p.id === 'X')?.parentId).toBe('CEO');
  });

  it('keeps everything when nothing is filtered', () => {
    expect(filterNodes(nodes, () => true)).toHaveLength(nodes.length);
  });
});

describe('ancestorIds', () => {
  it('walks up to the root', () => {
    expect(ancestorIds([n('R', null), n('A', 'R'), n('B', 'A')], 'B')).toEqual(['A', 'R']);
  });
});
