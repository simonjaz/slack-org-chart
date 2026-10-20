-- A person's own Slack user token, granted the first time they start a group
-- DM or create a channel from the chart. Encrypted like the bot token.
CREATE TABLE "user_grant" (
    "team_id" TEXT NOT NULL,
    "slack_user_id" TEXT NOT NULL,
    -- The workspace the token belongs to (differs from team_id on Grid).
    "slack_team_id" TEXT NOT NULL,
    "token" TEXT NOT NULL,
    "scopes" TEXT NOT NULL,
    "granted_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "user_grant_pkey" PRIMARY KEY ("team_id","slack_user_id")
);

-- The profile link field: an admin picks a link field, grants a token that
-- may write other people's profiles, and the app fills in each chart link.
ALTER TABLE "workspace" ADD COLUMN "profile_link_field_id" TEXT;
ALTER TABLE "workspace" ADD COLUMN "profile_writer_id" TEXT;
ALTER TABLE "workspace" ADD COLUMN "profile_writer_token" TEXT;

-- What the app last wrote to each person's link field, so a fill only
-- touches people who are new or whose link changed.
CREATE TABLE "profile_link" (
    "team_id" TEXT NOT NULL,
    "slack_user_id" TEXT NOT NULL,
    "field_id" TEXT NOT NULL,
    "value" TEXT NOT NULL,
    "written_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "profile_link_pkey" PRIMARY KEY ("team_id","slack_user_id")
);

-- Same tenant isolation as every other table (see the init migration).
DO $$
DECLARE t text;
BEGIN
  FOREACH t IN ARRAY ARRAY['user_grant','profile_link']
  LOOP
    EXECUTE format('ALTER TABLE %I ENABLE ROW LEVEL SECURITY', t);
    EXECUTE format('ALTER TABLE %I FORCE ROW LEVEL SECURITY', t);
    EXECUTE format(
      'CREATE POLICY tenant_isolation ON %I USING (team_id = current_setting(''app.team_id'', true) OR current_setting(''app.system'', true) = ''on'') WITH CHECK (team_id = current_setting(''app.team_id'', true) OR current_setting(''app.system'', true) = ''on'')',
      t);
  END LOOP;
END $$;
