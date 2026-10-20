import type { ChartResponse } from '../../src/shared/chart';

export type LoadResult =
  | { status: 'ok'; data: ChartResponse }
  | { status: 'forbidden'; message: string }
  | { status: 'error'; message: string };

export async function loadChart(focus: string | null): Promise<LoadResult> {
  const query = focus ? `?user=${encodeURIComponent(focus)}` : '';
  const res = await fetch(`/api/chart${query}`, { credentials: 'same-origin' });
  if (res.status === 401) {
    const next = window.location.pathname + window.location.search;
    window.location.assign(`/auth/login?next=${encodeURIComponent(next)}`);
    return new Promise(() => {}); // the page is leaving
  }
  if (res.status === 403) {
    const body = await res.json().catch(() => ({}));
    return { status: 'forbidden', message: body.message ?? 'You do not have access to this chart.' };
  }
  if (!res.ok) return { status: 'error', message: `The chart could not load (${res.status}).` };
  return { status: 'ok', data: (await res.json()) as ChartResponse };
}
