// The demo: a mock Slack workspace around the real chart and admin pages.
// The pages are the app's own components (web/src); only their /api calls
// are answered in the browser by mockApi.ts.
import { StrictMode, useCallback, useEffect, useMemo, useRef, useState, type ReactNode } from 'react';
import { createRoot } from 'react-dom/client';
import { ChartPage } from '../web/src/ChartPage';
import { AdminPage } from '../web/src/admin/AdminPage';
import { neighborhood } from '../src/server/chart/tree';
import type { ChartNode } from '../src/shared/chart';
import { CHANNEL_MESSAGES, PEOPLE, TEAM_ID, VIEWERS, WORKSPACE_NAME } from './data';
import {
  chartNodes,
  connectProfileWriter,
  installMockApi,
  openDm,
  setHooks,
  person,
  state,
  type Conversation,
} from './mockApi';
import '../web/src/styles.css';
import './demo.css';

type View = { kind: 'channel'; id: string } | { kind: 'home' } | { kind: 'conv'; id: string };
type Browser = { page: 'chart' | 'admin'; focus: string | null; key: number } | null;
type Ask = { kind: 'actions' | 'profile'; resolve: (ok: boolean) => void } | null;

const STEPS = [
  {
    id: 'profile',
    label: 'Profile link',
    text: 'Every Slack profile gets an "Org chart" link field that the app fills in. Click View in org chart on Hannah Kim\'s profile to open the chart on her.',
  },
  {
    id: 'home',
    label: 'App Home',
    text: 'The app\'s Home tab shows where you sit: your manager, peers and reports, each linking into the chart. Click Open full chart. You can also type /orgchart hannah in any channel.',
  },
  {
    id: 'chart',
    label: 'The chart',
    text: 'The chart opens on you, with photos, your managers above and your reports below. Guests, contractors and Slack Connect people carry a badge; the External people switch hides them. Search, or click a card for details.',
  },
  {
    id: 'actions',
    label: 'DM, group DM, channel',
    text: 'Tick the box on a few cards (try Aisha and Jonas, then open Jonas\'s +1 and tick Sofia, a guest), then use Group DM or Create channel in the bar at the bottom. The first time, Slack asks you to allow it. Message on one person opens your DM.',
  },
  {
    id: 'admin',
    label: 'Admin page',
    text: 'Admins fix what Slack gets wrong: Mila and Theo report to a deactivated manager, Alex has none. Set a manager, mark someone a contractor, hide a person, import a CSV, or pick the profile link field. Then go Back to chart.',
  },
] as const;
type StepId = (typeof STEPS)[number]['id'];

const nameOf = (id: string) => person(id)?.name ?? id;
const firstName = (id: string) => nameOf(id).split(' ')[0];

