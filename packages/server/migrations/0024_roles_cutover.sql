-- Role cutover (P6-39): the old workspace roles become `member` plus the same role in the team project.
-- Hand written: the schema does not change, so meta/0024_snapshot.json equals 0023's. Invitations keep
-- their old words; the accept handler maps them (L24).
INSERT INTO "project_relations" ("tenant_id", "project_id", "user_id", "role")
SELECT m."tenant_id", p."id", m."user_id", 'project:' || m."role"
FROM "memberships" m JOIN "projects" p ON p."tenant_id" = m."tenant_id" AND p."type" = 'team'
WHERE m."role" IN ('editor', 'viewer');--> statement-breakpoint
UPDATE "memberships" SET "role" = 'member' WHERE "role" IN ('editor', 'viewer');
