// Fills a local database with a demo workspace and prints a session cookie,
// so the chart and the admin page can be tried without a Slack install.
//   DATABASE_URL=... TOKEN_ENCRYPTION_KEY=... npx tsx scripts/seed-demo.ts
import { PrismaClient, type UserType } from '@prisma/client';
import { encrypt, randomToken, sha256 } from '../src/server/crypto.js';
import { savePeople, type PersonRecord } from '../src/server/slack/sync.js';
import { withTenant } from '../src/server/db.js';

const TEAM = 'TDEMO';
const db = new PrismaClient();

type Row = [id: string, name: string, title: string, dept: string, manager: string | null, type?: UserType, org?: string];

const rows: Row[] = [
  ['U001', 'Maya Okafor', 'Chief Executive Officer', 'Leadership', null],
  ['U002', 'Daniel Brandt', 'Chief Technology Officer', 'Engineering', 'U001'],
  ['U003', 'Priya Nair', 'Chief Financial Officer', 'Finance', 'U001'],
  ['U004', 'Lucas Ferreira', 'VP Marketing', 'Marketing', 'U001'],
  ['U005', 'Hannah Kim', 'Engineering Manager, Platform', 'Engineering', 'U002'],
  ['U006', 'Tomás Silva', 'Engineering Manager, Product', 'Engineering', 'U002'],
  ['U007', 'Simon Novak', 'Senior Engineer', 'Engineering', 'U005'],
  ['U008', 'Aisha Bello', 'Engineer', 'Engineering', 'U005'],
  ['U009', 'Jonas Weber', 'Site Reliability Engineer', 'Engineering', 'U005'],
  ['U010', 'Contractor Dev', 'Backend Contractor', 'Engineering', 'U005', 'contractor'],
  ['U011', 'Emma Rossi', 'Product Engineer', 'Engineering', 'U006'],
  ['U012', 'Kenji Watanabe', 'Product Engineer', 'Engineering', 'U006'],
  ['U013', 'Sara Lindqvist', 'Controller', 'Finance', 'U003'],
  ['U014', 'Omar Haddad', 'Accountant', 'Finance', 'U013'],
  ['U015', 'Chloé Martin', 'Content Lead', 'Marketing', 'U004'],
  ['U016', 'Ravi Patel', 'Growth Marketer', 'Marketing', 'U004'],
  ['U017', 'Agency Designer', 'Brand Designer', 'Marketing', 'U004', 'multi_channel_guest'],
  ['U018', 'Pat Jensen', 'Account Executive', '', null, 'slack_connect', 'Globex'],
  ['U019', 'Lee Ortega', 'Solutions Engineer', '', null, 'slack_connect', 'Initech'],
  ['U020', 'New Hire', 'Engineer', 'Engineering', null],
];

await withTenant(
  TEAM,
  (tx) =>
    tx.workspace.upsert({
      where: { teamId: TEAM },
      create: {
        teamId: TEAM,
        name: 'Acme Demo',
        installation: encrypt('{}', process.env.TOKEN_ENCRYPTION_KEY!),
      },
      update: {},
    }),
  db,
);

const people: PersonRecord[] = rows.map(([id, name, title, dept, manager, type, org]) => ({
  slackUserId: id,
  homeTeamId: type === 'slack_connect' ? 'TOTHER' : TEAM,
  name,
  displayName: null,
  title,
  department: dept || null,
  email: `${name.split(' ')[0]!.normalize('NFD').replace(/[^a-zA-Z]/g, '').toLowerCase()}@acme.example`,
  avatarUrl: process.env.DEMO_AVATARS ? `${process.env.DEMO_AVATARS}/${id}.svg` : null,
  userType: type ?? 'employee',
  externalOrg: org ?? null,
  slackManagerId: manager,
  isSlackAdmin: false,
  isDeleted: false,
}));
await savePeople(TEAM, people, db);

const viewer = process.argv[2] ?? 'U007';
// The demo viewer is an admin too, so /admin can be tried.
await withTenant(
  TEAM,
  (tx) =>
    tx.adminRole.upsert({
      where: { teamId_slackUserId: { teamId: TEAM, slackUserId: viewer } },
      create: { teamId: TEAM, slackUserId: viewer, grantedBy: 'install' },
      update: {},
    }),
  db,
);
const secret = randomToken();
await withTenant(
  TEAM,
  (tx) =>
    tx.userSession.create({
      data: { id: sha256(secret), teamId: TEAM, slackUserId: viewer, expiresAt: new Date(Date.now() + 8 * 3_600_000) },
    }),
  db,
);
console.log(`oc_session=${TEAM}.${secret}`);
await db.$disconnect();