function Demo() {
  const [, setTick] = useState(0);
  const refresh = useCallback(() => setTick((t) => t + 1), []);
  const [view, setView] = useState<View>({ kind: 'channel', id: 'engineering' });
  const [profile, setProfile] = useState<string | null>('U005');
  const [browser, setBrowser] = useState<Browser>(null);
  const [browserShown, setBrowserShown] = useState(false);
  const [ask, setAsk] = useState<Ask>(null);
  const [step, setStep] = useState<StepId>('profile');
  const [guide, setGuide] = useState(true);
  const [viewer, setViewer] = useState(state.viewer);
  const [navOpen, setNavOpen] = useState(false);
  const keyRef = useRef(1);

  useEffect(() => {
    setHooks({
      askPermission: (kind) => new Promise((resolve) => setAsk({ kind, resolve })),
      onChange: refresh,
    });
  }, [refresh]);

  const openBrowser = (page: 'chart' | 'admin', focus: string | null = null) => {
    state.focus = focus;
    setBrowser({ page, focus, key: keyRef.current++ });
    setBrowserShown(true);
    // Keep the guide in step when people find their own way there.
    if (page === 'admin') setStep('admin');
    else setStep((s) => (s === 'profile' || s === 'home' ? 'chart' : s));
  };

  const goSlack = (v: View) => {
    setView(v);
    setBrowserShown(false);
    setNavOpen(false);
  };

  const openConversation = (conv: Conversation | undefined) => {
    if (conv) goSlack({ kind: 'conv', id: conv.id });
  };

  // Slack links from the chart page (#oc-dm-U123, #oc-open-G123), and the
  // page's own links to /chart and /admin.
  const handleLink = (href: string): boolean => {
    if (href.startsWith('#oc-dm-')) {
      openConversation(openDm(decodeURIComponent(href.slice(7))));
      refresh();
      return true;
    }
    if (href.startsWith('#oc-open-')) {
      openConversation(state.conversations.get(decodeURIComponent(href.slice(9))));
      return true;
    }
    if (href.startsWith('/admin')) {
      openBrowser('admin');
      return true;
    }
    if (href.startsWith('/chart')) {
      const user = new URL(href, 'https://demo.invalid').searchParams.get('user');
      openBrowser('chart', user);
      return true;
    }
    if (href.startsWith('/auth/grant')) {
      void connectProfileWriter().then(() => {
        refresh();
        setBrowser((b) => (b ? { ...b, key: keyRef.current++ } : b));
      });
      return true;
    }
    return false;
  };

  useEffect(() => {
    const onHash = () => {
      const hash = window.location.hash;
      if (!hash.startsWith('#oc-')) return;
      handleLink(hash);
      try {
        window.history.replaceState(null, '', window.location.pathname + window.location.search);
      } catch {
        window.location.hash = '';
      }
    };
    window.addEventListener('hashchange', onHash);
    return () => window.removeEventListener('hashchange', onHash);
  });

  const onBrowserClick = (e: React.MouseEvent) => {
    const a = (e.target as Element).closest?.('a[href]');
    if (!a) return;
    if (handleLink(a.getAttribute('href') ?? '')) e.preventDefault();
  };

  const goStep = (id: StepId) => {
    setStep(id);
    setGuide(true);
    if (id === 'profile') {
      goSlack({ kind: 'channel', id: 'engineering' });
      setProfile('U005');
    } else if (id === 'home') {
      goSlack({ kind: 'home' });
      setProfile(null);
    } else if (id === 'chart' || id === 'actions') {
      openBrowser('chart');
    } else openBrowser('admin');
  };

  const switchViewer = (id: string) => {
    state.viewer = id;
    setViewer(id);
    if (browser) setBrowser({ ...browser, key: keyRef.current++ });
  };

  const stepIndex = STEPS.findIndex((s) => s.id === step);
  const current = STEPS[stepIndex]!;
  const conversations = [...state.conversations.values()];

  return (
    <div className="s-demo">
      <header className="s-demobar">
        <div className="s-brand">
          <span className="s-brand-mark" aria-hidden="true">
            <svg viewBox="0 0 20 20"><rect x="7" y="1" width="6" height="5" rx="1.5" /><rect x="1" y="14" width="6" height="5" rx="1.5" /><rect x="13" y="14" width="6" height="5" rx="1.5" /><path d="M10 6v4M4 14v-2h12v2" fill="none" strokeWidth="1.6" /></svg>
          </span>
          <span>
            <strong>Org Chart for Slack</strong>
            <span className="s-brand-sub">Interactive demo with sample data. Nothing here talks to Slack.</span>
          </span>
        </div>
        <nav className="s-steps" aria-label="Demo steps">
          {STEPS.map((s, i) => (
            <button key={s.id} type="button" className={`s-step${s.id === step ? ' on' : ''}`} aria-current={s.id === step ? 'step' : undefined} onClick={() => goStep(s.id)}>
              <span className="s-step-n">{i + 1}</span>
              {s.label}
            </button>
          ))}
        </nav>
        <label className="s-viewer">
          <span>Viewing as</span>
          <select id="demo-viewer" value={viewer} onChange={(e) => switchViewer(e.target.value)}>
            {VIEWERS.map((v) => (
              <option key={v.id} value={v.id}>
                {v.label}
              </option>
            ))}
          </select>
        </label>
      </header>

      {guide && (
        <div className="s-guide" role="note">
          <span className="s-guide-step">Step {stepIndex + 1} of {STEPS.length}</span>
          <p>{current.text}</p>
          <div className="s-guide-buttons">
            {stepIndex < STEPS.length - 1 && (
              <button type="button" className="s-btn s-btn-primary" onClick={() => goStep(STEPS[stepIndex + 1]!.id)}>
                Next: {STEPS[stepIndex + 1]!.label}
              </button>
            )}
            <button type="button" className="s-btn" onClick={() => setGuide(false)}>
              Hide
            </button>
          </div>
        </div>
      )}

      <div className="s-window">
        <aside className={`s-sidebar${navOpen ? ' open' : ''}`}>
          <div className="s-workspace">
            {WORKSPACE_NAME}
            <span className="s-workspace-sub">Mock workspace</span>
          </div>
          <SideSection title="Channels">
            {['general', 'engineering', 'random'].map((c) => (
              <SideItem key={c} on={view.kind === 'channel' && view.id === c} onClick={() => goSlack({ kind: 'channel', id: c })}>
                <span className="s-hash">#</span>
                {c}
              </SideItem>
            ))}
            {conversations
              .filter((c) => c.kind === 'channel')
              .map((c) => (
                <SideItem key={c.id} on={view.kind === 'conv' && view.id === c.id} onClick={() => goSlack({ kind: 'conv', id: c.id })} fresh>
                  <span className="s-hash">{c.isPrivate ? '🔒' : '#'}</span>
                  {c.name}
                </SideItem>
              ))}
          </SideSection>
          <SideSection title="Direct messages">
            {conversations.filter((c) => c.kind !== 'channel').length === 0 && <div className="s-side-empty">None yet. Start one from the chart.</div>}
            {conversations
              .filter((c) => c.kind !== 'channel')
              .map((c) => (
                <SideItem key={c.id} on={view.kind === 'conv' && view.id === c.id} onClick={() => goSlack({ kind: 'conv', id: c.id })} fresh>
                  <MiniAvatar id={c.members.find((m) => m !== viewer) ?? viewer} />
                  {c.kind === 'dm' ? c.name : c.members.filter((m) => m !== viewer).map(firstName).join(', ')}
                </SideItem>
              ))}
          </SideSection>
          <SideSection title="Apps">
            <SideItem on={view.kind === 'home'} onClick={() => goSlack({ kind: 'home' })}>
              <span className="s-app-icon" aria-hidden="true">OC</span>
              Org Chart
            </SideItem>
          </SideSection>
        </aside>

        <main className="s-main">
          <button type="button" className="s-navtoggle" onClick={() => setNavOpen((o) => !o)} aria-expanded={navOpen}>
            ☰ Channels
          </button>
          {view.kind === 'channel' && (
            <ChannelView id={view.id} onPerson={setProfile} onOpenChart={(id) => openBrowser('chart', id)} />
          )}
          {view.kind === 'home' && <AppHome onOpen={(id) => openBrowser('chart', id)} />}
          {view.kind === 'conv' && <ConversationView conv={state.conversations.get(view.id)} onPerson={setProfile} />}
          {profile && view.kind !== 'home' && (
            <ProfilePanel
              id={profile}
              onClose={() => setProfile(null)}
              onOpenChart={() => openBrowser('chart', profile)}
              onMessage={() => {
                openConversation(openDm(profile));
                refresh();
              }}
            />
          )}
        </main>

        {browser && (
          <section className="s-browser" hidden={!browserShown} aria-label="Browser window">
            <div className="s-browser-bar">
              <span className="s-dots" aria-hidden="true">
                <i />
                <i />
                <i />
              </span>
              <span className="s-url">
                orgchart.acme.example/{browser.page}
                {browser.page === 'chart' ? `?team=${TEAM_ID}${browser.focus ? `&user=${browser.focus}` : ''}` : ''}
              </span>
              <button type="button" className="s-btn" onClick={() => setBrowserShown(false)}>
                Back to Slack
              </button>
            </div>
            <div className="s-browser-body">
              <div className="s-browser-scroll" onClickCapture={onBrowserClick}>
                {browser.page === 'chart' ? <ChartPage key={browser.key} /> : <AdminPage key={browser.key} />}
              </div>
            </div>
          </section>
        )}
        {browser && !browserShown && (
          <button type="button" className="s-reopen" onClick={() => setBrowserShown(true)}>
            Show the org chart window
          </button>
        )}
      </div>

      {ask && (
        <PermissionDialog
          kind={ask.kind}
          onAnswer={(ok) => {
            ask.resolve(ok);
            setAsk(null);
          }}
        />
      )}
    </div>
  );
}

