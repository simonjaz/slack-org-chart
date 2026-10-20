// Sample workspace for the demo: the people from scripts/seed-demo.ts plus a
// few more, so the chart has some depth and the admin page has work to do.
import type { PersonType } from '../src/shared/chart';

export const TEAM_ID = 'TDEMO';
export const WORKSPACE_NAME = 'Acme Demo';

export interface DemoPerson {
  id: string;
  name: string;
  title: string;
  department: string | null;
  managerId: string | null;
  userType: PersonType;
  externalOrg: string | null;
  email: string;
  avatarUrl: string | null;
  isDeleted: boolean;
  isSlackAdmin: boolean;
}

type Row = [
  id: string,
  name: string,
  title: string,
  dept: string,
  manager: string | null,
  extra?: { type?: PersonType; org?: string; deleted?: boolean; slackAdmin?: boolean; noPhoto?: boolean },
];

const rows: Row[] = [
  ['U001', 'Maya Okafor', 'Chief Executive Officer', 'Leadership', null, { slackAdmin: true }],
  ['U002', 'Daniel Brandt', 'Chief Technology Officer', 'Engineering', 'U001'],
  ['U003', 'Priya Nair', 'Chief Financial Officer', 'Finance', 'U001'],
  ['U004', 'Lucas Ferreira', 'VP Marketing', 'Marketing', 'U001'],
  ['U005', 'Hannah Kim', 'Engineering Manager, Platform', 'Engineering', 'U002'],
  ['U006', 'Tomás Silva', 'Engineering Manager, Product', 'Engineering', 'U002'],
  ['U007', 'Simon Novak', 'Senior Engineer', 'Engineering', 'U005'],
  ['U008', 'Aisha Bello', 'Engineer', 'Engineering', 'U005'],
  ['U009', 'Jonas Weber', 'Site Reliability Engineer', 'Engineering', 'U005'],
  ['U010', 'Marco Conti', 'Backend Contractor', 'Engineering', 'U005', { type: 'contractor' }],
  ['U011', 'Emma Rossi', 'Product Engineer', 'Engineering', 'U006'],
  ['U012', 'Kenji Watanabe', 'Product Engineer', 'Engineering', 'U006'],
  ['U013', 'Sara Lindqvist', 'Controller', 'Finance', 'U003'],
  ['U014', 'Omar Haddad', 'Accountant', 'Finance', 'U013'],
  ['U015', 'Chloé Martin', 'Content Lead', 'Marketing', 'U004'],
  ['U016', 'Ravi Patel', 'Growth Marketer', 'Marketing', 'U004'],
  ['U017', 'Noor Rahman', 'Brand Designer (agency)', 'Marketing', 'U004', { type: 'multi_channel_guest' }],
  ['U018', 'Pat Jensen', 'Account Executive', '', null, { type: 'slack_connect', org: 'Globex' }],
  ['U019', 'Lee Ortega', 'Solutions Engineer', '', null, { type: 'slack_connect', org: 'Initech' }],
  ['U020', 'Alex Moreau', 'Engineer', 'Engineering', null, { noPhoto: true }],
  ['U021', 'Grace Liu', 'Product Designer', 'Engineering', 'U006'],
  ['U022', 'Felix Wagner', 'Data Engineer', 'Engineering', 'U006'],
  ['U023', 'Ines Duarte', 'Payroll Specialist', 'Finance', 'U013'],
  ['U024', 'Jordan Blake', 'Head of Sales', 'Sales', 'U001', { deleted: true }],
  ['U025', 'Mila Horvat', 'Account Manager', 'Sales', 'U024'],
  ['U026', 'Theo Grant', 'Sales Development Rep', 'Sales', 'U024'],
  ['U027', 'Sofia Rinaldi', 'Security Auditor', '', 'U009', { type: 'single_channel_guest' }],
];

const slug = (name: string) =>
  name
    .split(' ')[0]!
    .normalize('NFD')
    .replace(/[^a-zA-Z]/g, '')
    .toLowerCase();

export const PEOPLE: DemoPerson[] = rows.map(([id, name, title, dept, manager, extra = {}]) => ({
  id,
  name,
  title,
  department: dept || null,
  managerId: manager,
  userType: extra.type ?? 'employee',
  externalOrg: extra.org ?? null,
  email: `${slug(name)}@${extra.org ? `${extra.org.toLowerCase()}.example` : 'acme.example'}`,
  avatarUrl: extra.noPhoto ? null : portrait(id),
  isDeleted: Boolean(extra.deleted),
  isSlackAdmin: Boolean(extra.slackAdmin),
}));

