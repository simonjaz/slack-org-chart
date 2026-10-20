import type { PrismaClient } from '@prisma/client';
import type { ChartResponse, PersonType } from '../../shared/chart.js';
import { prisma as defaultPrisma, withTenant, type Tx } from '../db.js';
import { buildChart, resolveFocus, type EffectivePerson } from './tree.js';

interface EffectiveRow {
  slack_user_id: string;
  name: string;
  title: string | null;
  department: string | null;
  avatar_url: string | null;
  user_type: PersonType;
  external_org: string | null;
  manager_slack_id: string | null;
  hidden: boolean;
  is_deleted: boolean;
  sort_order: number | null;
}

// Reads the effective_person view (Slack data with admin overrides applied).
// Deleted people are included so their reports can be moved up a level.
export async function loadEffectivePeople(tx: Tx): Promise<EffectivePerson[]> {
  const rows = await tx.$queryRaw<EffectiveRow[]>`
    SELECT slack_user_id, name, title, department, avatar_url, user_type::text AS user_type,
           external_org, manager_slack_id, hidden, is_deleted, sort_order
    FROM effective_person`;
  return rows.map((r) => ({
    slackUserId: r.slack_user_id,
    name: r.name,
    title: r.title,
    department: r.department,
    avatarUrl: r.avatar_url,
    userType: r.user_type,
    externalOrg: r.external_org,
    managerSlackId: r.manager_slack_id,
    hidden: r.hidden,
    isDeleted: r.is_deleted,
    sortOrder: r.sort_order,
  }));
}

export async function getChart(
  teamId: string,
  viewerId: string,
  requestedFocus: string | null,
  db: PrismaClient = defaultPrisma,
): Promise<ChartResponse> {
  return withTenant(
    teamId,
    async (tx) => {
      const [workspace, people] = await Promise.all([
        tx.workspace.findUniqueOrThrow({ where: { teamId }, select: { name: true } }),
        loadEffectivePeople(tx),
      ]);
      const nodes = buildChart(people, workspace.name);
      return {
        workspace: { teamId, name: workspace.name },
        viewerId,
        focusId: resolveFocus(nodes, viewerId, requestedFocus),
        nodes,
      };
    },
    db,
  );
}