function SideSection({ title, children }: { title: string; children: ReactNode }) {
  return (
    <div className="s-side-section">
      <div className="s-side-title">{title}</div>
      {children}
    </div>
  );
}

function SideItem({ on, onClick, children, fresh }: { on: boolean; onClick: () => void; children: ReactNode; fresh?: boolean }) {
  return (
    <button type="button" className={`s-side-item${on ? ' on' : ''}${fresh ? ' fresh' : ''}`} onClick={onClick}>
      {children}
    </button>
  );
}

function MiniAvatar({ id, size = 20 }: { id: string; size?: number }) {
  const p = person(id);
  const initials = (p?.name ?? '?')
    .split(' ')
    .map((w) => w[0])
    .slice(0, 2)
    .join('');
  return (
    <span className="s-av" style={{ width: size, height: size, fontSize: size * 0.4 }} aria-hidden="true">
      {p?.avatarUrl ? <img src={p.avatarUrl} alt="" /> : initials}
    </span>
  );
}

function badgeWord(n: Pick<ChartNode, 'badge' | 'externalOrg'>) {
  if (!n.badge) return null;
  const word = { guest: '● Guest', external: '▲ External', contractor: '■ Contractor' }[n.badge];
  return (
    <em className={`s-badge s-badge-${n.badge}`}>
      {word}
      {n.badge === 'external' && n.externalOrg ? ` · ${n.externalOrg}` : ''}
    </em>
  );
}

