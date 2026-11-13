ALTER TYPE "public"."delivery_kind" ADD VALUE 'DRIVE' BEFORE 'FILE';--> statement-breakpoint
CREATE TABLE "drive_credentials" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"store_id" uuid NOT NULL,
	"account_email" text NOT NULL,
	"refresh_token_enc" text NOT NULL,
	"scope" text,
	"status" text DEFAULT 'CONNECTED' NOT NULL,
	"last_error" text,
	"connected_at" timestamp with time zone DEFAULT now() NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "drive_grants" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"store_id" uuid NOT NULL,
	"fulfillment_id" uuid NOT NULL,
	"claim_id" uuid NOT NULL,
	"email" text NOT NULL,
	"file_id" text NOT NULL,
	"permission_id" text,
	"status" text DEFAULT 'PENDING' NOT NULL,
	"corrected_from" text,
	"last_error" text,
	"granted_at" timestamp with time zone,
	"revoked_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "drive_credentials" ADD CONSTRAINT "drive_credentials_store_id_shopee_stores_id_fk" FOREIGN KEY ("store_id") REFERENCES "public"."shopee_stores"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "drive_grants" ADD CONSTRAINT "drive_grants_store_id_shopee_stores_id_fk" FOREIGN KEY ("store_id") REFERENCES "public"."shopee_stores"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "drive_grants" ADD CONSTRAINT "drive_grants_fulfillment_id_fulfillments_id_fk" FOREIGN KEY ("fulfillment_id") REFERENCES "public"."fulfillments"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "drive_grants" ADD CONSTRAINT "drive_grants_claim_id_claims_id_fk" FOREIGN KEY ("claim_id") REFERENCES "public"."claims"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "drive_credentials_store_key" ON "drive_credentials" USING btree ("store_id");--> statement-breakpoint
CREATE INDEX "drive_grants_fulfillment_idx" ON "drive_grants" USING btree ("fulfillment_id");--> statement-breakpoint
CREATE INDEX "drive_grants_status_idx" ON "drive_grants" USING btree ("status");