import { useEffect, useMemo, useRef, useState } from 'react';
import { OrgChart } from 'd3-org-chart';
import type { ChartNode, ChartResponse } from '../../src/shared/chart';
import { ancestorIds, filterNodes } from '../../src/shared/filter';
import { loadChart, type LoadResult } from './api';
import { CARD_HEIGHT, CARD_WIDTH, GROUP_HEIGHT, avatarHtml, badgeHtml, cardHtml } from './card';

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
    loadChart(readFocusParam()).then(setResult, () =>
      setResult({ status: 'error', message: 'The chart could not load. Check your connection.' }),
    );
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
  const [query, setQuery] = useState('');

  const nodes = useMemo(
    () => (showExternal ? data.nodes : filterNodes(data.nodes, (n) => !n.badge)),
    [data.nodes, showExternal],
  );
  const externalCount = useMemo(() => data.nodes.filter((n) => n.badge).length, [data.nodes]);
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
          {externalCount > 0 && (
            <label className="toggle">
              <input type="checkbox" checked={showExternal} onChange={(e) => setShowExternal(e.target.checked)} />
              External people ({externalCount})
            </label>
          )}
        </div>
      </header>
      <div className="chart" ref={containerRef} />
      {selected && <PersonPanel node={selected} teamId={data.workspace.teamId} onClose={() => setSelected(null)} />}
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

function PersonPanel({ node, teamId, onClose }: { node: ChartNode; teamId: string; onClose: () => void }) {
  const slackLink = `slack://user?team=${encodeURIComponent(teamId)}&id=${encodeURIComponent(node.id)}`;
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
      <a className="button primary" href={slackLink}>
        Open profile in Slack
      </a>
    </aside>
  );
}