function ChannelView({ id, onPerson, onOpenChart }: { id: string; onPerson: (id: string) => void; onOpenChart: (id: string) => void }) {
  const [draft, setDraft] = useState('');
  const [ephemeral, setEphemeral] = useState<{ query: string; match: string | null } | null>(null);
  const messages = CHANNEL_MESSAGES.filter((m) => m.channel === id);
  return (
    <div className="s-channel">
      <div className="s-channel-head">
        <h2>
          <span className="s-hash">#</span>
          {id}
        </h2>
      </div>
      <div className="s-messages">
        {messages.length === 0 && <p className="s-muted">No messages here yet.</p>}
        {messages.map((m, i) => (
          <Message key={i} from={m.from} time={m.time} onPerson={onPerson}>
            {m.text}
          </Message>
        ))}
        {ephemeral && (
          <div className="s-msg s-ephemeral">
            <span className="s-app-icon lg" aria-hidden="true">OC</span>
            <div className="s-msg-body">
              <div className="s-msg-head">
                <strong>Org Chart</strong>
                <span className="s-app-tag">APP</span>
                <span className="s-muted small">Only visible to you</span>
              </div>
              {ephemeral.match ? (
                <Summary id={ephemeral.match} onOpen={onOpenChart} />
              ) : (
                <p>Nobody on the chart matches "{ephemeral.query}".</p>
              )}
            </div>
          </div>
        )}
      </div>
      <form
        className="s-composer"
        onSubmit={(e) => {
          e.preventDefault();
          const text = draft.trim();
          const m = /^\/orgchart\s*@?(.*)$/i.exec(text);
          if (m) {
            const q = m[1]!.trim().toLowerCase() || nameOf(state.viewer).toLowerCase();
            const match = PEOPLE.find((p) => !p.isDeleted && p.name.toLowerCase().includes(q));
            setEphemeral({ query: m[1]!.trim(), match: match?.id ?? null });
          }
          setDraft('');
        }}
      >
        <input
          id={`composer-${id}`}
          className="s-input"
          value={draft}
          onChange={(e) => setDraft(e.target.value)}
          placeholder={`Message #${id}  (try /orgchart hannah)`}
          aria-label={`Message #${id}`}
        />
      </form>
    </div>
  );
}

