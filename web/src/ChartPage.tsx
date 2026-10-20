import { useEffect, useMemo, useRef, useState } from 'react';
import { OrgChart } from 'd3-org-chart';
import type { ChartNode, ChartResponse } from '../../src/shared/chart';
import { ancestorIds, filterNodes } from '../../src/shared/filter';
import { MAX_GROUP_DM_OTHERS, channelName, type ChannelResult } from '../../src/shared/actions';
import { loadChart, loadMe, loginUrl, type LoadResult } from './api';
import { CARD_HEIGHT, CARD_WIDTH, GROUP_HEIGHT, avatarHtml, badgeHtml, cardHtml } from './card';
import {
  ActionFailed,
  NeedsGrant,
  actionsApi,
  channelLink,
  dmLink,
  grantUrl,
  savePending,
  takePending,
  webChannelLink,
  type Pending,
} from './actions';

type Datum = ChartNode & { _expanded?: boolean; _centered?: boolean };

const readFocusParam = () => new URLSearchParams(window.location.search).get('user');
const readShowExternal = () => {
  try {
    return localStorage.getItem('orgchart.showExternal') !== 'false';
  } catch {
    return true;
  }
};

export function ChartPage() {
  const [result, setResult] = useState<LoadResult | null>(null);
  useEffect(() => {
    loadChart(readFocusParam()).then((r) => {
      // A link from another workspace's Slack while signed in to this one:
      // sign in again for that workspace, once.
      const params = new URLSearchParams(window.location.search);
      const team = params.get('team');
      if (r.status === 'ok' && team && team !== r.data.workspace.teamId && !params.has('switched')) {
        params.set('switched', '1');
        window.history.replaceState(null, '', `${window.location.pathname}?${params}`);
        window.location.assign(loginUrl());
        return;
      }
      setResult(r);
    }, () => setResult({ status: 'error', message: 'The chart could not load. Check your connection.' }));
  }, []);

  if (!result) return <div className="state">Loading the org chart…</div>;
  if (result.status !== 'ok') {
    return (
      <div className="state">
        <h1>{result.status === 'forbidden' ? 'No access' : 'Something went wrong'}</h1>
        <p>{result.message}</p>
      </div>
    );
  }
  return <Chart data={result.data} />;
}