// Stand-in profile photos: a simple drawn portrait per person, so the demo
// needs no image host.
function portrait(id: string): string {
  let seed = 0;
  for (const c of id) seed = (seed * 31 + c.charCodeAt(0)) >>> 0;
  // Mix the seed per trait, so ids that differ in one digit look different.
  const pick = <T,>(list: T[], salt: number) => {
    let x = (seed ^ Math.imul(salt + 1, 0x9e3779b1)) >>> 0;
    x = Math.imul(x ^ (x >>> 16), 0x85ebca6b) >>> 0;
    x = Math.imul(x ^ (x >>> 13), 0xc2b2ae35) >>> 0;
    return list[((x ^ (x >>> 16)) >>> 0) % list.length]!;
  };
  const bg = pick(['#c7d2fe', '#fde68a', '#bbf7d0', '#fecaca', '#bae6fd', '#e9d5ff', '#fed7aa', '#d9f99d'], 0);
  const skin = pick(['#f1c7a5', '#e0a979', '#c68857', '#8d5a3b', '#603b26', '#f6d6bd'], 3);
  const hair = pick(['#1f1a17', '#4a3021', '#7a4b2a', '#b7793e', '#d9b36c', '#6b6b6b', '#2b2b3a'], 6);
  const shirt = pick(['#334155', '#0f766e', '#9d174d', '#1d4ed8', '#7c2d12', '#4d7c0f', '#6d28d9'], 9);
  const style = pick([0, 1, 2, 3], 12);
  const hairShape = [
    // short
    `<path d="M19 30c0-10 6-16 13-16s13 6 13 16c-3-5-8-7-13-7s-10 2-13 7z" fill="${hair}"/>`,
    // long
    `<path d="M17 34c0-13 7-20 15-20s15 7 15 20v14h-6V32c-3-4-6-6-9-6s-6 2-9 6v16h-6z" fill="${hair}"/>`,
    // bun
    `<circle cx="32" cy="11" r="6" fill="${hair}"/><path d="M19 30c0-10 6-16 13-16s13 6 13 16c-3-6-8-8-13-8s-10 2-13 8z" fill="${hair}"/>`,
    // curly
    `<g fill="${hair}"><circle cx="22" cy="22" r="6"/><circle cx="30" cy="17" r="7"/><circle cx="39" cy="19" r="6"/><circle cx="43" cy="26" r="5"/><circle cx="20" cy="29" r="4"/></g>`,
  ][style];
  const svg = `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 64 64"><rect width="64" height="64" fill="${bg}"/><path d="M10 64c2-12 11-18 22-18s20 6 22 18z" fill="${shirt}"/><rect x="28" y="38" width="8" height="9" rx="3" fill="${skin}"/><ellipse cx="32" cy="30" rx="11" ry="13" fill="${skin}"/>${hairShape}<circle cx="28" cy="31" r="1.3" fill="#1f1a17"/><circle cx="36" cy="31" r="1.3" fill="#1f1a17"/><path d="M29 36.5q3 2 6 0" stroke="#1f1a17" stroke-width="1.2" fill="none" stroke-linecap="round"/></svg>`;
  return `data:image/svg+xml,${encodeURIComponent(svg)}`;
}

// Who the demo can be viewed as.
export const VIEWERS = [
  { id: 'U007', label: 'Simon Novak (employee, org chart admin)' },
  { id: 'U011', label: 'Emma Rossi (employee)' },
  { id: 'U017', label: 'Noor Rahman (guest)' },
];

// Channel chatter for the mock workspace.
export const CHANNEL_MESSAGES: { channel: string; from: string; text: string; time: string }[] = [
  { channel: 'engineering', from: 'U005', text: 'Platform sync moved to 3pm today. Agenda is in the doc.', time: '9:41 AM' },
  { channel: 'engineering', from: 'U012', text: 'Who owns the billing webhooks now? I need a reviewer.', time: '10:02 AM' },
  { channel: 'engineering', from: 'U009', text: 'Deploy freeze lifts at noon. Thanks for the patience.', time: '10:15 AM' },
  { channel: 'engineering', from: 'U021', text: 'New onboarding screens are up for feedback.', time: '11:30 AM' },
  { channel: 'general', from: 'U001', text: 'Welcome to everyone who joined this week!', time: '8:55 AM' },
  { channel: 'general', from: 'U015', text: 'The Q4 launch post goes out Thursday.', time: '9:20 AM' },
  { channel: 'general', from: 'U018', text: 'Thanks for having us in here, looking forward to the pilot.', time: '10:44 AM' },
];
