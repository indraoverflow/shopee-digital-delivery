CREATE TYPE "public"."claim_status" AS ENUM('ISSUED', 'COMPLETED', 'REVOKED', 'EXPIRED', 'BLOCKED');--> statement-breakpoint
CREATE TYPE "public"."delivery_kind" AS ENUM('FILE', 'LINK', 'CODE', 'CREDENTIALS', 'INSTRUCTIONS');--> statement-breakpoint
CREATE TYPE "public"."digital_product_status" AS ENUM('DRAFT', 'ACTIVE', 'ARCHIVED');--> statement-breakpoint
CREATE TYPE "public"."fulfillment_status" AS ENUM('PENDING', 'CLAIMABLE', 'CLAIMED', 'REVOKED', 'EXPIRED', 'FAILED');--> statement-breakpoint
CREATE TYPE "public"."job_status" AS ENUM('QUEUED', 'RUNNING', 'SUCCEEDED', 'FAILED', 'DEAD');--> statement-breakpoint
CREATE TYPE "public"."mapping_status" AS ENUM('UNMAPPED', 'MAPPED', 'AMBIGUOUS');--> statement-breakpoint
CREATE TYPE "public"."order_state" AS ENUM('RECEIVED', 'VALIDATED', 'FULFILLED', 'CLAIMED', 'COMPLETED', 'INELIGIBLE', 'CANCELLED', 'EXPIRED', 'FAILED');--> statement-breakpoint
CREATE TYPE "public"."shopee_env" AS ENUM('SANDBOX', 'PRODUCTION');--> statement-breakpoint
CREATE TYPE "public"."store_status" AS ENUM('PENDING', 'CONNECTED', 'ERROR', 'DISCONNECTED');--> statement-breakpoint
CREATE TYPE "public"."sync_type" AS ENUM('PRODUCTS', 'ORDERS');--> statement-breakpoint
CREATE TYPE "public"."user_role" AS ENUM('OWNER', 'ADMIN', 'OPERATOR', 'VIEWER');--> statement-breakpoint
CREATE TYPE "public"."verification_method" AS ENUM('USERNAME', 'USERNAME_PHONE', 'MANUAL');--> statement-breakpoint
CREATE TYPE "public"."webhook_status" AS ENUM('RECEIVED', 'PROCESSED', 'DUPLICATE', 'IGNORED', 'FAILED');--> statement-breakpoint
CREATE TABLE "audit_logs" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"actor_type" text DEFAULT 'ADMIN' NOT NULL,
	"actor_id" uuid,
	"actor_label" text,
	"action" text NOT NULL,
	"target_type" text,
	"target_id" text,
	"metadata" jsonb,
	"ip" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "claim_attempts" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"order_sn" text,
	"method" "verification_method" NOT NULL,
	"success" boolean NOT NULL,
	"reason" text,
	"ip" text,
	"user_agent" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "claim_sessions" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"order_id" uuid NOT NULL,
	"token_hash" text NOT NULL,
	"method" "verification_method" NOT NULL,
	"ip" text,
	"user_agent" text,
	"expires_at" timestamp with time zone NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "claims" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"fulfillment_id" uuid NOT NULL,
	"order_id" uuid NOT NULL,
	"digital_product_id" uuid NOT NULL,
	"claim_session_id" uuid,
	"status" "claim_status" DEFAULT 'ISSUED' NOT NULL,
	"verification_method" "verification_method" NOT NULL,
	"deliveries_used" integer DEFAULT 0 NOT NULL,
	"ip" text,
	"user_agent" text,
	"completed_at" timestamp with time zone,
	"revoked_at" timestamp with time zone,
	"revoke_reason" text,
	"expires_at" timestamp with time zone NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "delivery_logs" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"claim_id" uuid NOT NULL,
	"fulfillment_id" uuid NOT NULL,
	"digital_product_id" uuid NOT NULL,
	"kind" "delivery_kind" NOT NULL,
	"reference" text,
	"ip" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "digital_product_assets" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"digital_product_id" uuid NOT NULL,
	"storage_key" text NOT NULL,
	"file_name" text NOT NULL,
	"mime_type" text NOT NULL,
	"size_bytes" bigint NOT NULL,
	"sha256" text NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "digital_product_codes" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"digital_product_id" uuid NOT NULL,
	"secret_enc" text NOT NULL,
	"label" text,
	"assigned_claim_id" uuid,
	"assigned_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "digital_products" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"name" text NOT NULL,
	"slug" text NOT NULL,
	"description" text,
	"delivery_kind" "delivery_kind" NOT NULL,
	"instructions" text,
	"external_url" text,
	"status" "digital_product_status" DEFAULT 'DRAFT' NOT NULL,
	"claim_expiry_days" integer DEFAULT 30 NOT NULL,
	"max_deliveries" integer DEFAULT 3 NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	"archived_at" timestamp with time zone
);
--> statement-breakpoint
CREATE TABLE "fulfillments" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"order_id" uuid NOT NULL,
	"order_item_id" uuid NOT NULL,
	"store_id" uuid NOT NULL,
	"digital_product_id" uuid NOT NULL,
	"quantity" integer DEFAULT 1 NOT NULL,
	"status" "fulfillment_status" DEFAULT 'PENDING' NOT NULL,
	"claim_deadline" timestamp with time zone,
	"claimed_at" timestamp with time zone,
	"revoked_at" timestamp with time zone,
	"revoke_reason" text,
	"failure_reason" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "jobs" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"type" text NOT NULL,
	"payload" jsonb NOT NULL,
	"dedupe_key" text,
	"status" "job_status" DEFAULT 'QUEUED' NOT NULL,
	"attempts" integer DEFAULT 0 NOT NULL,
	"max_attempts" integer DEFAULT 6 NOT NULL,
	"run_at" timestamp with time zone DEFAULT now() NOT NULL,
	"locked_at" timestamp with time zone,
	"locked_by" text,
	"last_error" text,
	"completed_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "order_events" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"order_id" uuid NOT NULL,
	"type" text NOT NULL,
	"from_state" text,
	"to_state" text,
	"payload" jsonb,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "order_items" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"order_id" uuid NOT NULL,
	"line_key" text NOT NULL,
	"item_id" bigint NOT NULL,
	"model_id" bigint,
	"item_name" text NOT NULL,
	"variation_name" text,
	"quantity" integer DEFAULT 1 NOT NULL,
	"amount" numeric(14, 2),
	"image_url" text,
	"mapping_status" "mapping_status" DEFAULT 'UNMAPPED' NOT NULL,
	"digital_product_id" uuid,
	"unmapped_reason" text,
	"raw" jsonb,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "orders" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"store_id" uuid NOT NULL,
	"order_sn" text NOT NULL,
	"buyer_username" text,
	"buyer_phone_masked" text,
	"shopee_status" text,
	"state" "order_state" DEFAULT 'RECEIVED' NOT NULL,
	"total_amount" numeric(14, 2),
	"currency" text DEFAULT 'IDR',
	"payment_method" text,
	"message_to_seller" text,
	"create_time" timestamp with time zone,
	"update_time" timestamp with time zone,
	"paid_at" timestamp with time zone,
	"claimed_at" timestamp with time zone,
	"ineligible_reason" text,
	"raw" jsonb,
	"synced_at" timestamp with time zone DEFAULT now() NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "product_mappings" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"store_id" uuid NOT NULL,
	"shopee_product_id" uuid NOT NULL,
	"shopee_variation_id" uuid,
	"digital_product_id" uuid NOT NULL,
	"quantity_multiplier" integer DEFAULT 1 NOT NULL,
	"is_active" boolean DEFAULT true NOT NULL,
	"note" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "sessions" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"user_id" uuid NOT NULL,
	"token_hash" text NOT NULL,
	"ip" text,
	"user_agent" text,
	"expires_at" timestamp with time zone NOT NULL,
	"revoked_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "shopee_products" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"store_id" uuid NOT NULL,
	"item_id" bigint NOT NULL,
	"name" text NOT NULL,
	"status" text,
	"image_url" text,
	"has_model" boolean DEFAULT false NOT NULL,
	"price_min" numeric(14, 2),
	"price_max" numeric(14, 2),
	"raw" jsonb,
	"synced_at" timestamp with time zone DEFAULT now() NOT NULL,
	"deleted_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "shopee_stores" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"shop_id" bigint NOT NULL,
	"label" text NOT NULL,
	"shop_name" text,
	"region" text,
	"environment" "shopee_env" DEFAULT 'SANDBOX' NOT NULL,
	"status" "store_status" DEFAULT 'PENDING' NOT NULL,
	"brand_name" text,
	"claim_domain" text,
	"support_email" text,
	"support_whatsapp" text,
	"verification_policy" "verification_method" DEFAULT 'USERNAME' NOT NULL,
	"eligible_statuses" jsonb DEFAULT '["READY_TO_SHIP","PROCESSED","SHIPPED","TO_CONFIRM_RECEIVE","COMPLETED"]'::jsonb NOT NULL,
	"last_product_sync_at" timestamp with time zone,
	"last_order_sync_at" timestamp with time zone,
	"last_error" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "shopee_tokens" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"store_id" uuid NOT NULL,
	"access_token_enc" text NOT NULL,
	"refresh_token_enc" text NOT NULL,
	"expires_at" timestamp with time zone NOT NULL,
	"last_refreshed_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "shopee_variations" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"product_id" uuid NOT NULL,
	"model_id" bigint NOT NULL,
	"name" text NOT NULL,
	"sku" text,
	"price" numeric(14, 2),
	"stock" integer,
	"raw" jsonb,
	"synced_at" timestamp with time zone DEFAULT now() NOT NULL,
	"deleted_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "sync_jobs" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"store_id" uuid NOT NULL,
	"type" "sync_type" NOT NULL,
	"status" "job_status" DEFAULT 'QUEUED' NOT NULL,
	"attempts" integer DEFAULT 0 NOT NULL,
	"stats" jsonb,
	"error" text,
	"triggered_by" text DEFAULT 'admin' NOT NULL,
	"started_at" timestamp with time zone,
	"finished_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "system_settings" (
	"key" text PRIMARY KEY NOT NULL,
	"value" jsonb NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "users" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"email" text NOT NULL,
	"name" text NOT NULL,
	"password_hash" text NOT NULL,
	"role" "user_role" DEFAULT 'VIEWER' NOT NULL,
	"is_active" boolean DEFAULT true NOT NULL,
	"last_login_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "webhook_events" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"body_hash" text NOT NULL,
	"code" integer,
	"shop_id" bigint,
	"store_id" uuid,
	"order_sn" text,
	"signature_valid" boolean NOT NULL,
	"status" "webhook_status" DEFAULT 'RECEIVED' NOT NULL,
	"payload" jsonb,
	"error" text,
	"processed_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "claim_sessions" ADD CONSTRAINT "claim_sessions_order_id_orders_id_fk" FOREIGN KEY ("order_id") REFERENCES "public"."orders"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "claims" ADD CONSTRAINT "claims_fulfillment_id_fulfillments_id_fk" FOREIGN KEY ("fulfillment_id") REFERENCES "public"."fulfillments"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "claims" ADD CONSTRAINT "claims_order_id_orders_id_fk" FOREIGN KEY ("order_id") REFERENCES "public"."orders"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "claims" ADD CONSTRAINT "claims_digital_product_id_digital_products_id_fk" FOREIGN KEY ("digital_product_id") REFERENCES "public"."digital_products"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "claims" ADD CONSTRAINT "claims_claim_session_id_claim_sessions_id_fk" FOREIGN KEY ("claim_session_id") REFERENCES "public"."claim_sessions"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "delivery_logs" ADD CONSTRAINT "delivery_logs_claim_id_claims_id_fk" FOREIGN KEY ("claim_id") REFERENCES "public"."claims"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "delivery_logs" ADD CONSTRAINT "delivery_logs_fulfillment_id_fulfillments_id_fk" FOREIGN KEY ("fulfillment_id") REFERENCES "public"."fulfillments"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "delivery_logs" ADD CONSTRAINT "delivery_logs_digital_product_id_digital_products_id_fk" FOREIGN KEY ("digital_product_id") REFERENCES "public"."digital_products"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "digital_product_assets" ADD CONSTRAINT "digital_product_assets_digital_product_id_digital_products_id_fk" FOREIGN KEY ("digital_product_id") REFERENCES "public"."digital_products"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "digital_product_codes" ADD CONSTRAINT "digital_product_codes_digital_product_id_digital_products_id_fk" FOREIGN KEY ("digital_product_id") REFERENCES "public"."digital_products"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "fulfillments" ADD CONSTRAINT "fulfillments_order_id_orders_id_fk" FOREIGN KEY ("order_id") REFERENCES "public"."orders"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "fulfillments" ADD CONSTRAINT "fulfillments_order_item_id_order_items_id_fk" FOREIGN KEY ("order_item_id") REFERENCES "public"."order_items"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "fulfillments" ADD CONSTRAINT "fulfillments_store_id_shopee_stores_id_fk" FOREIGN KEY ("store_id") REFERENCES "public"."shopee_stores"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "fulfillments" ADD CONSTRAINT "fulfillments_digital_product_id_digital_products_id_fk" FOREIGN KEY ("digital_product_id") REFERENCES "public"."digital_products"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "order_events" ADD CONSTRAINT "order_events_order_id_orders_id_fk" FOREIGN KEY ("order_id") REFERENCES "public"."orders"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "order_items" ADD CONSTRAINT "order_items_order_id_orders_id_fk" FOREIGN KEY ("order_id") REFERENCES "public"."orders"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "order_items" ADD CONSTRAINT "order_items_digital_product_id_digital_products_id_fk" FOREIGN KEY ("digital_product_id") REFERENCES "public"."digital_products"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "orders" ADD CONSTRAINT "orders_store_id_shopee_stores_id_fk" FOREIGN KEY ("store_id") REFERENCES "public"."shopee_stores"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "product_mappings" ADD CONSTRAINT "product_mappings_store_id_shopee_stores_id_fk" FOREIGN KEY ("store_id") REFERENCES "public"."shopee_stores"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "product_mappings" ADD CONSTRAINT "product_mappings_shopee_product_id_shopee_products_id_fk" FOREIGN KEY ("shopee_product_id") REFERENCES "public"."shopee_products"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "product_mappings" ADD CONSTRAINT "product_mappings_shopee_variation_id_shopee_variations_id_fk" FOREIGN KEY ("shopee_variation_id") REFERENCES "public"."shopee_variations"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "product_mappings" ADD CONSTRAINT "product_mappings_digital_product_id_digital_products_id_fk" FOREIGN KEY ("digital_product_id") REFERENCES "public"."digital_products"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "sessions" ADD CONSTRAINT "sessions_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "shopee_products" ADD CONSTRAINT "shopee_products_store_id_shopee_stores_id_fk" FOREIGN KEY ("store_id") REFERENCES "public"."shopee_stores"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "shopee_tokens" ADD CONSTRAINT "shopee_tokens_store_id_shopee_stores_id_fk" FOREIGN KEY ("store_id") REFERENCES "public"."shopee_stores"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "shopee_variations" ADD CONSTRAINT "shopee_variations_product_id_shopee_products_id_fk" FOREIGN KEY ("product_id") REFERENCES "public"."shopee_products"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "sync_jobs" ADD CONSTRAINT "sync_jobs_store_id_shopee_stores_id_fk" FOREIGN KEY ("store_id") REFERENCES "public"."shopee_stores"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "webhook_events" ADD CONSTRAINT "webhook_events_store_id_shopee_stores_id_fk" FOREIGN KEY ("store_id") REFERENCES "public"."shopee_stores"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "audit_logs_created_idx" ON "audit_logs" USING btree ("created_at");--> statement-breakpoint
