import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { buildChart, neighborhood, type EffectivePerson } from '../src/server/chart/tree.js';
import { chartUrl, escapeMrkdwn, homeBlocks, parseTarget, summaryBlocks } from '../src/server/slack/surfaces.js';
import { ACTION_USER_SCOPES, BOT_SCOPES, PROFILE_WRITER_SCOPES, SIGN_IN_SCOPES } from '../src/server/config.js';
import { channelName, inviteReason } from '../src/shared/actions.js';

const p = (id: string, name: string, manager: string | null, extra: Partial<EffectivePerson> = {}): EffectivePerson => ({
  slackUserId: id,
  name,
  title: `${name}'s title`,
  department: null,
  avatarUrl: `https://avatars.slack-edge.com/${id}.png`,
  userType: 'employee',
  externalOrg: null,
  managerSlackId: manager,
  hidden: false,
  isDeleted: false,
  sortOrder: null,
  ...extra,
});

const opts = { baseUrl: 'https://orgchart.test', tenant: 'T1', viewerId: 'UENG' };
const text = (blocks: unknown) => JSON.stringify(blocks);

describe('Slack surfaces', () => {
  const nodes = buildChart(
    [
      p('UCEO', 'Carla', null),
      p('UCTO', 'Theo', 'UCEO'),
      p('UENG', 'Erin', 'UCTO'),
      p('UPEER', 'Pia', 'UCTO'),
      p('UJR', 'Juno', 'UENG'),
      p('UPAT', 'Pat <script>', 'UCTO', { userType: 'slack_connect', externalOrg: 'Globex' }),
    ],
    'Acme',
  );

  it('builds chart links centered on a person', () => {
    expect(chartUrl('https://orgchart.test', 'T1', 'U1')).toBe('https://orgchart.test/chart?team=T1&user=U1');
    expect(chartUrl('https://orgchart.test', 'T1')).toBe('https://orgchart.test/chart?team=T1');
  });

  it('shows App Home with managers, peers and reports', () => {
    const blocks = homeBlocks(neighborhood(nodes, 'UENG'), opts);
    const json = text(blocks);
    expect(json).toContain('Open full chart');
    expect(json).toContain('Reports to (2)');
    expect(json).toContain('Works with (2)');
    expect(json).toContain('Direct reports (1)');
    expect(json).toContain('(you)');
    expect(json).toContain('user=UJR');
    // External people keep their badge word and company in Slack too.
    expect(json).toContain('▲ External · Globex');
    // Names typed into Slack cannot become markup or links.
    expect(json).not.toContain('|Pat <script>');
    expect(json).toContain('Pat &lt;script&gt;');
  });

  it('stays under the Block Kit limit for a manager with many reports', () => {
    const many = buildChart(
      [p('UBOSS', 'Boss', null), ...Array.from({ length: 300 }, (_, i) => p(`U${1000 + i}`, `Person ${i}`, 'UBOSS'))],
      'Acme',
    );
    const blocks = homeBlocks(neighborhood(many, 'UBOSS'), { ...opts, viewerId: 'UBOSS' });
    expect(blocks.length).toBeLessThanOrEqual(100);
    expect(text(blocks)).toContain('and 280 more in the full chart');
  });

  it('tells people who are not placed what to do', () => {
    const lone = buildChart([p('ULONE', 'Lena', null)], 'Acme');
    expect(text(homeBlocks(neighborhood(lone, 'ULONE'), opts))).toContain('No manager is set for you yet');
    expect(text(homeBlocks(null, opts))).toContain('You are not on the chart yet');
  });

  it('summarizes one person for /orgchart and the shortcut', () => {
    const json = text(summaryBlocks(neighborhood(nodes, 'UCTO')!, opts));
    expect(json).toContain('Reports to *<https://orgchart.test/chart?team=T1&user=UCEO|Carla>*');
    expect(json).toContain('3 direct reports, 4 people in their part of the org');
    expect(json).toContain('Open in org chart');
  });

  it('reads who /orgchart is about', () => {
    expect(parseTarget('')).toBeNull();
    expect(parseTarget('  <@U123ABC|erin> ')).toEqual({ userId: 'U123ABC' });
    expect(parseTarget('<@W123ABC>')).toEqual({ userId: 'W123ABC' });
    expect(parseTarget('U0123ABCD')).toEqual({ userId: 'U0123ABCD' });
    expect(parseTarget('@erin')).toEqual({ query: 'erin' });
    expect(parseTarget('Erin Smith')).toEqual({ query: 'Erin Smith' });
  });

  it('escapes Slack mrkdwn', () => {
    expect(escapeMrkdwn('a & <b> c')).toBe('a &amp; &lt;b&gt; c');
  });
});

describe('chart actions helpers', () => {
  it('turns any text into a Slack channel name', () => {
    expect(channelName('Q4 Launch Team!')).toBe('q4-launch-team');
    expect(channelName('#Ünïcode  café')).toBe('unicode-cafe');
    expect(channelName('--a--b--')).toBe('a-b');
    expect(channelName('!!!')).toBe('');
    expect(channelName('x'.repeat(100))).toHaveLength(80);
  });

  it('explains invite failures in words', () => {
    expect(inviteReason('user_is_restricted')).toContain('guest');
    expect(inviteReason('something_new')).toBe('could not be added (something_new)');
  });
});

describe('Slack app manifest', () => {
  const manifest = readFileSync(new URL('../manifest.yml', import.meta.url), 'utf8');
  // The list items under a "<key>:" line, until the indentation drops.
  const list = (key: string) => {
    const lines = manifest.split('\n');
    const start = lines.findIndex((l) => l.trim() === `${key}:`);
    const indent = lines[start]!.search(/\S/);
    const out: string[] = [];
    for (const line of lines.slice(start + 1)) {
      if (!line.trim() || line.trim().startsWith('#')) continue;
      if (line.search(/\S/) <= indent) break;
      const m = /^\s*-\s*(\S+)/.exec(line);
      if (m) out.push(m[1]!);
    }
    return out;
  };

  it('asks for exactly the scopes the code uses', () => {
    expect(list('bot').sort()).toEqual([...BOT_SCOPES].sort());
    expect(list('user').sort()).toEqual([...SIGN_IN_SCOPES, ...ACTION_USER_SCOPES, ...PROFILE_WRITER_SCOPES].sort());
  });

  it('subscribes to every event, command and shortcut the app handles', () => {
    const app = readFileSync(new URL('../src/server/app.ts', import.meta.url), 'utf8');
    const events = [...app.matchAll(/bolt\.event\('([a-z_]+)'/g)].map((m) => m[1]);
    expect(list('bot_events').sort()).toEqual(events.sort());
    expect(manifest).toContain('command: /orgchart');
    expect(app).toContain("bolt.command('/orgchart'");
    expect(manifest).toContain('callback_id: view_in_org_chart');
    expect(app).toContain("bolt.shortcut('view_in_org_chart'");
    for (const path of ['/slack/oauth_redirect', '/auth/callback', '/auth/grant/callback']) {
      expect(list('redirect_urls')).toContain(`https://orgchart.example.com${path}`);
    }
  });
});