function Message({ from, time, onPerson, children }: { from: string; time: string; onPerson: (id: string) => void; children: ReactNode }) {
  const p = person(from);
  return (
    <div className="s-msg">
      <button type="button" className="s-msg-av" onClick={() => onPerson(from)} aria-label={`Open ${p?.name}'s profile`}>
        <MiniAvatar id={from} size={36} />
      </button>
      <div className="s-msg-body">
        <div className="s-msg-head">
          <button type="button" className="s-name" onClick={() => onPerson(from)}>
            {p?.name}
          </button>
          {p?.userType === 'slack_connect' && <span className="s-ext-tag">{p.externalOrg}</span>}
          <span className="s-muted small">{time}</span>
        </div>
        <p>{children}</p>
      </div>
    </div>
  );
}

// What /orgchart and the message shortcut post: one person and where they sit.
function Summary({ id, onOpen }: { id: string; onOpen: (id: string) => void }) {
  const nodes = chartNodes();
  const around = neighborhood(nodes, id);
  if (!around) return <p>{nameOf(id)} is not on the chart.</p>;
  const { person: p, managers, peers, reports } = around;
  const facts: string[] = [];
  if (managers[0]) facts.push(`Reports to ${managers[0].name}`);
  const reportCount = reports.filter((r) => r.kind === 'person').length;
  if (reportCount) facts.push(`${reportCount} direct ${reportCount === 1 ? 'report' : 'reports'}`);
  if (peers.length) facts.push(`${peers.length} ${peers.length === 1 ? 'peer' : 'peers'}`);
  return (
    <div className="s-blocks">
      <PersonBlock node={p} onOpen={onOpen} isViewer={p.id === state.viewer} />
      <p className="s-context">{facts.join('  ·  ') || 'Not placed under a manager yet'}</p>
      <button type="button" className="s-btn s-btn-primary" onClick={() => onOpen(p.id)}>
        Open in org chart
      </button>
    </div>
  );
}

function PersonBlock({ node, onOpen, isViewer }: { node: ChartNode; onOpen: (id: string) => void; isViewer?: boolean }) {
  return (
    <div className="s-person-block">
      <div>
        <button type="button" className="s-link strong" onClick={() => onOpen(node.id)}>
          {node.name}
        </button>
        {isViewer && <span className="s-muted">  (you)</span>}
        <div>{[node.title, node.department].filter(Boolean).join(' · ')}</div>
        {badgeWord(node)}
      </div>
      {node.avatarUrl && <img className="s-block-img" src={node.avatarUrl} alt={node.name} />}
    </div>
  );
}

