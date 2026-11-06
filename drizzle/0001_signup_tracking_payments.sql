CREATE TABLE "app_sessions" (
	"id" serial PRIMARY KEY NOT NULL,
	"user_id" integer NOT NULL,
	"app_id" text NOT NULL,
	"source" text DEFAULT 'launch' NOT NULL,
	"started_at" timestamp with time zone DEFAULT now() NOT NULL,
	"last_active_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "payments" (
	"id" serial PRIMARY KEY NOT NULL,
	"user_id" integer NOT NULL,
	"reference" text NOT NULL,
	"hitpay_request_id" text,
	"checkout_url" text,
	"amount_cents" integer NOT NULL,
	"currency" text NOT NULL,
	"months" integer NOT NULL,
	"status" text DEFAULT 'pending' NOT NULL,
	"paid_at" timestamp with time zone,
	"access_until" timestamp with time zone,
	"refunded_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "settings" (
	"key" text PRIMARY KEY NOT NULL,
	"value" jsonb NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "student_profiles" (
	"user_id" integer PRIMARY KEY NOT NULL,
	"full_name" text NOT NULL,
	"school" text NOT NULL,
	"level" text NOT NULL,
	"mobile" text NOT NULL,
	"heard_from" text NOT NULL,
	"consent_text" text NOT NULL,
	"consent_at" timestamp with time zone DEFAULT now() NOT NULL,
	"sheet_synced_at" timestamp with time zone,
	"sheet_error" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "users" ADD COLUMN "paid_until" timestamp with time zone;--> statement-breakpoint
ALTER TABLE "app_sessions" ADD CONSTRAINT "app_sessions_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "app_sessions" ADD CONSTRAINT "app_sessions_app_id_apps_id_fk" FOREIGN KEY ("app_id") REFERENCES "public"."apps"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "payments" ADD CONSTRAINT "payments_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "student_profiles" ADD CONSTRAINT "student_profiles_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "app_sessions_started" ON "app_sessions" USING btree ("started_at");--> statement-breakpoint
CREATE INDEX "app_sessions_user_app" ON "app_sessions" USING btree ("user_id","app_id","last_active_at");--> statement-breakpoint
CREATE UNIQUE INDEX "payments_reference" ON "payments" USING btree ("reference");--> statement-breakpoint
CREATE INDEX "payments_hitpay_request" ON "payments" USING btree ("hitpay_request_id");--> statement-breakpoint
CREATE INDEX "payments_user" ON "payments" USING btree ("user_id","status");--> statement-breakpoint
CREATE INDEX "student_profiles_unsynced" ON "student_profiles" USING btree ("sheet_synced_at");