function Chart({ data }: { data: ChartResponse }) {
  const containerRef = useRef<HTMLDivElement>(null);
  const chartRef = useRef<OrgChart<Datum> | null>(null);
  const [showExternal, setShowExternal] = useState(readShowExternal);
  const [selected, setSelected] = useState<ChartNode | null>(null);
  // People ticked for Message, Group DM or Create channel.
  const [picked, setPicked] = useState<string[]>([]);
  const pickedRef = useRef(new Set<string>());
  pickedRef.current = new Set(picked);
  const [notice, setNotice] = useState<Notice | null>(null);
  const [channelDraft, setChannelDraft] = useState<{ name: string; isPrivate: boolean } | null>(null);
  const [busy, setBusy] = useState(false);
  const [query, setQuery] = useState('');
  const [isAdmin, setIsAdmin] = useState(false);
  useEffect(() => {
    loadMe().then((me) => setIsAdmin(Boolean(me?.isAdmin)));
  }, []);

  const nodes = useMemo(
    () => (showExternal ? data.nodes : filterNodes(data.nodes, (n) => !n.badge)),
    [data.nodes, showExternal],
  );
  const externalCount = useMemo(() => data.nodes.filter((n) => n.badge).length, [data.nodes]);
  const everyone = useMemo(() => new Map(data.nodes.map((n) => [n.id, n])), [data.nodes]);
  const byId = useMemo(() => new Map(nodes.map((n) => [n.id, n])), [nodes]);

  // Draw (or redraw after a filter change) opened on the focus person: their
  // managers above, peers beside, reports below, everything else folded.
  useEffect(() => {
    const container = containerRef.current;
    if (!container) return;
    const focusId = byId.has(data.focusId) ? data.focusId : nodes[0]!.id;
    const open = new Set([focusId, ...ancestorIds(nodes, focusId)]);
    const chartData: Datum[] = nodes.map((n) => ({ ...n, _expanded: open.has(n.id) }));

    const chart = (chartRef.current ??= new OrgChart<Datum>());
    chart
      .container(container)
      .data(chartData)
      .nodeId((d) => d.id)
      .parentNodeId((d) => d.parentId)
      .nodeWidth(() => CARD_WIDTH)
      .nodeHeight((d) => (d.data.kind === 'group' ? GROUP_HEIGHT : CARD_HEIGHT))
      .childrenMargin(() => 56)
      .compactMarginBetween(() => 28)
      .compactMarginPair(() => 48)
      .siblingsMargin(() => 24)
      .svgHeight(container.clientHeight)
      .nodeContent((d) =>
        cardHtml(d.data, {
          isViewer: d.data.id === data.viewerId,
          isFocus: d.data.id === data.focusId,
          selectable: true,
          selected: pickedRef.current.has(d.data.id),
        }),
      )
      .buttonContent(({ node }) => {
        const expanded = Boolean(node.children);
        return `<div class="expand">${expanded ? '−' : '+'} ${node.data.descendants}</div>`;
      })
      .nodeButtonWidth(() => 56)
      .nodeButtonX(() => -28)
      .nodeUpdate(function (d) {
        // Search results get a ring in the page's focus color.
        const rect = this.querySelector('.node-rect');
        const on = Boolean(d.data._highlighted);
        rect?.setAttribute('stroke', on ? 'var(--focus)' : 'none');
        rect?.setAttribute('stroke-width', on ? '4' : '0');
        rect?.setAttribute('rx', '12');
      })
      .linkUpdate(function () {
        this.setAttribute('stroke', 'var(--line)');
        this.setAttribute('stroke-width', '1.5');
      })
      .onNodeClick((node) => {
        if (node.data.kind === 'person') setSelected(node.data);
      })
      .render();
    showAround(chart, focusId, false);
  }, [nodes, byId, data.focusId, data.viewerId]);

  // Ticking a card's box picks the person without opening their panel. The
  // listener runs in the capture phase, before the chart's own click.
  useEffect(() => {
    const container = containerRef.current;
    if (!container) return;
    const onClick = (e: MouseEvent) => {
      const box = (e.target as Element | null)?.closest?.('[data-select]') as HTMLInputElement | null;
      const label = (e.target as Element | null)?.closest?.('.card-select');
      if (!box && !label) return;
      e.stopPropagation();
      if (!box) return;
      const id = box.dataset.select!;
      setPicked((prev) => (box.checked ? [...new Set([...prev, id])] : prev.filter((p) => p !== id)));
    };
    container.addEventListener('click', onClick, true);
    return () => container.removeEventListener('click', onClick, true);
  }, []);

  // Keep the drawn cards in step with picks made elsewhere (panel, Clear).
  useEffect(() => {
    const container = containerRef.current;
    if (!container) return;
    for (const box of container.querySelectorAll<HTMLInputElement>('[data-select]')) {
      const on = pickedRef.current.has(box.dataset.select!);
      box.checked = on;
      box.closest('.card')?.classList.toggle('card-selected', on);
    }
  }, [picked]);

  // Back from Slack's permission screen: restore the picks and carry on.
  useEffect(() => {
    const params = new URLSearchParams(window.location.search);
    const grant = params.get('grant');
    if (!grant) return;
    params.delete('grant');
    const rest = params.toString();
    window.history.replaceState(null, '', `${window.location.pathname}${rest ? `?${rest}` : ''}`);
    const pending = takePending();
    if (!pending) return;
    setPicked(pending.userIds);
    if (grant !== 'ok') {
      setNotice({ kind: 'warn', text: 'Org Chart was not allowed to start conversations, so nothing was created.' });
      return;
    }
    if (pending.action === 'channel') setChannelDraft({ name: pending.name ?? '', isPrivate: Boolean(pending.isPrivate) });
    else void startConversation(pending.userIds);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  const togglePick = (id: string) =>
    setPicked((prev) => (prev.includes(id) ? prev.filter((p) => p !== id) : [...prev, id]));

  const nameOf = (id: string) => everyone.get(id)?.name ?? id;

  // Sends the person to Slack's permission screen, remembering what they did.
  const askForGrant = (pending: Pending) => {
    savePending(pending);
    const next = window.location.pathname + window.location.search;
    window.location.assign(grantUrl(next));
  };

  const openInSlack = (teamId: string, channelId: string) => {
    window.location.href = channelLink(teamId, channelId);
  };

  const startConversation = async (userIds: string[]) => {
    setBusy(true);
    setNotice(null);
    try {
      const res = await actionsApi.conversation(userIds);
      openInSlack(res.teamId, res.channelId);
      setNotice({
        kind: 'ok',
        text: `Opened a group DM with ${listNames(userIds.map(nameOf))} in Slack.`,
        link: webChannelLink(res.teamId, res.channelId),
      });
      setPicked([]);
    } catch (err) {
      if (err instanceof NeedsGrant) return askForGrant({ action: 'conversation', userIds });
      setNotice({ kind: 'error', text: message(err) });
    } finally {
      setBusy(false);
    }
  };

  const createChannel = async (name: string, isPrivate: boolean) => {
    setBusy(true);
    setNotice(null);
    try {
      const res = await actionsApi.channel(name, isPrivate, picked);
      setChannelDraft(null);
      openInSlack(res.teamId, res.channelId);
      setNotice(channelNotice(res, nameOf, picked));
      setPicked([]);
    } catch (err) {
      if (err instanceof NeedsGrant) return askForGrant({ action: 'channel', userIds: picked, name, isPrivate });
      setNotice({ kind: 'error', text: message(err) });
    } finally {
      setBusy(false);
    }
  };

  useEffect(() => {
    try {
      localStorage.setItem('orgchart.showExternal', String(showExternal));
    } catch {
      /* private mode: the filter just isn't remembered */
    }
  }, [showExternal]);

  const goTo = (id: string) => {
    const chart = chartRef.current;
    if (!chart || !byId.has(id)) return;
    chart.clearHighlighting();
    chart.setExpanded(id).setHighlighted(id).render();
    showAround(chart, id, true);
    const node = byId.get(id)!;
    if (node.kind === 'person') setSelected(node);
  };

  const matches = useMemo(() => {
    const q = query.trim().toLowerCase();
    if (q.length < 2) return [];
    return nodes
      .filter((n) => n.kind === 'person')
      .filter((n) => [n.name, n.title, n.department, n.externalOrg].some((v) => v?.toLowerCase().includes(q)))
      .slice(0, 8);
  }, [query, nodes]);

  return (
    <div className="chart-page">
      <header className="toolbar">
        <div className="toolbar-title">{data.workspace.name ?? 'Org chart'}</div>
        <div className="search">
          <input
            type="search"
            placeholder="Search people"
            aria-label="Search people"
            value={query}
            onChange={(e) => setQuery(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === 'Enter' && matches[0]) {
                goTo(matches[0].id);
                setQuery('');
              }
            }}
          />
          {matches.length > 0 && (
            <ul className="search-results" role="listbox">
              {matches.map((m) => (
                <li key={m.id}>
                  <button
                    type="button"
                    onClick={() => {
                      goTo(m.id);
                      setQuery('');
                    }}
                  >
                    <span dangerouslySetInnerHTML={{ __html: avatarHtml(m) }} />
                    <span className="result-text">
                      <span className="result-name">{m.name}</span>
                      <span className="result-title">{m.title}</span>
                    </span>
                  </button>
                </li>
              ))}
            </ul>
          )}
        </div>
        <div className="toolbar-buttons">
          {byId.has(data.viewerId) && (
            <button type="button" onClick={() => goTo(data.viewerId)}>
              Back to me
            </button>
          )}
          <button type="button" onClick={() => chartRef.current?.fit()}>
            Fit
          </button>
          <button type="button" aria-label="Zoom out" onClick={() => chartRef.current?.zoomOut()}>
            −
          </button>
          <button type="button" aria-label="Zoom in" onClick={() => chartRef.current?.zoomIn()}>
            +
          </button>
          {isAdmin && (
            <a className="button" href="/admin">
              Admin
            </a>
          )}
          {externalCount > 0 && (
            <label className="toggle">
              <input type="checkbox" checked={showExternal} onChange={(e) => setShowExternal(e.target.checked)} />
              External people ({externalCount})
            </label>
          )}
        </div>
      </header>
      <div className="chart" ref={containerRef} />
      {selected && (
        <PersonPanel
          node={selected}
          teamId={data.workspace.teamId}
          isViewer={selected.id === data.viewerId}
          picked={picked.includes(selected.id)}
          onPick={() => togglePick(selected.id)}
          onClose={() => setSelected(null)}
        />
      )}
      {notice && <NoticeBar notice={notice} onClose={() => setNotice(null)} />}
      {picked.length > 0 && (
        <ActionBar
          picked={picked}
          busy={busy}
          dm={picked.length === 1 ? dmLink(data.workspace.teamId, picked[0]!) : null}
          onGroupDm={() => startConversation(picked)}
          onChannel={() => setChannelDraft({ name: '', isPrivate: false })}
          onClear={() => setPicked([])}
        />
      )}
      {channelDraft && (
        <ChannelDialog
          draft={channelDraft}
          people={picked.map(nameOf)}
          busy={busy}
          onCreate={createChannel}
          onCancel={() => setChannelDraft(null)}
        />
      )}
    </div>
  );
}

interface Notice {
  kind: 'ok' | 'warn' | 'error';
  text: string;
  link?: string;
  // People Slack would not add to a new channel, offered a group DM instead.
  retry?: { label: string; userIds: string[] };
}

function channelNotice(res: ChannelResult, nameOf: (id: string) => string, picked: string[]): Notice {
  const link = webChannelLink(res.teamId, res.channelId);
  if (!res.notInvited.length) {
    return { kind: 'ok', text: `Created #${res.name} with ${listNames(res.invited.map(nameOf))}.`, link };
  }
  const left = res.notInvited.map((n) => `${nameOf(n.userId)} ${n.reason}`).join('; ');
  const total = picked.length;
  return {
    kind: 'warn',
    text: `Created #${res.name}, but Slack did not add everyone: ${left}.`,
    link,
    ...(total <= MAX_GROUP_DM_OTHERS ? { retry: { label: 'Start a group DM with everyone instead', userIds: picked } } : {}),
  };
}

function listNames(names: string[]): string {
  if (names.length <= 2) return names.join(' and ');
  if (names.length <= 4) return `${names.slice(0, -1).join(', ')} and ${names[names.length - 1]}`;
  return `${names.slice(0, 3).join(', ')} and ${names.length - 3} others`;
}

function message(err: unknown): string {
  if (err instanceof ActionFailed) return err.message;
  return 'Slack could not be reached. Check your connection and try again.';
}

function ActionBar(props: {
  picked: string[];
  busy: boolean;
  dm: string | null;
  onGroupDm: () => void;
  onChannel: () => void;
  onClear: () => void;
}) {
  const count = props.picked.length;
  const groupOk = count >= 2 && count <= MAX_GROUP_DM_OTHERS;
  return (
    <div className="action-bar" role="region" aria-label="Selected people">
      <span className="action-count">
        {count} selected
      </span>
      {props.dm ? (
        <a className="button primary" href={props.dm}>
          Message
        </a>
      ) : (
        <button
          type="button"
          className="primary"
          disabled={!groupOk || props.busy}
          title={groupOk ? undefined : `A group DM holds up to ${MAX_GROUP_DM_OTHERS} people besides you.`}
          onClick={props.onGroupDm}
        >
          Group DM
        </button>
      )}
      <button type="button" disabled={props.busy} onClick={props.onChannel}>
        Create channel
      </button>
      <button type="button" className="link" onClick={props.onClear}>
        Clear
      </button>
      {count > MAX_GROUP_DM_OTHERS && (
        <span className="muted small">Group DMs hold up to {MAX_GROUP_DM_OTHERS} people besides you.</span>
      )}
    </div>
  );
}

function ChannelDialog(props: {
  draft: { name: string; isPrivate: boolean };
  people: string[];
  busy: boolean;
  onCreate: (name: string, isPrivate: boolean) => void;
  onCancel: () => void;
}) {
  const [name, setName] = useState(props.draft.name);
  const [isPrivate, setIsPrivate] = useState(props.draft.isPrivate);
  const slug = channelName(name);
  return (
    <div className="dialog-backdrop" onClick={(e) => e.target === e.currentTarget && props.onCancel()}>
      <form
        className="dialog"
        role="dialog"
        aria-modal="true"
        aria-labelledby="channel-dialog-title"
        onSubmit={(e) => {
          e.preventDefault();
          if (slug) props.onCreate(slug, isPrivate);
        }}
        onKeyDown={(e) => e.key === 'Escape' && props.onCancel()}
      >
        <h2 id="channel-dialog-title">Create a channel</h2>
        <label className="field">
          <span>Name</span>
          <input
            className="text-input"
            autoFocus
            value={name}
            maxLength={80}
            placeholder="e.g. q4-launch"
            onChange={(e) => setName(e.target.value)}
          />
          {name && slug !== name && <span className="hint">Slack will call it #{slug || '…'}</span>}
        </label>
        <label className="check">
          <input type="checkbox" checked={isPrivate} onChange={(e) => setIsPrivate(e.target.checked)} />
          Private channel
          <span className="hint">Only invited people can find it.</span>
        </label>
        <p className="muted small">
          You and {listNames(props.people)} will be in it. Guests and people from other companies may need a Slack admin to
          add them.
        </p>
        <div className="dialog-buttons">
          <button type="button" onClick={props.onCancel}>
            Cancel
          </button>
          <button type="submit" className="primary" disabled={!slug || props.busy}>
            {props.busy ? 'Creating…' : 'Create channel'}
          </button>
        </div>
      </form>
    </div>
  );
}

function NoticeBar({ notice, onClose }: { notice: Notice; onClose: () => void }) {
  const [retrying, setRetrying] = useState(false);
  return (
    <div className={`toast note note-${notice.kind}`} role={notice.kind === 'error' ? 'alert' : 'status'}>
      <span>{notice.text}</span>
      {notice.link && (
        <a href={notice.link} target="_blank" rel="noreferrer">
          Open in browser
        </a>
      )}
      {notice.retry && (
        <button
          type="button"
          disabled={retrying}
          onClick={async () => {
            setRetrying(true);
            try {
              const res = await actionsApi.conversation(notice.retry!.userIds);
              window.location.href = channelLink(res.teamId, res.channelId);
              onClose();
            } catch {
              setRetrying(false);
            }
          }}
        >
          {notice.retry.label}
        </button>
      )}
      <button type="button" className="panel-close" aria-label="Dismiss" onClick={onClose}>
        ×
      </button>
    </div>
  );
}

// Zooms to a person with their manager above, peers beside and reports
// below. Never zooms in past 100%, or so far out that cards are unreadable.
function showAround(chart: OrgChart<Datum>, id: string, animate: boolean) {
  const state = chart.getChartState() as unknown as ChartState;
  const all = state.root.descendants();
  const focus = all.find((n) => n.data.id === id);
  if (!focus) return;
  const near = new Set([id, ...(focus.children ?? []).map((c) => c.data.id)]);
  if (focus.parent) {
    near.add(focus.parent.data.id);
    for (const sibling of focus.parent.children ?? []) near.add(sibling.data.id);
  }
  const nodes = all.filter((n) => near.has(n.data.id));
  const pad = 40;
  let x0 = Math.min(...nodes.map((n) => n.x - n.width / 2)) - pad;
  let x1 = Math.max(...nodes.map((n) => n.x + n.width / 2)) + pad;
  let y0 = Math.min(...nodes.map((n) => n.y)) - pad;
  let y1 = Math.max(...nodes.map((n) => n.y + n.height)) + pad;

  const w = state.svgWidth * 0.9;
  const h = state.svgHeight * 0.9;
  const MIN_SCALE = 0.55;
  // Too wide (a manager with many reports): keep the focus in the middle at
  // the smallest readable scale, starting from their manager's row.
  if (Math.min(w / (x1 - x0), h / (y1 - y0)) < MIN_SCALE) {
    const halfW = w / MIN_SCALE / 2;
    x0 = focus.x - halfW;
    x1 = focus.x + halfW;
    y1 = y0 + h / MIN_SCALE;
  }
  // Too small: pad the box out to the viewport so the scale stays at 100%.
  const growX = Math.max(0, w - (x1 - x0)) / 2;
  const growY = Math.max(0, h - (y1 - y0)) / 2;
  chart.zoomTreeBounds({
    x0: x0 - growX,
    x1: x1 + growX,
    y0: y0 - growY,
    y1: y1 + growY,
    params: { animate, scale: true },
  });
}

interface LaidOutNode {
  x: number;
  y: number;
  width: number;
  height: number;
  data: Datum;
  parent: LaidOutNode | null;
  children?: LaidOutNode[];
}

interface ChartState {
  root: { descendants(): LaidOutNode[] };
  svgWidth: number;
  svgHeight: number;
}

function PersonPanel(props: {
  node: ChartNode;
  teamId: string;
  isViewer: boolean;
  picked: boolean;
  onPick: () => void;
  onClose: () => void;
}) {
  const { node, teamId, onClose } = props;
  return (
    <aside className="panel" aria-label={`${node.name} details`}>
      <button type="button" className="panel-close" aria-label="Close" onClick={onClose}>
        ×
      </button>
      <span dangerouslySetInnerHTML={{ __html: avatarHtml(node, 'lg') }} />
      <h2>{node.name}</h2>
      {node.title && <p className="panel-title">{node.title}</p>}
      {node.department && <p className="muted">{node.department}</p>}
      <p dangerouslySetInnerHTML={{ __html: badgeHtml(node.badge ?? null, node.externalOrg) }} />
      {node.rerouted && <p className="muted small">Their manager is deactivated or hidden, so they appear under the next manager up.</p>}
      {!props.isViewer && (
        <div className="panel-buttons">
          <a className="button primary" href={dmLink(teamId, node.id)}>
            Message
          </a>
          <button type="button" aria-pressed={props.picked} onClick={props.onPick}>
            {props.picked ? 'Selected' : 'Select'}
          </button>
        </div>
      )}
    </aside>
  );
}
