import { useEffect, useMemo, useState } from 'react';
import type { AdminPerson, AssignableType, PersonPatch } from '../../../src/shared/admin';
import { badgeFor } from '../../../src/shared/chart';
import { avatarHtml, badgeHtml } from '../card';
import { adminApi } from './adminApi';
import { ISSUE_HELP, ISSUE_LABEL, TYPE_LABEL } from './labels';
import { PersonPicker } from './PersonPicker';

type Filter = 'all' | 'attention' | 'external' | 'hidden' | 'edited' | 'deactivated';

const FILTERS: { id: Filter; label: string; test: (p: AdminPerson) => boolean }[] = [
  { id: 'all', label: 'Everyone', test: (p) => !p.isDeleted },
  { id: 'attention', label: 'Needs attention', test: (p) => !p.isDeleted && !p.effective.hidden && p.issues.length > 0 },
  { id: 'external', label: 'External', test: (p) => !p.isDeleted && Boolean(badgeFor(p.effective.userType)) },
  { id: 'hidden', label: 'Hidden', test: (p) => !p.isDeleted && p.effective.hidden },
  { id: 'edited', label: 'Edited', test: (p) => p.override !== null },
  { id: 'deactivated', label: 'Deactivated', test: (p) => p.isDeleted },
];

export function PeopleTab({
  people,
  byId,
  reload,
}: {
  people: AdminPerson[];
  byId: Map<string, AdminPerson>;
  reload: () => Promise<void>;
}) {
  const [filter, setFilter] = useState<Filter>(() =>
    people.some((p) => FILTERS[1]!.test(p)) ? 'attention' : 'all',
  );
  const [query, setQuery] = useState('');
  const [editing, setEditing] = useState<string | null>(null);

  const counts = useMemo(
    () => Object.fromEntries(FILTERS.map((f) => [f.id, people.filter(f.test).length])) as Record<Filter, number>,
    [people],
  );
  const shown = useMemo(() => {
    const test = FILTERS.find((f) => f.id === filter)!.test;
    const q = query.trim().toLowerCase();
    return people
      .filter(test)
      .filter(
        (p) =>
          !q ||
          [p.name, p.email, p.effective.title, p.effective.department, p.effective.externalOrg].some((v) =>
            v?.toLowerCase().includes(q),
          ),
      );
  }, [people, filter, query]);

  const editingPerson = editing ? byId.get(editing) : undefined;

  return (
    <section className="admin-section people-tab">
      <div className="people-controls">
        <input
          type="search"
          className="text-input"
          placeholder="Search name, email, title or company"
          aria-label="Search people"
          value={query}
          onChange={(e) => setQuery(e.target.value)}
        />
        <div className="chips" role="tablist" aria-label="Filter people">
          {FILTERS.map((f) => (
            <button
              key={f.id}
              type="button"
              role="tab"
              aria-selected={filter === f.id}
              className={`chip${filter === f.id ? ' on' : ''}`}
              onClick={() => setFilter(f.id)}
            >
              {f.label} <span className="chip-count">{counts[f.id]}</span>
            </button>
          ))}
        </div>
      </div>

      {shown.length === 0 ? (
        <p className="empty">
          {filter === 'attention' && !query ? 'Everyone has a place on the chart.' : 'Nobody matches.'}
        </p>
      ) : (
        <div className="table-wrap">
          <table className="people-table">
            <thead>
              <tr>
                <th scope="col">Person</th>
                <th scope="col">Title</th>
                <th scope="col">Manager</th>
                <th scope="col">Type</th>
                <th scope="col">Status</th>
              </tr>
            </thead>
            <tbody>
              {shown.slice(0, 500).map((p) => (
                <tr
                  key={p.slackUserId}
                  className={editing === p.slackUserId ? 'selected' : undefined}
                  onClick={() => setEditing(p.slackUserId)}
                >
                  <td>
                    <button type="button" className="row-person" onClick={() => setEditing(p.slackUserId)}>
                      <span dangerouslySetInnerHTML={{ __html: avatarHtml(p) }} />
                      <span className="result-text">
                        <span className="result-name">{p.name}</span>
                        <span className="result-title">{p.email}</span>
                      </span>
                    </button>
                  </td>
                  <td>
                    {p.effective.title}
                    {p.effective.department && <div className="muted small">{p.effective.department}</div>}
                  </td>
                  <td>{managerLabel(p, byId)}</td>
                  <td>
                    <span
                      dangerouslySetInnerHTML={{
                        __html: badgeHtml(badgeFor(p.effective.userType), p.effective.externalOrg) || 'Employee',
                      }}
                    />
                  </td>
                  <td className="status-cell">
                    {p.isDeleted && <span className="tag">Deactivated</span>}
                    {p.effective.hidden && <span className="tag">Hidden</span>}
                    {p.isAdmin && <span className="tag tag-admin">Admin</span>}
                    {!p.effective.hidden &&
                      p.issues.map((i) => (
                        <span key={i} className="tag tag-warn" title={ISSUE_HELP[i]}>
                          {ISSUE_LABEL[i]}
                        </span>
                      ))}
                    {p.override && <span className="tag tag-edited">Edited</span>}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
          {shown.length > 500 && <p className="muted small">Showing 500 of {shown.length}. Search to narrow it down.</p>}
        </div>
      )}

      {editingPerson && (
        <PersonEditor
          key={editingPerson.slackUserId}
          person={editingPerson}
          people={people}
          byId={byId}
          onClose={() => setEditing(null)}
          onSaved={reload}
        />
      )}
    </section>
  );
}

function managerLabel(p: AdminPerson, byId: Map<string, AdminPerson>) {
  const id = p.effective.managerSlackId;
  const name = id ? (byId.get(id)?.name ?? id) : null;
  const shownUnder = p.chartParentId && p.chartParentId !== id ? byId.get(p.chartParentId)?.name : null;
  return (
    <>
      {name ?? <span className="muted">None</span>}
      {p.override?.managerSlackId !== null && p.override?.managerSlackId !== undefined && (
        <span className="muted small"> (set here)</span>
      )}
      {shownUnder && <div className="muted small">Shown under {shownUnder}</div>}
    </>
  );
}

type ManagerChoice = { mode: 'slack' } | { mode: 'none' } | { mode: 'person'; id: string };

function PersonEditor({
  person,
  people,
  byId,
  onClose,
  onSaved,
}: {
  person: AdminPerson;
  people: AdminPerson[];
  byId: Map<string, AdminPerson>;
  onClose: () => void;
  onSaved: () => Promise<void>;
}) {
  const o = person.override;
  const [manager, setManager] = useState<ManagerChoice>(() =>
    o?.managerSlackId === null || o?.managerSlackId === undefined
      ? { mode: 'slack' }
      : o.managerSlackId === ''
        ? { mode: 'none' }
        : { mode: 'person', id: o.managerSlackId },
  );
  const [title, setTitle] = useState(o?.title ?? '');
  const [department, setDepartment] = useState(o?.department ?? '');
  const [userType, setUserType] = useState<AssignableType | ''>((o?.userType as AssignableType | null) ?? '');
  const [externalOrg, setExternalOrg] = useState(o?.externalOrg ?? '');
  const [hidden, setHidden] = useState(o?.hidden ?? false);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [saved, setSaved] = useState(false);

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => e.key === 'Escape' && onClose();
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [onClose]);

  const slackManager = person.slack.managerSlackId ? byId.get(person.slack.managerSlackId) : undefined;
  const slackIsOutside = Boolean(badgeFor(person.slack.userType));
  const effectiveType = userType || person.slack.userType;
  const showsCompany = Boolean(badgeFor(effectiveType));
  const candidates = useMemo(
    () => people.filter((p) => !p.isDeleted && p.slackUserId !== person.slackUserId),
    [people, person.slackUserId],
  );

  const save = async (patch: PersonPatch) => {
    setSaving(true);
    setError(null);
    setSaved(false);
    try {
      await adminApi.updatePerson(person.slackUserId, patch);
      await onSaved();
      setSaved(true);
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setSaving(false);
    }
  };

  const submit = (e: React.FormEvent) => {
    e.preventDefault();
    void save({
      managerSlackId: manager.mode === 'slack' ? null : manager.mode === 'none' ? '' : manager.id,
      title: title.trim() || null,
      department: department.trim() || null,
      userType: userType || null,
      externalOrg: showsCompany ? externalOrg.trim() || null : null,
      hidden: hidden ? true : null,
    });
  };

  const resetAll = () =>
    void save({
      managerSlackId: null,
      title: null,
      department: null,
      userType: null,
      externalOrg: null,
      hidden: null,
      sortOrder: null,
    });

  return (
    <aside className="editor" aria-label={`Edit ${person.name}`}>
      <form onSubmit={submit}>
        <header className="editor-head">
          <span dangerouslySetInnerHTML={{ __html: avatarHtml(person, 'lg') }} />
          <div>
            <h2>{person.name}</h2>
            {person.email && <p className="muted">{person.email}</p>}
            {!person.isDeleted && (
              <a href={`/chart?user=${encodeURIComponent(person.slackUserId)}`} target="_blank" rel="noreferrer">
                View on chart
              </a>
            )}
          </div>
          <button type="button" className="panel-close" aria-label="Close" onClick={onClose}>
            ×
          </button>
        </header>

        {person.isDeleted && <p className="note">This account is deactivated in Slack and is not on the chart.</p>}
        {!person.effective.hidden &&
          person.issues.map((i) => (
            <p key={i} className="note note-warn">
              {ISSUE_HELP[i]}
            </p>
          ))}

        <fieldset>
          <legend>Manager</legend>
          <label className="radio">
            <input type="radio" checked={manager.mode === 'slack'} onChange={() => setManager({ mode: 'slack' })} />
            Use Slack: {slackManager?.name ?? (person.slack.managerSlackId ? 'unknown member' : 'nobody')}
          </label>
          <label className="radio">
            <input type="radio" checked={manager.mode === 'none'} onChange={() => setManager({ mode: 'none' })} />
            No manager (top of the chart)
          </label>
          <label className="radio">
            <input
              type="radio"
              checked={manager.mode === 'person'}
              onChange={() => setManager({ mode: 'person', id: manager.mode === 'person' ? manager.id : '' })}
            />
            Someone else{manager.mode === 'person' && manager.id ? `: ${byId.get(manager.id)?.name ?? manager.id}` : ''}
          </label>
          {manager.mode === 'person' && (
            <PersonPicker
              label="Pick a manager"
              people={candidates}
              onPick={(p) => setManager({ mode: 'person', id: p.slackUserId })}
            />
          )}
        </fieldset>

        <label className="field">
          <span>Title</span>
          <input
            className="text-input"
            value={title}
            maxLength={200}
            placeholder={person.slack.title ?? 'No title in Slack'}
            onChange={(e) => setTitle(e.target.value)}
          />
          <span className="hint">Leave empty to use Slack{person.slack.title ? `: ${person.slack.title}` : ''}.</span>
        </label>

        <label className="field">
          <span>Department</span>
          <input
            className="text-input"
            value={department}
            maxLength={200}
            placeholder={person.slack.department ?? 'No department in Slack'}
            onChange={(e) => setDepartment(e.target.value)}
          />
        </label>

        <label className="field">
          <span>Type</span>
          <select className="text-input" value={userType} onChange={(e) => setUserType(e.target.value as AssignableType | '')}>
            <option value="">Use Slack: {TYPE_LABEL[person.slack.userType]}</option>
            {!slackIsOutside && <option value="employee">Employee</option>}
            <option value="contractor">Contractor</option>
            <option value="external">External</option>
          </select>
          <span className="hint">
            {slackIsOutside
              ? 'Slack lists this person as a guest or from another company, so they always stay marked.'
              : 'Contractors and external people get a badge and cannot see the chart or be admins unless you allow guests.'}
          </span>
        </label>

        {showsCompany && (
          <label className="field">
            <span>Company</span>
            <input
              className="text-input"
              value={externalOrg}
              maxLength={200}
              placeholder={person.slack.externalOrg ?? 'Their company name'}
              onChange={(e) => setExternalOrg(e.target.value)}
            />
          </label>
        )}

        <label className="check">
          <input type="checkbox" checked={hidden} onChange={(e) => setHidden(e.target.checked)} />
          Hide from the chart
          <span className="hint">Their reports move up to the next manager.</span>
        </label>

        {error && (
          <p className="note note-error" role="alert">
            {error}
          </p>
        )}
        {saved && !error && (
          <p className="note note-ok" role="status">
            Saved. The chart shows it on the next load.
          </p>
        )}

        <div className="editor-actions">
          <button type="submit" className="button primary" disabled={saving}>
            {saving ? 'Saving…' : 'Save'}
          </button>
          {o && (
            <button type="button" onClick={resetAll} disabled={saving}>
              Reset all to Slack
            </button>
          )}
        </div>
        {person.updatedBy && (
          <p className="muted small">Last edited by {byId.get(person.updatedBy)?.name ?? person.updatedBy}</p>
        )}
      </form>
    </aside>
  );
}
