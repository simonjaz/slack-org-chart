-- CreateEnum
CREATE TYPE "UserType" AS ENUM ('employee', 'multi_channel_guest', 'single_channel_guest', 'slack_connect', 'contractor', 'external', 'bot');

-- CreateTable
CREATE TABLE "workspace" (
    "team_id" TEXT NOT NULL,
    "enterprise_id" TEXT,
    "is_enterprise_install" BOOLEAN NOT NULL DEFAULT false,
    "name" TEXT,
    "domain" TEXT,
    "installation" TEXT NOT NULL,
    "manager_field_id" TEXT,
    "department_field_id" TEXT,
    "plan" TEXT,
    "allow_guest_viewers" BOOLEAN NOT NULL DEFAULT false,
    "installed_by" TEXT,
    "installed_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "uninstalled_at" TIMESTAMP(3),
    "delete_after" TIMESTAMP(3),

    CONSTRAINT "workspace_pkey" PRIMARY KEY ("team_id")
);

-- CreateTable
CREATE TABLE "person" (
    "id" UUID NOT NULL,
    "team_id" TEXT NOT NULL,
    "slack_user_id" TEXT NOT NULL,
    "home_team_id" TEXT,
    "name" TEXT NOT NULL,
    "display_name" TEXT,
    "title" TEXT,
    "department" TEXT,
    "email" TEXT,
    "avatar_url" TEXT,
    "user_type" "UserType" NOT NULL,
    "external_org" TEXT,
    "slack_manager_id" TEXT,
    "is_slack_admin" BOOLEAN NOT NULL DEFAULT false,
    "is_deleted" BOOLEAN NOT NULL DEFAULT false,
    "last_synced_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "person_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "person_override" (
    "person_id" UUID NOT NULL,
    "team_id" TEXT NOT NULL,
    "manager_slack_id" TEXT,
    "user_type" "UserType",
    "external_org" TEXT,
    "title" TEXT,
    "department" TEXT,
    "hidden" BOOLEAN,
    "sort_order" INTEGER,
    "updated_by" TEXT NOT NULL,
    "updated_at" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "person_override_pkey" PRIMARY KEY ("person_id")
);

-- CreateTable
CREATE TABLE "user_session" (
    "id" TEXT NOT NULL,
    "team_id" TEXT NOT NULL,
    "slack_user_id" TEXT NOT NULL,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "expires_at" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "user_session_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "admin_role" (
    "team_id" TEXT NOT NULL,
    "slack_user_id" TEXT NOT NULL,
    "role" TEXT NOT NULL DEFAULT 'admin',
    "granted_by" TEXT,
    "granted_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "admin_role_pkey" PRIMARY KEY ("team_id","slack_user_id")
);

-- CreateTable
CREATE TABLE "audit_log" (
    "id" BIGSERIAL NOT NULL,
    "team_id" TEXT NOT NULL,
    "actor" TEXT NOT NULL,
    "action" TEXT NOT NULL,
    "person_id" UUID,
    "before" JSONB,
    "after" JSONB,
    "at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "audit_log_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "sync_run" (
    "id" BIGSERIAL NOT NULL,
    "team_id" TEXT NOT NULL,
    "kind" TEXT NOT NULL,
    "started_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "finished_at" TIMESTAMP(3),
    "counts" JSONB,
    "errors" JSONB,

    CONSTRAINT "sync_run_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "workspace_enterprise_id_idx" ON "workspace"("enterprise_id");

-- CreateIndex
CREATE UNIQUE INDEX "person_team_id_slack_user_id_key" ON "person"("team_id", "slack_user_id");

-- CreateIndex
CREATE INDEX "person_override_team_id_idx" ON "person_override"("team_id");

-- CreateIndex
CREATE INDEX "user_session_team_id_slack_user_id_idx" ON "user_session"("team_id", "slack_user_id");

-- CreateIndex
CREATE INDEX "audit_log_team_id_at_idx" ON "audit_log"("team_id", "at");

-- CreateIndex
CREATE INDEX "sync_run_team_id_started_at_idx" ON "sync_run"("team_id", "started_at");

-- AddForeignKey
ALTER TABLE "person_override" ADD CONSTRAINT "person_override_person_id_fkey" FOREIGN KEY ("person_id") REFERENCES "person"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- ---------------------------------------------------------------------------
-- Tenant isolation. Every request runs inside withTenant(), which sets
-- app.team_id for the transaction. FORCE makes the policies apply to the
-- table owner too, which is the role the app connects as.
-- app.system = 'on' is set only by withSystem() for cross-workspace jobs
-- (the nightly scheduler and installation lookups).
-- ---------------------------------------------------------------------------
DO $$
DECLARE t text;
BEGIN
  FOREACH t IN ARRAY ARRAY['workspace','person','person_override','user_session','admin_role','audit_log','sync_run']
  LOOP
    EXECUTE format('ALTER TABLE %I ENABLE ROW LEVEL SECURITY', t);
    EXECUTE format('ALTER TABLE %I FORCE ROW LEVEL SECURITY', t);
    EXECUTE format(
      'CREATE POLICY tenant_isolation ON %I USING (team_id = current_setting(''app.team_id'', true) OR current_setting(''app.system'', true) = ''on'') WITH CHECK (team_id = current_setting(''app.team_id'', true) OR current_setting(''app.system'', true) = ''on'')',
      t);
  END LOOP;
END $$;

-- What the chart shows: the admin value when one exists, otherwise Slack's.
-- An override manager of '' means "explicitly no manager".
CREATE VIEW effective_person WITH (security_invoker = true) AS
SELECT
  p.id,
  p.team_id,
  p.slack_user_id,
  p.name,
  p.display_name,
  p.email,
  p.avatar_url,
  p.is_deleted,
  COALESCE(o.title, p.title)               AS title,
  COALESCE(o.department, p.department)     AS department,
  COALESCE(o.user_type, p.user_type)       AS user_type,
  COALESCE(o.external_org, p.external_org) AS external_org,
  NULLIF(COALESCE(o.manager_slack_id, p.slack_manager_id), '') AS manager_slack_id,
  COALESCE(o.hidden, false)                AS hidden,
  o.sort_order
FROM person p
LEFT JOIN person_override o ON o.person_id = p.id;
