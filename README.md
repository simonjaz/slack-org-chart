# Org Chart for Slack

A Slack app that syncs people's profiles (names, titles, photos, the Manager
field, guest status) and draws an interactive org chart that opens on the
viewer. Guests, Slack Connect people and contractors are badged so they are
never mistaken for employees.

The design is in the architecture doc for this project. In short: one Node.js
service in TypeScript (Bolt for Slack, Express, React with d3-org-chart) and
one Postgres database, installable into many workspaces.

## What is here

| Area | Files |
| --- | --- |
| Slack install (OAuth, many workspaces) | `src/server/slack/installationStore.ts`, `src/server/app.ts` |
| Profile sync: nightly full sync, live events, Slack Connect discovery | `src/server/slack/sync.ts`, `src/server/jobs.ts` |
| Internal vs external classification | `src/server/slack/classify.ts` |
| Reporting tree (loops, deactivated managers, unplaced people) | `src/server/chart/tree.ts` |
| Sign in with Slack and sessions | `src/server/auth.ts` |
| Chart API | `GET /api/chart?user=U123` in `src/server/api.ts` |
| Chart page | `web/src/ChartPage.tsx`, `web/src/card.ts` |
| Admin access control | `src/server/admin/access.ts` |
| Admin API (`/api/admin/*`) | `src/server/admin/api.ts`, `src/server/admin/service.ts` |
| Admin page | `web/src/admin/*` |
| Data model and tenant isolation | `prisma/schema.prisma`, `prisma/migrations/*/migration.sql` |

## How data is kept apart

Every table carries `team_id` and has a Postgres row-level security policy.
The app sets the workspace for each transaction with `withTenant()`, so a
query that forgets a `where` clause still cannot read another company's
people. The app's database role must **not** be a superuser, because
superusers skip row-level security.

Slack tokens are stored AES-256-GCM encrypted with `TOKEN_ENCRYPTION_KEY`.

## Run it locally

Requirements: Node 20+, Postgres 16, and a Slack app you can install
(create one from `manifest.yml`).

```sh
npm install
cp .env.example .env            # fill in the Slack values and a key
npx prisma migrate deploy
npm run build && npm start      # or: npm run dev (API) + npm run dev:web (page)
```

Slack needs a public https URL for events and OAuth. For local work, use a
tunnel such as `ngrok http 3000` and put its URL in `BASE_URL` and the
manifest.

Install the app at `/slack/install`. The installer becomes the first admin
and a full sync starts right away. Then open `/chart`.

### Try the chart without Slack

```sh
npx tsx scripts/seed-demo.ts U007   # prints a session cookie for viewer U007
```

Set that cookie (`oc_session`) for `localhost:3000` in the browser and open
`/chart`. The demo viewer is also an admin, so `/admin` works too.

## Tests

```sh
npm test                                            # unit tests
TEST_DATABASE_URL=postgresql://... npm test         # plus database tests
```

The database tests need a Postgres with the migrations applied, connected as
a non-superuser role. CI does this with a Postgres service container.

## Sync details

- **Full sync, nightly** (and right after install): `users.list`, then
  `users.profile.get` per active person to read the Manager and Department
  fields. Slack allows about 100 of those calls a minute, so 1,000 people
  take about 10 minutes. WebClient waits and retries when Slack says slow
  down.
- **Live updates:** `user_change`, `team_join` and `user_profile_changed`
  queue a one-person sync.
- **Slack Connect:** members of channels shared with other companies are
  looked up with `users.info`; their company comes from `team.info` when
  Slack allows it.
- **Uninstall:** `app_uninstalled` or a revoked bot token stops the sync, and
  the data is deleted 30 days later.

## Admin page

`/admin`, reached from the Admin button on the chart. It uses the same Sign
in with Slack, then checks on every request that the person is an admin of
that workspace:

- The installer is the first admin. Admins add and remove others; the last
  one cannot be removed.
- Slack owners and admins can be admins automatically. This is a setting,
  off by default.
- Guests and Slack Connect people (as Slack reports them) can never be
  admins, and neither can someone an admin marked contractor or external.

What admins can do:

- **People:** change someone's manager, title, department or type
  (employee, contractor, external, plus their company name), or hide them.
  Edits go to `person_override`, so the nightly sync never undoes them, and
  "Reset all to Slack" removes them. Changing a manager is refused if it
  would make a reporting loop. A Slack guest can be marked contractor or
  external but never employee.
- **Needs attention:** people with no manager and no reports, people whose
  manager is deactivated, Slack reporting loops, and managers the app does
  not know.
- **Import:** a CSV with `email` and `manager_email` (and optional `title`
  and `department`). A preview shows each row's result before anything is
  written.
- **Admins, Settings** (guest viewing, automatic Slack admins, sync status
  and Sync now) and **History**, which lists every change from `audit_log`.

## Not in this version

App Home, `/orgchart`, the profile link field, the message shortcut, and
messaging or channel creation from the chart.
