import type { Badge, ChartNode } from '../../src/shared/chart';

export const CARD_WIDTH = 264;
export const CARD_HEIGHT = 104;
export const GROUP_HEIGHT = 64;

const BADGE_LABEL: Record<Exclude<Badge, null>, string> = {
  guest: 'Guest',
  external: 'External',
  contractor: 'Contractor',
};

// Each badge has its own shape as well as its own color, so the difference
// does not rely on color alone.
const BADGE_ICON: Record<Exclude<Badge, null>, string> = {
  guest: '<svg viewBox="0 0 12 12" aria-hidden="true"><circle cx="6" cy="6" r="5"/></svg>',
  external: '<svg viewBox="0 0 12 12" aria-hidden="true"><path d="M6 1 11 11H1z"/></svg>',
  contractor: '<svg viewBox="0 0 12 12" aria-hidden="true"><rect x="1.5" y="1.5" width="9" height="9"/></svg>',
};

export function escapeHtml(value: string | null | undefined): string {
  return (value ?? '').replace(/[&<>"']/g, (c) => `&#${c.charCodeAt(0)};`);
}

export function initials(name: string): string {
  const parts = name.trim().split(/\s+/).filter(Boolean);
  const letters = (parts[0]?.[0] ?? '') + (parts.length > 1 ? (parts[parts.length - 1]?.[0] ?? '') : '');
  return letters.toUpperCase() || '?';
}

export function badgeHtml(badge: Badge, externalOrg?: string | null): string {
  if (!badge) return '';
  const org = badge === 'external' && externalOrg ? ` · ${escapeHtml(externalOrg)}` : '';
  return `<span class="badge badge-${badge}">${BADGE_ICON[badge]}${BADGE_LABEL[badge]}${org}</span>`;
}

export function avatarHtml(node: Pick<ChartNode, 'name' | 'avatarUrl'>, size: 'md' | 'lg' = 'md'): string {
  const img = node.avatarUrl
    ? `<img src="${escapeHtml(node.avatarUrl)}" alt="" loading="lazy" referrerpolicy="no-referrer" onerror="this.remove()">`
    : '';
  return `<span class="avatar avatar-${size}"><span class="avatar-initials">${escapeHtml(initials(node.name))}</span>${img}</span>`;
}

// HTML for one node. Every value from Slack is escaped: names and titles are
// typed by people and must never become markup.
export function cardHtml(node: ChartNode, opts: { isViewer: boolean; isFocus: boolean }): string {
  if (node.kind !== 'person') {
    return `<div class="card card-${node.kind}" style="height:${node.kind === 'company' ? CARD_HEIGHT : GROUP_HEIGHT}px">
      <div class="group-name">${escapeHtml(node.name)}</div>
      <div class="group-count">${node.descendants} ${node.descendants === 1 ? 'person' : 'people'}</div>
    </div>`;
  }
  const classes = ['card', 'card-person'];
  if (node.badge) classes.push('card-outside', `card-${node.badge}`);
  if (opts.isViewer) classes.push('card-viewer');
  if (opts.isFocus) classes.push('card-focus');
  const subtitle = [node.title, node.department].filter(Boolean).map(escapeHtml).join(' · ');
  return `<div class="${classes.join(' ')}" style="height:${CARD_HEIGHT}px" data-id="${escapeHtml(node.id)}">
    ${avatarHtml(node)}
    <div class="card-text">
      <div class="card-name">${escapeHtml(node.name)}${opts.isViewer ? '<span class="you">You</span>' : ''}</div>
      <div class="card-title">${subtitle || '&nbsp;'}</div>
      <div class="card-meta">${badgeHtml(node.badge ?? null, node.externalOrg)}</div>
    </div>
  </div>`;
}
