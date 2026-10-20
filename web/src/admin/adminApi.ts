import type {
  AdminEntry,
  AdminPeopleResponse,
  AuditEntry,
  ImportResponse,
  MeResponse,
  PersonPatch,
  ProfileLinkSettings,
  SyncRunInfo,
  WorkspaceSettings,
} from '../../../src/shared/admin';

export class ApiFailure extends Error {
  constructor(
    readonly status: number,
    readonly code: string,
    message: string,
  ) {
    super(message);
  }
}

async function call<T>(method: string, path: string, body?: unknown): Promise<T> {
  const res = await fetch(path, {
    method,
    credentials: 'same-origin',
    headers: body === undefined ? undefined : { 'Content-Type': 'application/json' },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  if (res.status === 401) {
    const next = window.location.pathname + window.location.search;
    window.location.assign(`/auth/login?next=${encodeURIComponent(next)}`);
    return new Promise(() => {}); // the page is leaving
  }
  const data = await res.json().catch(() => ({}));
  if (!res.ok) {
    throw new ApiFailure(res.status, data.error ?? 'error', data.message ?? `The request failed (${res.status}).`);
  }
  return data as T;
}

export const adminApi = {
  me: () => call<MeResponse>('GET', '/api/me'),
  people: () => call<AdminPeopleResponse>('GET', '/api/admin/people'),
  updatePerson: (id: string, patch: PersonPatch) =>
    call<{ ok: true }>('PATCH', `/api/admin/people/${encodeURIComponent(id)}`, patch),
  importCsv: (csv: string, apply: boolean) => call<ImportResponse>('POST', '/api/admin/import', { csv, apply }),
  admins: () => call<{ admins: AdminEntry[] }>('GET', '/api/admin/admins'),
  addAdmin: (slackUserId: string) => call<{ admins: AdminEntry[] }>('POST', '/api/admin/admins', { slackUserId }),
  removeAdmin: (slackUserId: string) =>
    call<{ admins: AdminEntry[] }>('DELETE', `/api/admin/admins/${encodeURIComponent(slackUserId)}`),
  settings: () => call<WorkspaceSettings>('GET', '/api/admin/settings'),
  updateSettings: (patch: Partial<WorkspaceSettings>) => call<WorkspaceSettings>('PATCH', '/api/admin/settings', patch),
  audit: (before?: string) =>
    call<{ entries: AuditEntry[]; next: string | null }>(
      'GET',
      `/api/admin/audit${before ? `?before=${encodeURIComponent(before)}` : ''}`,
    ),
  sync: () => call<{ runs: SyncRunInfo[]; canStart: boolean }>('GET', '/api/admin/sync'),
  startSync: () => call<{ ok: true }>('POST', '/api/admin/sync'),
  profileLink: () => call<ProfileLinkSettings>('GET', '/api/admin/profile-link'),
  setProfileLinkField: (fieldId: string | null) => call<ProfileLinkSettings>('PATCH', '/api/admin/profile-link', { fieldId }),
  fillProfileLinks: () => call<{ ok: true }>('POST', '/api/admin/profile-link/fill'),
  disconnectProfileWriter: () => call<ProfileLinkSettings>('DELETE', '/api/admin/profile-link/writer'),
};
