import { useEffect, useMemo, useState } from 'react';
import type {
  AdminEntry,
  AdminPerson,
  AuditEntry,
  ImportResponse,
  ProfileLinkSettings,
  SyncRunInfo,
  WorkspaceSettings,
} from '../../../src/shared/admin';
import { badgeFor } from '../../../src/shared/chart';
import { avatarHtml } from '../card';
import { adminApi } from './adminApi';
import { describeChange, formatTime } from './labels';
import { PersonPicker } from './PersonPicker';

const message = (err: unknown) => (err instanceof Error ? err.message : String(err));

export function ImportTab({ byId, reload }: { byId: Map<string, AdminPerson>; reload: () => Promise<void> }) {
  const [csv, setCsv] = useState('');
  const [result, setResult] = useState<ImportResponse | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const run = async (apply: boolean) => {
    setBusy(true);
    setError(null);
    try {
      const res = await adminApi.importCsv(csv, apply);
      setResult(res);
      if (apply) await reload();
    } catch (err) {
      setError(message(err));
      setResult(null);
    } finally {
      setBusy(false);
    }
  };

  return (
    <section className="admin-section narrow">
      <h2>Import reporting lines</h2>
      <p>
        Upload a CSV from your HR system with the columns <code>email</code> and <code>manager_email</code>. The
        columns <code>title</code> and <code>department</code> are optional. A blank cell leaves that value as it is.
        You see a preview before anything changes.
      </p>
      <pre className="sample">{'email,manager_email,title\nerin@acme.com,theo@acme.com,Engineer'}</pre>
      <label className="field">
        <span>CSV file</span>
        <input
          type="file"
          accept=".csv,text/csv"
          onChange={async (e) => {
            const file = e.target.files?.[0];
            if (file) {
              setCsv(await file.text());
              setResult(null);
            }
          }}
        />
      </label>
      <label className="field">
        <span>Or paste it here</span>
        <textarea
          className="text-input"
          rows={6}
          value={csv}
          onChange={(e) => {
            setCsv(e.target.value);
            setResult(null);
          }}
        />
      </label>
      <div className="editor-actions">
        <button type="button" disabled={busy || !csv.trim()} onClick={() => run(false)}>
          Preview
        </button>
        {result && !result.applied && result.changed > 0 && (
          <button type="button" className="button primary" disabled={busy} onClick={() => run(true)}>
            Apply {result.changed} {result.changed === 1 ? 'change' : 'changes'}
          </button>
        )}
      </div>
      {error && (
        <p className="note note-error" role="alert">
          {error}
        </p>
      )}
      {result && (
        <>
          <p className={result.applied ? 'note note-ok' : 'note'} role="status">
            {result.applied ? 'Applied. ' : 'Preview. '}
            {result.changed} to change, {result.rows.filter((r) => r.status === 'unchanged').length} already right,{' '}
            {result.errors} with problems.
          </p>
          <div className="table-wrap">
            <table className="people-table">
              <thead>
                <tr>
                  <th scope="col">Line</th>
                  <th scope="col">Email</th>
                  <th scope="col">Result</th>
                </tr>
              </thead>
              <tbody>
                {result.rows.map((r) => (
                  <tr key={r.line}>
                    <td>{r.line}</td>
                    <td>{r.email}</td>
                    <td>
                      {r.status === 'error' ? (
                        <span className="tag tag-warn">{r.message}</span>
                      ) : (
                        <>
                          {byId.get(r.slackUserId ?? '')?.name}
                          {r.managerSlackId ? ` reports to ${byId.get(r.managerSlackId)?.name ?? r.managerSlackId}` : ''}
                          {r.status === 'unchanged' && <span className="muted"> (no change)</span>}
                        </>
                      )}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </>
      )}
    </section>
  );
}

export function AdminsTab({ people, me }: { people: AdminPerson[]; me: string }) {
  const [admins, setAdmins] = useState<AdminEntry[] | null>(null);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    adminApi.admins().then((r) => setAdmins(r.admins), (err) => setError(message(err)));
  }, []);

  const eligible = useMemo(() => {
    const current = new Set(admins?.map((a) => a.slackUserId));
    return people.filter(
      (p) =>
        !p.isDeleted &&
        !current.has(p.slackUserId) &&
        !badgeFor(p.slack.userType) &&
        !badgeFor(p.effective.userType),
    );
  }, [people, admins]);

  const change = async (fn: () => Promise<{ admins: AdminEntry[] }>) => {
    setError(null);
    try {
      setAdmins((await fn()).admins);
    } catch (err) {
      setError(message(err));
    }
  };

  return (
    <section className="admin-section narrow">
      <h2>Admins</h2>
      <p>
        Admins can edit people, fix reporting lines and change settings. Guests, Slack Connect people, contractors
        and external people cannot be admins.
      </p>
      <PersonPicker label="Add an admin" placeholder="Add an admin by name or email" people={eligible} onPick={(p) => change(() => adminApi.addAdmin(p.slackUserId))} />
      {error && (
        <p className="note note-error" role="alert">
          {error}
        </p>
      )}
      {!admins ? (
        <p className="muted">Loading…</p>
      ) : (
        <ul className="admin-list">
          {admins.map((a) => (
            <li key={a.slackUserId}>
              <span dangerouslySetInnerHTML={{ __html: avatarHtml({ name: a.name ?? '?', avatarUrl: a.avatarUrl }) }} />
              <span className="result-text">
                <span className="result-name">
                  {a.name ?? a.slackUserId}
                  {a.slackUserId === me && <span className="you">You</span>}
                </span>
                <span className="result-title">
                  {a.source === 'slack_admin'
                    ? 'Slack owner or admin'
                    : a.grantedBy === 'install'
                      ? 'Installed the app'
                      : `Added ${formatTime(a.grantedAt)}`}
                </span>
              </span>
              {a.source === 'role' && (
                <button
                  type="button"
                  disabled={admins.filter((x) => x.source === 'role').length <= 1}
                  onClick={() => {
                    if (a.slackUserId !== me || window.confirm('Remove your own admin rights? You will lose access to this page.')) {
                      void change(() => adminApi.removeAdmin(a.slackUserId)).then(() => {
                        if (a.slackUserId === me) window.location.assign('/chart');
                      });
                    }
                  }}
                >
                  Remove
                </button>
              )}
            </li>
          ))}
        </ul>
      )}
    </section>
  );
}

export function SettingsTab() {
  const [settings, setSettings] = useState<WorkspaceSettings | null>(null);
  const [sync, setSync] = useState<{ runs: SyncRunInfo[]; canStart: boolean } | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [syncQueued, setSyncQueued] = useState(false);

  useEffect(() => {
    adminApi.settings().then(setSettings, (err) => setError(message(err)));
    adminApi.sync().then(setSync, () => {});
  }, []);

  const toggle = async (key: keyof WorkspaceSettings, value: boolean) => {
    setError(null);
    try {
      setSettings(await adminApi.updateSettings({ [key]: value }));
    } catch (err) {
      setError(message(err));
    }
  };

  return (
    <section className="admin-section narrow">
      <h2>Settings</h2>
      {error && (
        <p className="note note-error" role="alert">
          {error}
        </p>
      )}
      {settings && (
        <>
          <label className="check">
            <input
              type="checkbox"
              checked={settings.allowGuestViewers}
              onChange={(e) => toggle('allowGuestViewers', e.target.checked)}
            />
            Let guests and external people view the chart
            <span className="hint">Off by default, because the chart shows the whole company.</span>
          </label>
          <label className="check">
            <input
              type="checkbox"
              checked={settings.autoAdminSlackAdmins}
              onChange={(e) => toggle('autoAdminSlackAdmins', e.target.checked)}
            />
            Slack owners and admins are org chart admins
            <span className="hint">Otherwise only the people on the Admins tab are.</span>
          </label>
        </>
      )}

      <h2>Sync with Slack</h2>
      <p>Profiles sync every night and whenever someone changes their profile.</p>
      {sync?.canStart && (
        <button
          type="button"
          disabled={syncQueued}
          onClick={async () => {
            try {
              await adminApi.startSync();
              setSyncQueued(true);
            } catch (err) {
              setError(message(err));
            }
          }}
        >
          {syncQueued ? 'Sync queued' : 'Sync now'}
        </button>
      )}
      {sync && sync.runs.length > 0 && (
        <ul className="sync-list">
          {sync.runs.filter((r) => r.kind !== 'profile_links').map((r) => (
            <li key={r.startedAt}>
              <span>{formatTime(r.startedAt)}</span>
              <span className="muted">
                {r.finishedAt ? summarize(r.counts) : 'running'}
                {r.errorCount > 0 && `, ${r.errorCount} ${r.errorCount === 1 ? 'problem' : 'problems'}`}
              </span>
            </li>
          ))}
        </ul>
      )}

      <ProfileLinkSection />
    </section>
  );
}

// The profile link field: Slack has no button for apps on the profile card,
// so a link field on every profile opens the chart on that person.
function ProfileLinkSection() {
  const [state, setState] = useState<ProfileLinkSettings | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [queued, setQueued] = useState(false);
  const granted = new URLSearchParams(window.location.search).get('grant');

  useEffect(() => {
    adminApi.profileLink().then(setState, (err) => setError(message(err)));
  }, []);

  const run = async (fn: () => Promise<ProfileLinkSettings>) => {
    setError(null);
    try {
      setState(await fn());
    } catch (err) {
      setError(message(err));
    }
  };
  const connectUrl = `/auth/grant?kind=profile&next=${encodeURIComponent('/admin#settings')}`;

  return (
    <>
      <h2>Org chart link on profiles</h2>
      <p>
        Slack does not let apps add a button to the profile card. Instead, add a custom profile field of type{' '}
        <strong>Link</strong> named &ldquo;Org chart&rdquo; (Slack admin settings, Profiles), pick it here and connect
        an admin account. Every profile then shows a link that opens the chart on that person. Needs Slack Pro or
        higher, and a Slack admin or owner to connect.
      </p>
      {granted === 'cancelled' && <p className="note note-warn">Slack access was not granted, so nothing changed.</p>}
      {error && (
        <p className="note note-error" role="alert">
          {error}
        </p>
      )}
      {state && (
        <>
          <label className="field">
            <span>Link field</span>
            <select
              className="text-input"
              value={state.fieldId ?? ''}
              onChange={(e) => run(() => adminApi.setProfileLinkField(e.target.value || null))}
            >
              <option value="">Off</option>
              {state.fields.map((f) => (
                <option key={f.id} value={f.id}>
                  {f.label}
                </option>
              ))}
              {state.fieldId && !state.fields.some((f) => f.id === state.fieldId) && (
                <option value={state.fieldId}>Field {state.fieldId} (not found in Slack)</option>
              )}
            </select>
            {state.fields.length === 0 && (
              <span className="hint">No link fields found yet. Add one in Slack, then reload this page.</span>
            )}
          </label>
          <p>
            {state.writer ? (
              <>
                Connected by <strong>{state.writer.name ?? state.writer.slackUserId}</strong>.{' '}
                <button type="button" className="link" onClick={() => run(adminApi.disconnectProfileWriter)}>
                  Disconnect
                </button>
              </>
            ) : (
              <a className="button" href={connectUrl}>
                Connect a Slack admin account
              </a>
            )}
          </p>
          {state.writer && state.fieldId && state.canFill && (
            <button
              type="button"
              disabled={queued}
              onClick={async () => {
                try {
                  await adminApi.fillProfileLinks();
                  setQueued(true);
                } catch (err) {
                  setError(message(err));
                }
              }}
            >
              {queued ? 'Fill queued' : 'Fill links now'}
            </button>
          )}
          {state.lastRun && (
            <p className="muted small">
              Last fill {formatTime(state.lastRun.startedAt)}:{' '}
              {state.lastRun.finishedAt ? summarize(state.lastRun.counts) : 'running'}
              {state.lastRun.errorCount > 0 &&
                `, ${state.lastRun.errorCount} ${state.lastRun.errorCount === 1 ? 'problem' : 'problems'}`}
            </p>
          )}
        </>
      )}
    </>
  );
}

function summarize(counts: unknown): string {
  const links = (counts ?? {}) as { written?: number; unchanged?: number };
  if (typeof links.written === 'number') return `${links.written} links written, ${links.unchanged ?? 0} already set`;
  const c = (counts ?? {}) as { members?: number; slackConnect?: number };
  const parts = [];
  if (typeof c.members === 'number') parts.push(`${c.members} members`);
  if (typeof c.slackConnect === 'number' && c.slackConnect) parts.push(`${c.slackConnect} Slack Connect`);
  return parts.join(', ') || 'done';
}

export function HistoryTab({ byId }: { byId: Map<string, AdminPerson> }) {
  const [entries, setEntries] = useState<AuditEntry[]>([]);
  const [next, setNext] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  const load = async (before?: string) => {
    setLoading(true);
    try {
      const res = await adminApi.audit(before);
      setEntries((prev) => (before ? [...prev, ...res.entries] : res.entries));
      setNext(res.next);
    } catch (err) {
      setError(message(err));
    } finally {
      setLoading(false);
    }
  };
  useEffect(() => {
    void load();
  }, []);

  const nameOf = (id: string) => byId.get(id)?.name ?? id;

  return (
    <section className="admin-section narrow">
      <h2>History</h2>
      <p>Every change an admin makes, newest first.</p>
      {error && (
        <p className="note note-error" role="alert">
          {error}
        </p>
      )}
      {!loading && entries.length === 0 && <p className="empty">No changes yet.</p>}
      <ol className="history">
        {entries.map((e) => (
          <li key={e.id}>
            <div>
              <strong>{e.actorName ?? e.actor}</strong> {describeChange(e, nameOf)}
            </div>
            <time className="muted small" dateTime={e.at}>
              {formatTime(e.at)}
            </time>
          </li>
        ))}
      </ol>
      {next && (
        <button type="button" disabled={loading} onClick={() => load(next)}>
          Show older
        </button>
      )}
    </section>
  );
}
