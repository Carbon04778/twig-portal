CREATE TABLE "app_events" (
	"id" serial PRIMARY KEY NOT NULL,
	"user_id" integer NOT NULL,
	"app_id" text NOT NULL,
	"event_id" text NOT NULL,
	"type" text NOT NULL,
	"attempt_ref" text,
	"title" text,
	"label" text,
	"score" integer,
	"total" integer,
	"occurred_at" timestamp with time zone NOT NULL,
	"received_at" timestamp with time zone DEFAULT now() NOT NULL,
	"sheet_synced_at" timestamp with time zone
);
--> statement-breakpoint
ALTER TABLE "app_events" ADD CONSTRAINT "app_events_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "app_events" ADD CONSTRAINT "app_events_app_id_apps_id_fk" FOREIGN KEY ("app_id") REFERENCES "public"."apps"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "app_events_once" ON "app_events" USING btree ("app_id","event_id");--> statement-breakpoint
CREATE INDEX "app_events_when" ON "app_events" USING btree ("occurred_at");--> statement-breakpoint
CREATE INDEX "app_events_unsynced" ON "app_events" USING btree ("sheet_synced_at");