import type { types } from '@slack/bolt';
import type { PrismaClient } from '@prisma/client';
import type { Badge, ChartNode } from '../../shared/chart.js';
import { prisma as defaultPrisma } from '../db.js';
import { accessDenied } from '../auth.js';
import { getChart } from '../chart/service.js';
import { neighborhood } from '../chart/tree.js';

// What App Home, /orgchart and the message shortcut show inside Slack. App
// Home cannot draw a tree, so these are lists with links into the full chart.

type KnownBlock = types.KnownBlock;
type View = types.View;
type Neighborhood = NonNullable<ReturnType<typeof neighborhood>>;

const LIMITS = { managers: 3, peers: 10, reports: 20 } as const;

// Same shapes as the chart's badges (circle, triangle, square), plus a word,
// so the difference never rests on color.
const BADGE_TEXT: Record<Exclude<Badge, null>, string> = {
  guest: '● Guest',
  external: '▲ External',
  contractor: '■ Contractor',
};

// The chart's address. team= picks the workspace at sign-in, user= centers it.
export function chartUrl(baseUrl: string, tenant: string, userId?: string): string {
  const url = new URL('/chart', baseUrl);
  url.searchParams.set('team', tenant);
  if (userId) url.searchParams.set('user', userId);
  return url.toString();
}

// Slack mrkdwn needs &, < and > escaped. Inside a <url|label> link the label
// also cannot hold a pipe.
export function escapeMrkdwn(value: string | null | undefined): string {
  return (value ?? '').replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
}

function badgeText(node: ChartNode): string {
  if (!node.badge) return '';
  const org = node.badge === 'external' && node.externalOrg ? ` · ${escapeMrkdwn(node.externalOrg)}` : '';
  return `_${BADGE_TEXT[node.badge]}${org}_`;
}

// One person: photo, linked name, title, badge.
export function personBlock(node: ChartNode, link: string, opts: { isViewer?: boolean } = {}): KnownBlock {
  const name = escapeMrkdwn(node.name).replace(/\|/g, '¦');
  const lines = [`*<${link}|${name}>*${opts.isViewer ? '  (you)' : ''}`];
  const subtitle = [node.title, node.department].filter(Boolean).map(escapeMrkdwn).join(' · ');
  if (subtitle) lines.push(subtitle);
  const badge = badgeText(node);
  if (badge) lines.push(badge);
  return {
    type: 'section',
    text: { type: 'mrkdwn', text: lines.join('\n') },
    ...(node.avatarUrl ? { accessory: { type: 'image', image_url: node.avatarUrl, alt_text: node.name } } : {}),
  };
}

function group(
  title: string,
  nodes: ChartNode[],
  limit: number,
  linkFor: (id: string) => string,
  moreLink: string,
): KnownBlock[] {
  if (!nodes.length) return [];
  const people = nodes.filter((n) => n.kind === 'person');
  const blocks: KnownBlock[] = [
    { type: 'header', text: { type: 'plain_text', text: `${title} (${people.length})` } },
    ...people.slice(0, limit).map((n) => personBlock(n, linkFor(n.id))),
  ];
  if (people.length > limit) {
    blocks.push({
      type: 'context',
      elements: [{ type: 'mrkdwn', text: `<${moreLink}|and ${people.length - limit} more in the full chart>` }],
    });
  }
  return blocks;
}

function openButton(url: string, text = 'Open full chart'): KnownBlock {
  return {
    type: 'actions',
    elements: [{ type: 'button', text: { type: 'plain_text', text }, url, style: 'primary', action_id: 'open_chart' }],
  };
}

// App Home: the viewer, then their managers, peers and reports.
export function homeBlocks(around: Neighborhood | null, opts: { baseUrl: string; tenant: string; viewerId: string }) {
  const link = (id?: string) => chartUrl(opts.baseUrl, opts.tenant, id);
  const blocks: KnownBlock[] = [
    { type: 'header', text: { type: 'plain_text', text: 'Your place in the org chart' } },
    openButton(link()),
  ];
  if (!around) {
    blocks.push(
      note('You are not on the chart yet. It fills in after the next sync, or an org chart admin can add you.'),
    );
    return blocks;
  }
  blocks.push(personBlock(around.person, link(around.person.id), { isViewer: true }));
  if (!around.managers.length && !around.reports.length) {
    blocks.push(note('No manager is set for you yet. Ask an org chart admin, or set Manager on your Slack profile.'));
  }
  const managers = around.managers.slice(0, LIMITS.managers);
  blocks.push(
    ...group('Reports to', managers, LIMITS.managers, link, link(around.person.id)),
    ...group('Works with', around.peers, LIMITS.peers, link, link(around.person.id)),
    ...group('Direct reports', around.reports, LIMITS.reports, link, link(around.person.id)),
  );
  return blocks;
}

