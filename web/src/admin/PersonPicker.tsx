import { useId, useMemo, useState } from 'react';
import type { AdminPerson } from '../../../src/shared/admin';
import { avatarHtml } from '../card';

// A search box that picks one person from a list.
export function PersonPicker({
  people,
  onPick,
  placeholder = 'Search by name or email',
  label,
}: {
  people: AdminPerson[];
  onPick: (person: AdminPerson) => void;
  placeholder?: string;
  label: string;
}) {
  const [query, setQuery] = useState('');
  const [active, setActive] = useState(0);
  const listId = useId();

  const matches = useMemo(() => {
    const q = query.trim().toLowerCase();
    if (!q) return [];
    return people
      .filter((p) => [p.name, p.email, p.effective.title].some((v) => v?.toLowerCase().includes(q)))
      .slice(0, 8);
  }, [people, query]);

  const pick = (p: AdminPerson) => {
    onPick(p);
    setQuery('');
    setActive(0);
  };

  return (
    <div className="search picker">
      <input
        type="search"
        aria-label={label}
        placeholder={placeholder}
        value={query}
        role="combobox"
        aria-expanded={matches.length > 0}
        aria-controls={listId}
        onChange={(e) => {
          setQuery(e.target.value);
          setActive(0);
        }}
        onKeyDown={(e) => {
          if (e.key === 'ArrowDown') {
            e.preventDefault();
            setActive((a) => Math.min(a + 1, matches.length - 1));
          } else if (e.key === 'ArrowUp') {
            e.preventDefault();
            setActive((a) => Math.max(a - 1, 0));
          } else if (e.key === 'Enter' && matches[active]) {
            e.preventDefault();
            pick(matches[active]);
          } else if (e.key === 'Escape') {
            setQuery('');
          }
        }}
      />
      {matches.length > 0 && (
        <ul className="search-results" role="listbox" id={listId}>
          {matches.map((m, i) => (
            <li key={m.slackUserId} role="option" aria-selected={i === active}>
              <button type="button" className={i === active ? 'active' : undefined} onClick={() => pick(m)}>
                <span dangerouslySetInnerHTML={{ __html: avatarHtml(m) }} />
                <span className="result-text">
                  <span className="result-name">{m.name}</span>
                  <span className="result-title">{m.effective.title ?? m.email}</span>
                </span>
              </button>
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}
