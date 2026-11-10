CREATE TABLE "user_mfa" (
	"user_id" uuid PRIMARY KEY NOT NULL,
	"secret_enc" text NOT NULL,
	"recovery_hashes" text[] DEFAULT '{}' NOT NULL,
	"enabled_at" timestamp with time zone,
	"last_step" bigint,
	"created_at" timestamp with time zone DEFAULT date_trunc('milliseconds', now()) NOT NULL
);
--> statement-breakpoint
CREATE TABLE "user_tokens" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"user_id" uuid NOT NULL,
	"kind" text NOT NULL,
	"token_hash" text NOT NULL,
	"data" jsonb,
	"expires_at" timestamp with time zone NOT NULL,
	"used_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT date_trunc('milliseconds', now()) NOT NULL,
	CONSTRAINT "user_tokens_token_hash_unique" UNIQUE("token_hash"),
	CONSTRAINT "user_tokens_kind_check" CHECK ("user_tokens"."kind" in ('password_reset', 'email_change'))
);
--> statement-breakpoint
ALTER TABLE "api_keys" ADD COLUMN "expires_at" timestamp with time zone;--> statement-breakpoint
ALTER TABLE "memberships" ADD COLUMN "last_active_at" timestamp with time zone;--> statement-breakpoint
ALTER TABLE "memberships" ADD COLUMN "disabled_at" timestamp with time zone;--> statement-breakpoint
ALTER TABLE "sessions" ADD COLUMN "mfa_verified" boolean DEFAULT false NOT NULL;--> statement-breakpoint
ALTER TABLE "user_mfa" ADD CONSTRAINT "user_mfa_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "user_tokens" ADD CONSTRAINT "user_tokens_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "user_tokens_user_kind_idx" ON "user_tokens" USING btree ("user_id","kind");