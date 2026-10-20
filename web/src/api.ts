import type { MeResponse } from '../../src/shared/admin';
import type { ChartResponse } from '../../src/shared/chart';

export type LoadResult =
  | { status: 'ok'; data: ChartResponse }
  | { status: 'forbidden'; message: string }
  | { status: 'error'; message: string };

export async function loadChart(focus: string | null): Promise<LoadResult> {
  const query = focus ? `?user=${encodeURIComponent(focus)}` : '';
  const res = await fetch(`/api/chart${query}`, { credentials: 'same-origin' });
  if (res.status === 401) {
    window.location.assign(loginUrl());
    return new Promise(() => {}); // the page is leaving
  }
  if (res.status === 403) {
    const body = await res.json().catch(() => ({}));
    return { status: 'forbidden', message: body.message ?? 'You do not have access to this chart.' };
  }
  if (!res.ok) return { status: 'error', message: `The chart could not load (${res.status}).` };
  return { status: 'ok', data: (await res.json()) as ChartResponse };
}

// Who is signed in. null when it cannot be told; the chart works without it.
export async function loadMe(): Promise<MeResponse | null> {
  try {
    const res = await fetch('/api/me', { credentials: 'same-origin' });
    return res.ok ? ((await res.json()) as MeResponse) : null;
  } catch {
    return null;
  }
}

// Sign in, coming back to this page. Links from Slack carry team=, which
// keeps people in several workspaces on the right one.
export function loginUrl(): string {
  const params = new URLSearchParams(window.location.search);
  const team = params.get('team');
  const next = window.location.pathname + window.location.search;
  return `/auth/login?next=${encodeURIComponent(next)}${team ? `&team=${encodeURIComponent(team)}` : ''}`;
}
