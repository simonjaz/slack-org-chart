import { describe, expect, it } from 'vitest';
import {
  buildChart,
  COMPANY_ID,
  EXTERNAL_GROUP_ID,
  neighborhood,
  resolveFocus,
  UNPLACED_GROUP_ID,
  type EffectivePerson,
} from '../src/server/chart/tree.js';

function person(id: string, managerSlackId: string | null, extra: Partial<EffectivePerson> = {}): EffectivePerson {
  return {
    slackUserId: id,
    name: extra.name ?? id,
    title: null,
    department: null,
    avatarUrl: null,
    userType: 'employee',
    externalOrg: null,
    managerSlackId,
    hidden: false,
    isDeleted: false,
    sortOrder: null,
    ...extra,
  };
}

const parentOf = (nodes: ReturnType<typeof buildChart>, id: string) => nodes.find((n) => n.id === id)?.parentId;

describe('buildChart', () => {
  const company = [
    person('CEO', null),
    person('CTO', 'CEO'),
    person('CFO', 'CEO'),
    person('ENG1', 'CTO'),
    person('ENG2', 'CTO'),
    person('FIN1', 'CFO'),
  ];

  it('builds one tree under a company root', () => {
    const nodes = buildChart(company, 'Acme');
    expect(nodes[0]).toMatchObject({ id: COMPANY_ID, parentId: null, name: 'Acme', kind: 'company' });
    expect(parentOf(nodes, 'CEO')).toBe(COMPANY_ID);
    expect(parentOf(nodes, 'ENG1')).toBe('CTO');
    expect(nodes.find((n) => n.id === 'CEO')?.descendants).toBe(5);
    expect(nodes.find((n) => n.id === 'CTO')?.descendants).toBe(2);
    expect(nodes.filter((n) => n.parentId === null)).toHaveLength(1);
  });

  it('moves reports of a deactivated manager up to the next visible manager', () => {
    const people = company.map((p) => (p.slackUserId === 'CTO' ? { ...p, isDeleted: true } : p));
    const nodes = buildChart(people, 'Acme');
    expect(nodes.find((n) => n.id === 'CTO')).toBeUndefined();
    expect(nodes.find((n) => n.id === 'ENG1')).toMatchObject({ parentId: 'CEO', rerouted: true });
  });

  it('treats hidden people like deactivated ones', () => {
    const people = company.map((p) => (p.slackUserId === 'CFO' ? { ...p, hidden: true } : p));
    expect(buildChart(people, 'Acme').find((n) => n.id === 'FIN1')?.parentId).toBe('CEO');
  });

  it('leaves out bots', () => {
    const nodes = buildChart([...company, person('BOT', 'CEO', { userType: 'bot' })], 'Acme');
    expect(nodes.find((n) => n.id === 'BOT')).toBeUndefined();
  });

  it('breaks reporting loops instead of failing', () => {
    const nodes = buildChart([person('A', 'B'), person('B', 'C'), person('C', 'A'), person('D', 'A')], 'Acme');
    const cut = nodes.filter((n) => n.cycleBroken);
    expect(cut.map((n) => n.id)).toEqual(['A']);
    expect(parentOf(nodes, 'A')).toBe(COMPANY_ID);
    expect(parentOf(nodes, 'B')).toBe('C');
    expect(parentOf(nodes, 'C')).toBe('A');
    expect(parentOf(nodes, 'D')).toBe('A');
  });

  it('treats someone listed as their own manager as a root', () => {
    const nodes = buildChart([person('A', 'A'), person('B', 'A')], 'Acme');
    expect(parentOf(nodes, 'A')).toBe(COMPANY_ID);
  });

  it('groups lone people: external ones and unplaced employees', () => {
    const nodes = buildChart(
      [
        ...company,
        person('LONE', null),
        person('MISSING_MGR', 'NOBODY'),
        person('GUEST', null, { userType: 'multi_channel_guest' }),
        person('PARTNER', null, { userType: 'slack_connect', externalOrg: 'Globex' }),
      ],
      'Acme',
    );
    expect(parentOf(nodes, 'LONE')).toBe(UNPLACED_GROUP_ID);
    expect(parentOf(nodes, 'MISSING_MGR')).toBe(UNPLACED_GROUP_ID);
    expect(parentOf(nodes, 'GUEST')).toBe(EXTERNAL_GROUP_ID);
    expect(nodes.find((n) => n.id === 'PARTNER')).toMatchObject({
      parentId: EXTERNAL_GROUP_ID,
      badge: 'external',
      externalOrg: 'Globex',
    });
    expect(nodes.find((n) => n.id === UNPLACED_GROUP_ID)?.descendants).toBe(2);
    expect(nodes.find((n) => n.id === EXTERNAL_GROUP_ID)?.descendants).toBe(2);
  });

  it('keeps an external person who has reports in the tree, badged', () => {
    const nodes = buildChart(
      [person('CEO', null), person('AGENCY', 'CEO', { userType: 'contractor' }), person('X', 'AGENCY')],
      'Acme',
    );
    expect(nodes.find((n) => n.id === 'AGENCY')).toMatchObject({ parentId: 'CEO', badge: 'contractor' });
  });

  it('gives a flat list a readable shape when nobody has a manager yet', () => {
    const nodes = buildChart([person('A', null), person('B', null)], 'Acme');
    expect(nodes.map((n) => [n.id, n.parentId])).toEqual([
      [COMPANY_ID, null],
      ['A', UNPLACED_GROUP_ID],
      ['B', UNPLACED_GROUP_ID],
      [UNPLACED_GROUP_ID, COMPANY_ID],
    ]);
  });

  it('sorts siblings by admin sort order, then name', () => {
    const nodes = buildChart(
      [
        person('BOSS', null),
        person('Z', 'BOSS', { name: 'Zoe' }),
        person('A', 'BOSS', { name: 'Adam' }),
        person('M', 'BOSS', { name: 'Mia', sortOrder: 1 }),
      ],
      'Acme',
    );
    expect(nodes.filter((n) => n.parentId === 'BOSS').map((n) => n.name)).toEqual(['Mia', 'Adam', 'Zoe']);
  });
});