// App Home, as src/server/slack/surfaces.ts homeBlocks() lays it out.
function AppHome({ onOpen }: { onOpen: (id: string | null) => void }) {
  const [tab, setTab] = useState<'home' | 'about'>('home');
  const nodes = useMemo(() => chartNodes(), [state.overrides.size, state.audit.length, state.viewer]);
  const around = neighborhood(nodes, state.viewer);
  const p = person(state.viewer)!;
  const blocked = ['multi_channel_guest', 'single_channel_guest'].includes(p.userType) && !state.settings.allowGuestViewers;
  const group = (title: string, list: ChartNode[], limit: number) => {
    const people = list.filter((n) => n.kind === 'person');
    if (!people.length) return null;
    return (
      <>
        <h3 className="s-block-header">
          {title} ({people.length})
        </h3>
        {people.slice(0, limit).map((n) => (
          <PersonBlock key={n.id} node={n} onOpen={onOpen} />
        ))}
        {people.length > limit && (
          <button type="button" className="s-link small" onClick={() => onOpen(state.viewer)}>
            and {people.length - limit} more in the full chart
          </button>
        )}
      </>
    );
  };
  return (
    <div className="s-channel">
      <div className="s-channel-head">
        <h2>
          <span className="s-app-icon" aria-hidden="true">OC</span> Org Chart
        </h2>
        <div className="s-tabs" role="tablist">
          <button type="button" role="tab" aria-selected={tab === 'home'} className={tab === 'home' ? 'on' : ''} onClick={() => setTab('home')}>
            Home
          </button>
          <button type="button" role="tab" aria-selected={tab === 'about'} className={tab === 'about' ? 'on' : ''} onClick={() => setTab('about')}>
            About
          </button>
        </div>
      </div>
      <div className="s-messages s-home">
        {tab === 'about' ? (
          <p className="s-muted">
            Org Chart syncs names, titles, photos and the Manager field from Slack profiles every night and as they change,
            and draws the company as a chart you can search and start conversations from.
          </p>
        ) : blocked ? (
          <p className="s-context">Guests cannot view the org chart in this workspace. An org chart admin can allow it.</p>
        ) : (
          <div className="s-blocks">
            <h3 className="s-block-header big">Your place in the org chart</h3>
            <div>
              <button type="button" className="s-btn s-btn-primary" onClick={() => onOpen(null)}>
                Open full chart
              </button>
            </div>
            {around ? (
              <>
                <PersonBlock node={around.person} onOpen={onOpen} isViewer />
                {!around.managers.length && !around.reports.length && (
                  <p className="s-context">No manager is set for you yet. Ask an org chart admin, or set Manager on your Slack profile.</p>
                )}
                {group('Reports to', around.managers.slice(0, 3), 3)}
                {group('Works with', around.peers, 10)}
                {group('Direct reports', around.reports, 20)}
              </>
            ) : (
              <p className="s-context">You are not on the chart yet. It fills in after the next sync, or an org chart admin can add you.</p>
            )}
          </div>
        )}
      </div>
    </div>
  );
}

function ConversationView({ conv, onPerson }: { conv: Conversation | undefined; onPerson: (id: string) => void }) {
  if (!conv) return <div className="s-channel" />;
  const others = conv.members.filter((m) => m !== state.viewer);
  const title = conv.kind === 'channel' ? `${conv.isPrivate ? '🔒 ' : '# '}${conv.name}` : conv.kind === 'dm' ? conv.name : others.map(firstName).join(', ');
  return (
    <div className="s-channel">
      <div className="s-channel-head">
        <h2>{title}</h2>
        <span className="s-member-stack" aria-label={`${conv.members.length} members`}>
          {conv.members.slice(0, 5).map((m) => (
            <MiniAvatar key={m} id={m} size={22} />
          ))}
          <span className="s-muted small">{conv.members.length}</span>
        </span>
      </div>
      <div className="s-messages">
        <div className="s-intro">
          <div className="s-intro-avatars">
            {others.slice(0, 8).map((m) => (
              <button key={m} type="button" className="s-msg-av" onClick={() => onPerson(m)} aria-label={`Open ${nameOf(m)}'s profile`}>
                <MiniAvatar id={m} size={56} />
              </button>
            ))}
          </div>
          {conv.kind === 'dm' && <p>This conversation is just between you and <strong>{conv.name}</strong>.</p>}
          {conv.kind === 'group' && (
            <p>
              This is the very beginning of your group conversation with <strong>{others.map(nameOf).join(', ')}</strong>.
            </p>
          )}
          {conv.kind === 'channel' && (
            <>
              <p>
                You created this {conv.isPrivate ? 'private ' : ''}channel today from Org Chart. Members:{' '}
                <strong>{conv.members.map(nameOf).join(', ')}</strong>.
              </p>
              {conv.notInvited && conv.notInvited.length > 0 && (
                <p className="s-context">
                  Not added: {conv.notInvited.map((n) => `${nameOf(n.userId)} ${n.reason}`).join('; ')}.
                </p>
              )}
            </>
          )}
          <p className="s-muted small">Opened from the org chart, the same way the app opens it in your Slack.</p>
        </div>
      </div>
      <form className="s-composer" onSubmit={(e) => e.preventDefault()}>
        <input id={`composer-${conv.id}`} className="s-input" placeholder={`Message ${title}`} aria-label={`Message ${title}`} />
      </form>
    </div>
  );
}

