-- Cloud schema/journal drift: message_server_agents is one of the plugin-sql
-- core tables the cloud schemas barrel re-exports, but the cloud journal never
-- created it (only the standalone plugin-sql journal did). Databases built by
-- replaying this journal have no such relation, so any query touching it fails.
-- DDL matches the drizzle-generated shape of the plugin-sql baseline.
CREATE TABLE "message_server_agents" (
	"message_server_id" uuid NOT NULL,
	"agent_id" uuid NOT NULL,
	CONSTRAINT "message_server_agents_message_server_id_agent_id_pk" PRIMARY KEY("message_server_id","agent_id")
);
--> statement-breakpoint
ALTER TABLE "message_server_agents" ADD CONSTRAINT "message_server_agents_message_server_id_message_servers_id_fk" FOREIGN KEY ("message_server_id") REFERENCES "public"."message_servers"("id") ON DELETE cascade ON UPDATE no action;
--> statement-breakpoint
ALTER TABLE "message_server_agents" ADD CONSTRAINT "message_server_agents_agent_id_agents_id_fk" FOREIGN KEY ("agent_id") REFERENCES "public"."agents"("id") ON DELETE cascade ON UPDATE no action;