describe('resolveFocus', () => {
  const nodes = buildChart([person('A', null), person('B', 'A')], 'Acme');

  it('opens on the requested person, else the viewer, else the company', () => {
    expect(resolveFocus(nodes, 'A', 'B')).toBe('B');
    expect(resolveFocus(nodes, 'A', 'NOPE')).toBe('A');
    expect(resolveFocus(nodes, 'A', null)).toBe('A');
    expect(resolveFocus(nodes, 'GONE', null)).toBe(COMPANY_ID);
  });

  it('never focuses a group node by id', () => {
    expect(resolveFocus(nodes, 'A', COMPANY_ID)).toBe('A');
  });
});

describe('neighborhood', () => {
  const nodes = buildChart(
    [
      person('CEO', null),
      person('CTO', 'CEO'),
      person('CFO', 'CEO'),
      person('ENG1', 'CTO'),
      person('ENG2', 'CTO'),
      person('INTERN', 'ENG1'),
    ],
    'Acme',
  );

  it('returns the manager chain, peers and reports', () => {
    const n = neighborhood(nodes, 'ENG1')!;
    expect(n.managers.map((m) => m.id)).toEqual(['CTO', 'CEO']);
    expect(n.peers.map((m) => m.id)).toEqual(['ENG2']);
    expect(n.reports.map((m) => m.id)).toEqual(['INTERN']);
  });

  it('has no managers or peers at the top', () => {
    const n = neighborhood(nodes, 'CEO')!;
    expect(n.managers).toEqual([]);
    expect(n.peers).toEqual([]);
    expect(n.reports.map((m) => m.id).sort()).toEqual(['CFO', 'CTO']);
  });

  it('returns null for unknown people', () => {
    expect(neighborhood(nodes, 'NOPE')).toBeNull();
  });
});