function ProfilePanel({ id, onClose, onOpenChart, onMessage }: { id: string; onClose: () => void; onOpenChart: () => void; onMessage: () => void }) {
  const p = person(id);
  if (!p) return null;
  const node = chartNodes().find((n) => n.id === id);
  const linkOn = Boolean(state.profileLink.fieldId === 'Xf06ORGCHART' && state.profileLink.writer);
  return (
    <aside className="s-profile" aria-label={`${p.name}'s profile`}>
      <div className="s-profile-head">
        <strong>Profile</strong>
        <button type="button" className="s-close" aria-label="Close profile" onClick={onClose}>
          ×
        </button>
      </div>
      <div className="s-profile-photo">{p.avatarUrl ? <img src={p.avatarUrl} alt="" /> : <MiniAvatar id={id} size={160} />}</div>
      <h2>{p.name}</h2>
      <p>{node?.title ?? p.title}</p>
      {node && badgeWord(node)}
      {p.userType === 'slack_connect' && <p className="s-muted small">From {p.externalOrg}, via Slack Connect</p>}
      <div className="s-profile-buttons">
        {id !== state.viewer && (
          <button type="button" className="s-btn" onClick={onMessage}>
            Message
          </button>
        )}
      </div>
      <dl className="s-fields">
        <dt>Email</dt>
        <dd>{p.email}</dd>
        {p.managerId && person(p.managerId) && (
          <>
            <dt>Manager</dt>
            <dd>{nameOf(p.managerId)}</dd>
          </>
        )}
        {p.userType !== 'slack_connect' && (
          <>
            <dt>Org chart</dt>
            <dd>
              {linkOn ? (
                <button type="button" className="s-link s-pulse" onClick={onOpenChart}>
                  View in org chart ↗
                </button>
              ) : (
                <span className="s-muted">Not filled in. An admin turns this on under Admin, Settings.</span>
              )}
            </dd>
          </>
        )}
      </dl>
    </aside>
  );
}

function PermissionDialog({ kind, onAnswer }: { kind: 'actions' | 'profile'; onAnswer: (ok: boolean) => void }) {
  const lines =
    kind === 'actions'
      ? ['Start direct messages and group DMs for you', 'Create channels and invite people for you']
      : ["Edit the Org chart field on members' profiles"];
  return (
    <div className="s-backdrop">
      <div className="s-consent" role="dialog" aria-modal="true" aria-labelledby="consent-title">
        <div className="s-consent-apps" aria-hidden="true">
          <span className="s-app-icon lg">OC</span>
          <span className="s-consent-arrow">⇄</span>
          <span className="s-ws-icon">A</span>
        </div>
        <h2 id="consent-title">Org Chart is asking to access {WORKSPACE_NAME}</h2>
        <p className="s-muted small">This is Slack's own permission screen, shown once. Mocked here.</p>
        <p>What will Org Chart be able to do?</p>
        <ul>
          {lines.map((l) => (
            <li key={l}>{l}</li>
          ))}
        </ul>
        <div className="s-consent-buttons">
          <button type="button" className="s-btn" onClick={() => onAnswer(false)}>
            Cancel
          </button>
          <button type="button" className="s-btn s-btn-primary" autoFocus onClick={() => onAnswer(true)}>
            Allow
          </button>
        </div>
      </div>
    </div>
  );
}

installMockApi();

createRoot(document.getElementById('root')!).render(
  <StrictMode>
    <Demo />
  </StrictMode>,
);
