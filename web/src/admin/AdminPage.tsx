import { useCallback, useEffect, useMemo, useState } from 'react';
import type { AdminPerson } from '../../../src/shared/admin';
import { ApiFailure, adminApi } from './adminApi';
import { PeopleTab } from './PeopleTab';
import { AdminsTab, HistoryTab, ImportTab, SettingsTab } from './OtherTabs';

const TABS = [
  { id: 'people', label: 'People' },
  { id: 'import', label: 'Import' },
  { id: 'admins', label: 'Admins' },
  { id: 'settings', label: 'Settings' },
  { id: 'history', label: 'History' },
] as const;
type Tab = (typeof TABS)[number]['id'];

const readTab = (): Tab => {
  const hash = window.location.hash.slice(1);
  return TABS.some((t) => t.id === hash) ? (hash as Tab) : 'people';
};

type State =
  | { status: 'loading' }
  | { status: 'denied'; message: string }
  | { status: 'error'; message: string }
  | { status: 'ok'; people: AdminPerson[]; me: string };

export function AdminPage() {
  const [state, setState] = useState<State>({ status: 'loading' });
  const [tab, setTab] = useState<Tab>(readTab);

  const load = useCallback(async () => {
    try {
      const [me, res] = await Promise.all([adminApi.me(), adminApi.people()]);
      setState({ status: 'ok', people: res.people, me: me.slackUserId });
    } catch (err) {
      if (err instanceof ApiFailure && err.status === 403) setState({ status: 'denied', message: err.message });
      else setState({ status: 'error', message: err instanceof Error ? err.message : String(err) });
    }
  }, []);

  useEffect(() => {
    void load();
    const onHash = () => setTab(readTab());
    window.addEventListener('hashchange', onHash);
    return () => window.removeEventListener('hashchange', onHash);
  }, [load]);

  const byId = useMemo(
    () => new Map(state.status === 'ok' ? state.people.map((p) => [p.slackUserId, p]) : []),
    [state],
  );

  if (state.status === 'loading') return <div className="state">Loading the admin page…</div>;
  if (state.status !== 'ok') {
    return (
      <div className="state">
        <h1>{state.status === 'denied' ? 'No access' : 'Something went wrong'}</h1>
        <p>{state.message}</p>
        <a href="/chart">Open the chart</a>
      </div>
    );
  }

  return (
    <div className="admin-page">
      <header className="toolbar">
        <div className="toolbar-title">Org chart admin</div>
        <nav className="tabs" aria-label="Admin sections">
          {TABS.map((t) => (
            <a key={t.id} href={`#${t.id}`} className={`tab${tab === t.id ? ' on' : ''}`} aria-current={tab === t.id ? 'page' : undefined}>
              {t.label}
            </a>
          ))}
        </nav>
        <a className="button" href="/chart">
          Back to chart
        </a>
      </header>
      <main className="admin-main">
        {tab === 'people' && <PeopleTab people={state.people} byId={byId} reload={load} />}
        {tab === 'import' && <ImportTab byId={byId} reload={load} />}
        {tab === 'admins' && <AdminsTab people={state.people} me={state.me} />}
        {tab === 'settings' && <SettingsTab />}
        {tab === 'history' && <HistoryTab byId={byId} />}
      </main>
    </div>
  );
}
