// Shapes shared by the API and the web page.

export type PersonType =
  | 'employee'
  | 'multi_channel_guest'
  | 'single_channel_guest'
  | 'slack_connect'
  | 'contractor'
  | 'external'
  | 'bot';

export type Badge = 'guest' | 'external' | 'contractor' | null;

export interface ChartNode {
  id: string;
  parentId: string | null;
  kind: 'person' | 'company' | 'group';
  name: string;
  title?: string | null;
  department?: string | null;
  avatarUrl?: string | null;
  userType?: PersonType;
  badge?: Badge;
  externalOrg?: string | null;
  // Number of people below this node, for the collapsed "+12" counter.
  descendants: number;
  // The person's manager is deactivated or hidden, so they were moved up to
  // the next visible manager.
  rerouted?: boolean;
  // The Slack data had a reporting loop; this person was cut loose from it.
  cycleBroken?: boolean;
}

export interface ChartResponse {
  workspace: { teamId: string; name: string | null };
  viewerId: string;
  focusId: string;
  nodes: ChartNode[];
}

export function badgeFor(type: PersonType | undefined): Badge {
  switch (type) {
    case 'multi_channel_guest':
    case 'single_channel_guest':
      return 'guest';
    case 'slack_connect':
    case 'external':
      return 'external';
    case 'contractor':
      return 'contractor';
    default:
      return null;
  }
}
