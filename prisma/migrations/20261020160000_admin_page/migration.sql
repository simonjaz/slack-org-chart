-- Slack workspace owners and admins can be org chart admins automatically.
-- Off by default: only the installer and people they add are admins.
ALTER TABLE "workspace" ADD COLUMN "auto_admin_slack_admins" BOOLEAN NOT NULL DEFAULT false;

-- The admin page shows one person's history.
CREATE INDEX "audit_log_team_id_person_id_idx" ON "audit_log"("team_id", "person_id");
