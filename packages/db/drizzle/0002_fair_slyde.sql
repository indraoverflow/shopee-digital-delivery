ALTER TABLE "digital_products" ADD COLUMN "meterai_enabled" boolean DEFAULT false NOT NULL;--> statement-breakpoint
ALTER TABLE "fulfillments" ADD COLUMN "minted_secret_enc" text;--> statement-breakpoint
ALTER TABLE "fulfillments" ADD COLUMN "minted_at" timestamp with time zone;--> statement-breakpoint
ALTER TABLE "fulfillments" ADD COLUMN "minted_by" text;