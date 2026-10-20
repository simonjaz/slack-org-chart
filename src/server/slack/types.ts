// The subset of Slack's user object the sync reads.
export interface SlackUser {
  id: string;
  team_id?: string;
  name?: string;
  real_name?: string;
  deleted?: boolean;
  is_bot?: boolean;
  is_app_user?: boolean;
  is_restricted?: boolean;
  is_ultra_restricted?: boolean;
  is_admin?: boolean;
  is_owner?: boolean;
  enterprise_user?: { enterprise_id?: string };
  profile?: SlackProfile;
}

export interface SlackProfile {
  real_name?: string;
  display_name?: string;
  title?: string;
  email?: string;
  image_192?: string;
  image_72?: string;
  team?: string;
  fields?: Record<string, { value?: string; alt?: string } | null> | null;
}

export interface WorkspaceIdentity {
  teamId: string;
  enterpriseId?: string | null;
}