// /orgchart and the message shortcut: one person and where they sit.
export function summaryBlocks(around: Neighborhood, opts: { baseUrl: string; tenant: string; viewerId: string }) {
  const link = (id?: string) => chartUrl(opts.baseUrl, opts.tenant, id);
  const { person, managers, peers, reports } = around;
  const facts: string[] = [];
  const manager = managers[0];
  if (manager) facts.push(`Reports to *<${link(manager.id)}|${escapeMrkdwn(manager.name).replace(/\|/g, '¦')}>*`);
  const reportCount = reports.filter((r) => r.kind === 'person').length;
  if (reportCount) {
    const team = person.descendants > reportCount ? `, ${person.descendants} people in their part of the org` : '';
    facts.push(`${reportCount} direct ${reportCount === 1 ? 'report' : 'reports'}${team}`);
  }
  if (peers.length) facts.push(`${peers.length} ${peers.length === 1 ? 'peer' : 'peers'}`);
  if (!facts.length) facts.push('Not placed under a manager yet');
  return [
    personBlock(person, link(person.id), { isViewer: person.id === opts.viewerId }),
    { type: 'context', elements: [{ type: 'mrkdwn', text: facts.join('  ·  ') }] },
    openButton(link(person.id), 'Open in org chart'),
  ] satisfies KnownBlock[];
}

function note(text: string): KnownBlock {
  return { type: 'context', elements: [{ type: 'mrkdwn', text }] };
}

// What someone typed after /orgchart: a mention (<@U123|name>, sent when the
// command escapes names), a bare id, or a name to search for.
export function parseTarget(text: string): { userId: string } | { query: string } | null {
  const trimmed = text.trim();
  if (!trimmed) return null;
  const mention = /^<@([UW][A-Z0-9]+)(?:\|[^>]*)?>/.exec(trimmed);
  if (mention) return { userId: mention[1]! };
  if (/^[UW][A-Z0-9]{6,}$/.test(trimmed)) return { userId: trimmed };
  return { query: trimmed.replace(/^@/, '').trim() };
}

export interface SurfaceDeps {
  baseUrl: string;
  ensurePerson: (tenant: string, userId: string) => Promise<void>;
  db?: PrismaClient;
}

export interface Reply {
  text: string;
  blocks: KnownBlock[];
}

export function slackSurfaces(deps: SurfaceDeps) {
  const db = deps.db ?? defaultPrisma;

  // The chart if this person may see it, otherwise why not.
  const chartFor = async (tenant: string, userId: string) => {
    await deps.ensurePerson(tenant, userId).catch(() => {});
    const denied = await accessDenied(tenant, userId, db);
    if (denied) return { denied, chart: null };
    return { denied: null, chart: await getChart(tenant, userId, null, db) };
  };

  return {
    async home(tenant: string, userId: string): Promise<View> {
      const result = await chartFor(tenant, userId);
      const blocks: KnownBlock[] = !result.chart
        ? [{ type: 'header', text: { type: 'plain_text', text: 'Org chart' } }, note(escapeMrkdwn(result.denied ?? ''))]
        : homeBlocks(neighborhood(result.chart.nodes, userId), { baseUrl: deps.baseUrl, tenant, viewerId: userId });
      return { type: 'home', blocks };
    },

    async command(tenant: string, userId: string, text: string): Promise<Reply> {
      const result = await chartFor(tenant, userId);
      if (!result.chart) return { text: result.denied ?? '', blocks: [note(escapeMrkdwn(result.denied))] };
      const { nodes } = result.chart;
      const people = nodes.filter((n) => n.kind === 'person');
      const target = parseTarget(text) ?? { userId };
      const opts = { baseUrl: deps.baseUrl, tenant, viewerId: userId };

      if ('userId' in target) {
        const around = neighborhood(nodes, target.userId);
        if (!around) {
          const msg = 'That person is not on the org chart. Bots, deactivated and hidden accounts are left out.';
          return { text: msg, blocks: [note(msg)] };
        }
        return { text: `${around.person.name} in the org chart`, blocks: summaryBlocks(around, opts) };
      }

      const q = target.query.toLowerCase();
      const matches = people.filter((n) => n.name.toLowerCase().includes(q));
      if (matches.length === 1) {
        return {
          text: `${matches[0]!.name} in the org chart`,
          blocks: summaryBlocks(neighborhood(nodes, matches[0]!.id)!, opts),
        };
      }
      if (!matches.length) {
        const msg = `No one called "${escapeMrkdwn(target.query)}" is on the org chart. Try /orgchart @name.`;
        return { text: msg, blocks: [note(msg)] };
      }
      const shown = matches.slice(0, 5);
      return {
        text: `${matches.length} people match "${target.query}"`,
        blocks: [
          note(
            `${matches.length} people match "${escapeMrkdwn(target.query)}"${matches.length > 5 ? '. The first 5:' : ':'}`,
          ),
          ...shown.map((n) => personBlock(n, chartUrl(deps.baseUrl, tenant, n.id))),
        ],
      };
    },

    // The message shortcut opens a modal on the message's author.
    async authorModal(tenant: string, userId: string, authorId: string | undefined): Promise<View> {
      const result = await chartFor(tenant, userId);
      let blocks: KnownBlock[];
      if (!result.chart) blocks = [note(escapeMrkdwn(result.denied))];
      else {
        const around = authorId ? neighborhood(result.chart.nodes, authorId) : null;
        blocks = around
          ? summaryBlocks(around, { baseUrl: deps.baseUrl, tenant, viewerId: userId })
          : [
              note(
                'Whoever wrote this message is not on the org chart. Bots, deactivated and hidden accounts are left out.',
              ),
            ];
      }
      return {
        type: 'modal',
        title: { type: 'plain_text', text: 'Org chart' },
        close: { type: 'plain_text', text: 'Close' },
        blocks,
      };
    },
  };
}