CREATE INDEX "audit_logs_action_idx" ON "audit_logs" USING btree ("action");--> statement-breakpoint
CREATE INDEX "claim_attempts_sn_idx" ON "claim_attempts" USING btree ("order_sn","created_at");--> statement-breakpoint
CREATE INDEX "claim_attempts_ip_idx" ON "claim_attempts" USING btree ("ip","created_at");--> statement-breakpoint
CREATE UNIQUE INDEX "claim_sessions_token_key" ON "claim_sessions" USING btree ("token_hash");--> statement-breakpoint
CREATE INDEX "claim_sessions_order_idx" ON "claim_sessions" USING btree ("order_id");--> statement-breakpoint
CREATE INDEX "claim_sessions_expiry_idx" ON "claim_sessions" USING btree ("expires_at");--> statement-breakpoint
CREATE UNIQUE INDEX "claims_fulfillment_session_key" ON "claims" USING btree ("fulfillment_id","claim_session_id");--> statement-breakpoint
CREATE INDEX "claims_order_idx" ON "claims" USING btree ("order_id");--> statement-breakpoint
CREATE INDEX "claims_status_idx" ON "claims" USING btree ("status");--> statement-breakpoint
CREATE INDEX "delivery_logs_claim_idx" ON "delivery_logs" USING btree ("claim_id");--> statement-breakpoint
CREATE INDEX "delivery_logs_created_idx" ON "delivery_logs" USING btree ("created_at");--> statement-breakpoint
CREATE INDEX "digital_product_assets_product_idx" ON "digital_product_assets" USING btree ("digital_product_id");--> statement-breakpoint
CREATE INDEX "digital_product_codes_pool_idx" ON "digital_product_codes" USING btree ("digital_product_id","assigned_at");--> statement-breakpoint
CREATE UNIQUE INDEX "digital_product_codes_claim_key" ON "digital_product_codes" USING btree ("assigned_claim_id");--> statement-breakpoint
CREATE UNIQUE INDEX "digital_products_slug_key" ON "digital_products" USING btree ("slug");--> statement-breakpoint
CREATE UNIQUE INDEX "fulfillments_item_product_key" ON "fulfillments" USING btree ("order_item_id","digital_product_id");--> statement-breakpoint
CREATE INDEX "fulfillments_status_idx" ON "fulfillments" USING btree ("status");--> statement-breakpoint
CREATE INDEX "fulfillments_order_idx" ON "fulfillments" USING btree ("order_id");--> statement-breakpoint
CREATE UNIQUE INDEX "jobs_dedupe_key" ON "jobs" USING btree ("dedupe_key") WHERE "jobs"."dedupe_key" is not null and "jobs"."status" in ('QUEUED','RUNNING');--> statement-breakpoint
CREATE INDEX "jobs_poll_idx" ON "jobs" USING btree ("status","run_at");--> statement-breakpoint
CREATE INDEX "order_events_order_idx" ON "order_events" USING btree ("order_id","created_at");--> statement-breakpoint
CREATE UNIQUE INDEX "order_items_order_line_key" ON "order_items" USING btree ("order_id","line_key");--> statement-breakpoint
CREATE INDEX "order_items_order_idx" ON "order_items" USING btree ("order_id");--> statement-breakpoint
CREATE UNIQUE INDEX "orders_store_sn_key" ON "orders" USING btree ("store_id","order_sn");--> statement-breakpoint
CREATE INDEX "orders_state_idx" ON "orders" USING btree ("state");--> statement-breakpoint
CREATE INDEX "orders_created_idx" ON "orders" USING btree ("created_at");--> statement-breakpoint
CREATE INDEX "orders_buyer_idx" ON "orders" USING btree ("buyer_username");--> statement-breakpoint
CREATE UNIQUE INDEX "product_mappings_variation_key" ON "product_mappings" USING btree ("shopee_variation_id") WHERE "product_mappings"."shopee_variation_id" is not null;--> statement-breakpoint
CREATE UNIQUE INDEX "product_mappings_item_key" ON "product_mappings" USING btree ("shopee_product_id") WHERE "product_mappings"."shopee_variation_id" is null;--> statement-breakpoint
CREATE INDEX "product_mappings_digital_idx" ON "product_mappings" USING btree ("digital_product_id");--> statement-breakpoint
CREATE UNIQUE INDEX "sessions_token_hash_key" ON "sessions" USING btree ("token_hash");--> statement-breakpoint
CREATE INDEX "sessions_user_idx" ON "sessions" USING btree ("user_id");--> statement-breakpoint
CREATE UNIQUE INDEX "shopee_products_store_item_key" ON "shopee_products" USING btree ("store_id","item_id");--> statement-breakpoint
CREATE UNIQUE INDEX "shopee_stores_env_shop_key" ON "shopee_stores" USING btree ("environment","shop_id");--> statement-breakpoint
CREATE UNIQUE INDEX "shopee_tokens_store_key" ON "shopee_tokens" USING btree ("store_id");--> statement-breakpoint
CREATE UNIQUE INDEX "shopee_variations_product_model_key" ON "shopee_variations" USING btree ("product_id","model_id");--> statement-breakpoint
CREATE INDEX "sync_jobs_store_idx" ON "sync_jobs" USING btree ("store_id","created_at");--> statement-breakpoint
CREATE INDEX "sync_jobs_status_idx" ON "sync_jobs" USING btree ("status");--> statement-breakpoint
CREATE UNIQUE INDEX "users_email_key" ON "users" USING btree (lower("email"));--> statement-breakpoint
CREATE UNIQUE INDEX "webhook_events_body_hash_key" ON "webhook_events" USING btree ("body_hash");--> statement-breakpoint
CREATE INDEX "webhook_events_received_idx" ON "webhook_events" USING btree ("created_at");