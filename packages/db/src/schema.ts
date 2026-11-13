import { sql } from "drizzle-orm";
import {
  bigint,
  bigserial,
  boolean,
  index,
  integer,
  jsonb,
  numeric,
  pgEnum,
  pgTable,
  text,
  timestamp,
  uniqueIndex,
  uuid,
} from "drizzle-orm/pg-core";

/**
 * Money is stored as numeric so a Shopee float never becomes a rounding error
 * in a report, and timestamps are always `timestamptz`: the worker, the API
 * and the database may sit in different zones.
 */
const createdAt = () =>
  timestamp("created_at", { withTimezone: true }).notNull().defaultNow();
const updatedAt = () =>
  timestamp("updated_at", { withTimezone: true }).notNull().defaultNow();

/* ------------------------------------------------------------------ enums */

export const userRoleEnum = pgEnum("user_role", [
  "OWNER",
  "ADMIN",
  "OPERATOR",
  "VIEWER",
]);
export const storeStatusEnum = pgEnum("store_status", [
  "PENDING",
  "CONNECTED",
  "ERROR",
  "DISCONNECTED",
]);
export const shopeeEnvEnum = pgEnum("shopee_env", ["SANDBOX", "PRODUCTION"]);

/**
 * The order state machine. Every value is reachable only through the
 * transitions encoded in packages/core/src/order-state.ts, and each transition
 * writes an order_events row.
 */
export const orderStateEnum = pgEnum("order_state", [
  "RECEIVED",
  "VALIDATED",
  "FULFILLED",
  "CLAIMED",
  "COMPLETED",
  "INELIGIBLE",
  "CANCELLED",
  "EXPIRED",
  "FAILED",
]);

export const mappingStatusEnum = pgEnum("mapping_status", [
  "UNMAPPED",
  "MAPPED",
  "AMBIGUOUS",
]);
export const fulfillmentStatusEnum = pgEnum("fulfillment_status", [
  "PENDING",
  "CLAIMABLE",
  "CLAIMED",
  "REVOKED",
  "EXPIRED",
  "FAILED",
]);
export const claimStatusEnum = pgEnum("claim_status", [
  "ISSUED",
  "COMPLETED",
  "REVOKED",
  "EXPIRED",
  "BLOCKED",
]);
export const deliveryKindEnum = pgEnum("delivery_kind", [
  "FILE",
  "LINK",
  "CODE",
  "CREDENTIALS",
  "INSTRUCTIONS",
]);
export const digitalProductStatusEnum = pgEnum("digital_product_status", [
  "DRAFT",
  "ACTIVE",
  "ARCHIVED",
]);
export const jobStatusEnum = pgEnum("job_status", [
  "QUEUED",
  "RUNNING",
  "SUCCEEDED",
  "FAILED",
  "DEAD",
]);
export const syncTypeEnum = pgEnum("sync_type", ["PRODUCTS", "ORDERS"]);
export const webhookStatusEnum = pgEnum("webhook_status", [
  "RECEIVED",
  "PROCESSED",
  "DUPLICATE",
  "IGNORED",
  "FAILED",
]);
export const verificationMethodEnum = pgEnum("verification_method", [
  "USERNAME",
  "USERNAME_PHONE",
  "MANUAL",
]);
/** A buyer asking a human to vouch for them when the automatic factors cannot be met. */
export const claimRequestStatusEnum = pgEnum("claim_request_status", [
  "PENDING",
  "APPROVED",
  "REJECTED",
  "EXPIRED",
]);

/* ------------------------------------------------------- identity & access */

export const users = pgTable(
  "users",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    email: text("email").notNull(),
    name: text("name").notNull(),
    /** scrypt hash: `scrypt$N$r$p$salt$hash`, never a plaintext password. */
    passwordHash: text("password_hash").notNull(),
    role: userRoleEnum("role").notNull().default("VIEWER"),
    isActive: boolean("is_active").notNull().default(true),
    lastLoginAt: timestamp("last_login_at", { withTimezone: true }),
    /** TOTP secret, encrypted with APP_ENCRYPTION_KEY; null until enrolled. */
    totpSecretEnc: text("totp_secret_enc"),
    /** Set when the first valid code confirmed the enrolment. */
    totpEnabledAt: timestamp("totp_enabled_at", { withTimezone: true }),
    /** sha256 of each unused recovery code. */
    recoveryCodeHashes: jsonb("recovery_code_hashes").$type<string[]>(),
    /** Bumped on every password change so old sessions cannot be reused. */
    passwordChangedAt: timestamp("password_changed_at", { withTimezone: true }),
    createdAt: createdAt(),
    updatedAt: updatedAt(),
  },
  (table) => [uniqueIndex("users_email_key").on(sql`lower(${table.email})`)],
);

/**
 * A login that produced a correct password but still needs the second factor.
 * The row is short lived and single use, so an intercepted cookie from this
 * stage cannot be replayed after the real session exists.
 */
export const loginChallenges = pgTable(
  "login_challenges",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    userId: uuid("user_id")
      .notNull()
      .references(() => users.id, { onDelete: "cascade" }),
    tokenHash: text("token_hash").notNull(),
    ip: text("ip"),
    userAgent: text("user_agent"),
    attempts: integer("attempts").notNull().default(0),
    expiresAt: timestamp("expires_at", { withTimezone: true }).notNull(),
    consumedAt: timestamp("consumed_at", { withTimezone: true }),
    createdAt: createdAt(),
  },
  (table) => [
    uniqueIndex("login_challenges_token_key").on(table.tokenHash),
    index("login_challenges_user_idx").on(table.userId),
  ],
);

/** Opaque session tokens: the cookie holds the token, the row holds its sha256. */
export const sessions = pgTable(
  "sessions",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    userId: uuid("user_id")
      .notNull()
      .references(() => users.id, { onDelete: "cascade" }),
    tokenHash: text("token_hash").notNull(),
    ip: text("ip"),
    userAgent: text("user_agent"),
    expiresAt: timestamp("expires_at", { withTimezone: true }).notNull(),
    revokedAt: timestamp("revoked_at", { withTimezone: true }),
    createdAt: createdAt(),
  },
  (table) => [
    uniqueIndex("sessions_token_hash_key").on(table.tokenHash),
    index("sessions_user_idx").on(table.userId),
  ],
);

/**
 * Permissions are stored as a role to permission map in code (see
 * packages/core/src/permissions.ts) so a role change cannot leave a stale
 * grant behind in the database.
 */

/* ------------------------------------------------------------ shopee stores */

export const shopeeStores = pgTable(
  "shopee_stores",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    /** Shopee shop id; unique together with the environment. */
    shopId: bigint("shop_id", { mode: "number" }).notNull(),
    label: text("label").notNull(),
    shopName: text("shop_name"),
    region: text("region"),
    environment: shopeeEnvEnum("environment").notNull().default("SANDBOX"),
    status: storeStatusEnum("status").notNull().default("PENDING"),
    /** Branding shown on the claim portal for this store. */
    brandName: text("brand_name"),
    claimDomain: text("claim_domain"),
    supportEmail: text("support_email"),
    supportWhatsapp: text("support_whatsapp"),
    /** USERNAME compares the Shopee buyer_username; USERNAME_PHONE adds the phone suffix. */
    verificationPolicy: verificationMethodEnum("verification_policy")
      .notNull()
      .default("USERNAME"),
    /** Shopee order_status values treated as paid and fulfilable. */
    eligibleStatuses: jsonb("eligible_statuses")
      .$type<string[]>()
      .notNull()
      .default(
        sql`'["READY_TO_SHIP","PROCESSED","SHIPPED","TO_CONFIRM_RECEIVE","COMPLETED"]'::jsonb`,
      ),
    lastProductSyncAt: timestamp("last_product_sync_at", {
      withTimezone: true,
    }),
    lastOrderSyncAt: timestamp("last_order_sync_at", { withTimezone: true }),
    lastError: text("last_error"),
    createdAt: createdAt(),
    updatedAt: updatedAt(),
  },
  (table) => [
    uniqueIndex("shopee_stores_env_shop_key").on(
      table.environment,
      table.shopId,
    ),
  ],
);

/**
 * Tokens are encrypted at rest with AES-256-GCM (APP_ENCRYPTION_KEY). Refresh
 * tokens are single use: every refresh replaces the pair, so this table always
 * holds the newest one and a lost row costs the seller a new authorization.
 */
export const shopeeTokens = pgTable(
  "shopee_tokens",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    storeId: uuid("store_id")
      .notNull()
      .references(() => shopeeStores.id, { onDelete: "cascade" }),
    accessTokenEnc: text("access_token_enc").notNull(),
    refreshTokenEnc: text("refresh_token_enc").notNull(),
    expiresAt: timestamp("expires_at", { withTimezone: true }).notNull(),
    lastRefreshedAt: timestamp("last_refreshed_at", { withTimezone: true }),
    createdAt: createdAt(),
    updatedAt: updatedAt(),
  },
  (table) => [uniqueIndex("shopee_tokens_store_key").on(table.storeId)],
);

/* ---------------------------------------------------------------- catalog */

export const shopeeProducts = pgTable(
  "shopee_products",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    storeId: uuid("store_id")
      .notNull()
      .references(() => shopeeStores.id, { onDelete: "cascade" }),
    itemId: bigint("item_id", { mode: "number" }).notNull(),
    name: text("name").notNull(),
    status: text("status"),
    imageUrl: text("image_url"),
    hasModel: boolean("has_model").notNull().default(false),
    priceMin: numeric("price_min", { precision: 14, scale: 2 }),
    priceMax: numeric("price_max", { precision: 14, scale: 2 }),
    /** Raw Shopee payload, kept for diagnosis without another API call. */
    raw: jsonb("raw").$type<Record<string, unknown>>(),
    syncedAt: timestamp("synced_at", { withTimezone: true })
      .notNull()
      .defaultNow(),
    /** Soft delete: a product removed in Shopee keeps its mapping history. */
    deletedAt: timestamp("deleted_at", { withTimezone: true }),
    createdAt: createdAt(),
    updatedAt: updatedAt(),
  },
  (table) => [
    uniqueIndex("shopee_products_store_item_key").on(
      table.storeId,
      table.itemId,
    ),
  ],
);

export const shopeeVariations = pgTable(
  "shopee_variations",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    productId: uuid("product_id")
      .notNull()
      .references(() => shopeeProducts.id, { onDelete: "cascade" }),
    modelId: bigint("model_id", { mode: "number" }).notNull(),
    name: text("name").notNull(),
    sku: text("sku"),
    price: numeric("price", { precision: 14, scale: 2 }),
    stock: integer("stock"),
    raw: jsonb("raw").$type<Record<string, unknown>>(),
    syncedAt: timestamp("synced_at", { withTimezone: true })
      .notNull()
      .defaultNow(),
    deletedAt: timestamp("deleted_at", { withTimezone: true }),
    createdAt: createdAt(),
  },
  (table) => [
    uniqueIndex("shopee_variations_product_model_key").on(
      table.productId,
      table.modelId,
    ),
  ],
);

/* ------------------------------------------------------- digital products */

export const digitalProducts = pgTable(
  "digital_products",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    name: text("name").notNull(),
    slug: text("slug").notNull(),
    description: text("description"),
    deliveryKind: deliveryKindEnum("delivery_kind").notNull(),
    /** Shown to the buyer before and after the claim. */
    instructions: text("instructions"),
    externalUrl: text("external_url"),
    status: digitalProductStatusEnum("status").notNull().default("DRAFT"),
    /** Days the buyer has to claim after the order became fulfilable. */
    claimExpiryDays: integer("claim_expiry_days").notNull().default(30),
    /** How many times one order item may be delivered. */
    maxDeliveries: integer("max_deliveries").notNull().default(3),
    createdAt: createdAt(),
    updatedAt: updatedAt(),
    archivedAt: timestamp("archived_at", { withTimezone: true }),
  },
  (table) => [uniqueIndex("digital_products_slug_key").on(table.slug)],
);

export const digitalProductAssets = pgTable(
  "digital_product_assets",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    digitalProductId: uuid("digital_product_id")
      .notNull()
      .references(() => digitalProducts.id, { onDelete: "cascade" }),
    /** Storage key inside the configured bucket or directory, never a public URL. */
    storageKey: text("storage_key").notNull(),
    fileName: text("file_name").notNull(),
    mimeType: text("mime_type").notNull(),
    sizeBytes: bigint("size_bytes", { mode: "number" }).notNull(),
    sha256: text("sha256").notNull(),
    createdAt: createdAt(),
  },
  (table) => [
    index("digital_product_assets_product_idx").on(table.digitalProductId),
  ],
);

/**
 * Activation codes, licence keys and credentials live in one table: a claim
 * takes the oldest unassigned row inside a transaction with SKIP LOCKED, so two
 * buyers claiming at the same moment can never receive the same code.
 */
export const digitalProductCodes = pgTable(
  "digital_product_codes",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    digitalProductId: uuid("digital_product_id")
      .notNull()
      .references(() => digitalProducts.id, { onDelete: "cascade" }),
    /** Secret payload: the code, or JSON for a username/password pair. */
    secretEnc: text("secret_enc").notNull(),
    /** Non-secret label shown in the admin list, e.g. a masked code. */
    label: text("label"),
    assignedClaimId: uuid("assigned_claim_id"),
    assignedAt: timestamp("assigned_at", { withTimezone: true }),
    createdAt: createdAt(),
  },
  (table) => [
    index("digital_product_codes_pool_idx").on(
      table.digitalProductId,
      table.assignedAt,
    ),
    uniqueIndex("digital_product_codes_claim_key").on(table.assignedClaimId),
  ],
);

/* ------------------------------------------------------------------ mapping */

export const productMappings = pgTable(
  "product_mappings",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    storeId: uuid("store_id")
      .notNull()
      .references(() => shopeeStores.id, { onDelete: "cascade" }),
    shopeeProductId: uuid("shopee_product_id")
      .notNull()
      .references(() => shopeeProducts.id, { onDelete: "cascade" }),
    /** Null maps the whole listing, used when the listing has no variations. */
    shopeeVariationId: uuid("shopee_variation_id").references(
      () => shopeeVariations.id,
      { onDelete: "cascade" },
    ),
    digitalProductId: uuid("digital_product_id")
      .notNull()
      .references(() => digitalProducts.id, { onDelete: "restrict" }),
    /** Multiplier applied to purchased quantity, e.g. 1 package = 3 licences. */
    quantityMultiplier: integer("quantity_multiplier").notNull().default(1),
    isActive: boolean("is_active").notNull().default(true),
    note: text("note"),
    createdAt: createdAt(),
    updatedAt: updatedAt(),
  },
  (table) => [
    uniqueIndex("product_mappings_variation_key")
      .on(table.shopeeVariationId)
      .where(sql`${table.shopeeVariationId} is not null`),
    uniqueIndex("product_mappings_item_key")
      .on(table.shopeeProductId)
      .where(sql`${table.shopeeVariationId} is null`),
    index("product_mappings_digital_idx").on(table.digitalProductId),
  ],
);

/* ------------------------------------------------------------------- orders */

export const orders = pgTable(
  "orders",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    storeId: uuid("store_id")
      .notNull()
      .references(() => shopeeStores.id, { onDelete: "cascade" }),
    orderSn: text("order_sn").notNull(),
    buyerUsername: text("buyer_username"),
    /** Masked phone as returned by Shopee, e.g. "********1234". */
    buyerPhoneMasked: text("buyer_phone_masked"),
    shopeeStatus: text("shopee_status"),
    state: orderStateEnum("state").notNull().default("RECEIVED"),
    totalAmount: numeric("total_amount", { precision: 14, scale: 2 }),
    currency: text("currency").default("IDR"),
    paymentMethod: text("payment_method"),
    messageToSeller: text("message_to_seller"),
    createTime: timestamp("create_time", { withTimezone: true }),
    updateTime: timestamp("update_time", { withTimezone: true }),
    paidAt: timestamp("paid_at", { withTimezone: true }),
    claimedAt: timestamp("claimed_at", { withTimezone: true }),
    /** Why the order may not be claimed; null when it may. */
    ineligibleReason: text("ineligible_reason"),
    raw: jsonb("raw").$type<Record<string, unknown>>(),
    syncedAt: timestamp("synced_at", { withTimezone: true })
      .notNull()
      .defaultNow(),
    createdAt: createdAt(),
    updatedAt: updatedAt(),
  },
  (table) => [
    uniqueIndex("orders_store_sn_key").on(table.storeId, table.orderSn),
    index("orders_state_idx").on(table.state),
    index("orders_created_idx").on(table.createdAt),
    index("orders_buyer_idx").on(table.buyerUsername),
  ],
);

export const orderItems = pgTable(
  "order_items",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    orderId: uuid("order_id")
      .notNull()
      .references(() => orders.id, { onDelete: "cascade" }),
    /** `${item_id}:${model_id ?? 0}`, unique per order: the natural dedupe key. */
    lineKey: text("line_key").notNull(),
    itemId: bigint("item_id", { mode: "number" }).notNull(),
    modelId: bigint("model_id", { mode: "number" }),
    itemName: text("item_name").notNull(),
    variationName: text("variation_name"),
    quantity: integer("quantity").notNull().default(1),
    amount: numeric("amount", { precision: 14, scale: 2 }),
    imageUrl: text("image_url"),
    mappingStatus: mappingStatusEnum("mapping_status")
      .notNull()
      .default("UNMAPPED"),
    digitalProductId: uuid("digital_product_id").references(
      () => digitalProducts.id,
      { onDelete: "set null" },
    ),
    /** Why the line could not be mapped, surfaced in the admin order page. */
    unmappedReason: text("unmapped_reason"),
    raw: jsonb("raw").$type<Record<string, unknown>>(),
    createdAt: createdAt(),
    updatedAt: updatedAt(),
  },
  (table) => [
    uniqueIndex("order_items_order_line_key").on(table.orderId, table.lineKey),
    index("order_items_order_idx").on(table.orderId),
  ],
);

/** Append-only audit trail of order state transitions and pipeline steps. */
export const orderEvents = pgTable(
  "order_events",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    orderId: uuid("order_id")
      .notNull()
      .references(() => orders.id, { onDelete: "cascade" }),
    type: text("type").notNull(),
    fromState: text("from_state"),
    toState: text("to_state"),
    payload: jsonb("payload").$type<Record<string, unknown>>(),
    createdAt: createdAt(),
  },
  (table) => [
    index("order_events_order_idx").on(table.orderId, table.createdAt),
  ],
);

/* -------------------------------------------------- fulfilment and claims */

export const fulfillments = pgTable(
  "fulfillments",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    orderId: uuid("order_id")
      .notNull()
      .references(() => orders.id, { onDelete: "cascade" }),
    orderItemId: uuid("order_item_id")
      .notNull()
      .references(() => orderItems.id, { onDelete: "cascade" }),
    storeId: uuid("store_id")
      .notNull()
      .references(() => shopeeStores.id, { onDelete: "cascade" }),
    digitalProductId: uuid("digital_product_id")
      .notNull()
      .references(() => digitalProducts.id, { onDelete: "restrict" }),
    /** Units to deliver: purchased quantity times the mapping multiplier. */
    quantity: integer("quantity").notNull().default(1),
    status: fulfillmentStatusEnum("status").notNull().default("PENDING"),
    claimDeadline: timestamp("claim_deadline", { withTimezone: true }),
    claimedAt: timestamp("claimed_at", { withTimezone: true }),
    revokedAt: timestamp("revoked_at", { withTimezone: true }),
    revokeReason: text("revoke_reason"),
    failureReason: text("failure_reason"),
    createdAt: createdAt(),
    updatedAt: updatedAt(),
  },
  (table) => [
    uniqueIndex("fulfillments_item_product_key").on(
      table.orderItemId,
      table.digitalProductId,
    ),
    index("fulfillments_status_idx").on(table.status),
    index("fulfillments_order_idx").on(table.orderId),
  ],
);

/**
 * A verified claim session: what the portal gets after a buyer proves who they
 * are. The cookie holds the token, this table holds its sha256, and the session
 * is scoped to one order so it can never unlock another buyer's items.
 */
export const claimSessions = pgTable(
  "claim_sessions",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    orderId: uuid("order_id")
      .notNull()
      .references(() => orders.id, { onDelete: "cascade" }),
    tokenHash: text("token_hash").notNull(),
    method: verificationMethodEnum("method").notNull(),
    ip: text("ip"),
    userAgent: text("user_agent"),
    expiresAt: timestamp("expires_at", { withTimezone: true }).notNull(),
    createdAt: createdAt(),
  },
  (table) => [
    uniqueIndex("claim_sessions_token_key").on(table.tokenHash),
    index("claim_sessions_order_idx").on(table.orderId),
    index("claim_sessions_expiry_idx").on(table.expiresAt),
  ],
);

export const claims = pgTable(
  "claims",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    fulfillmentId: uuid("fulfillment_id")
      .notNull()
      .references(() => fulfillments.id, { onDelete: "cascade" }),
    orderId: uuid("order_id")
      .notNull()
      .references(() => orders.id, { onDelete: "cascade" }),
    digitalProductId: uuid("digital_product_id")
      .notNull()
      .references(() => digitalProducts.id, { onDelete: "restrict" }),
    /** The verified session that delivered this claim, null once pruned. */
    claimSessionId: uuid("claim_session_id").references(
      () => claimSessions.id,
      { onDelete: "set null" },
    ),
    status: claimStatusEnum("status").notNull().default("ISSUED"),
    verificationMethod: verificationMethodEnum("verification_method").notNull(),
    deliveriesUsed: integer("deliveries_used").notNull().default(0),
    ip: text("ip"),
    userAgent: text("user_agent"),
    completedAt: timestamp("completed_at", { withTimezone: true }),
    revokedAt: timestamp("revoked_at", { withTimezone: true }),
    revokeReason: text("revoke_reason"),
    expiresAt: timestamp("expires_at", { withTimezone: true }).notNull(),
    createdAt: createdAt(),
    updatedAt: updatedAt(),
  },
  (table) => [
    uniqueIndex("claims_fulfillment_session_key").on(
      table.fulfillmentId,
      table.claimSessionId,
    ),
    index("claims_order_idx").on(table.orderId),
    index("claims_status_idx").on(table.status),
  ],
);

/** Every verification attempt, successful or not, for abuse detection. */
export const claimAttempts = pgTable(
  "claim_attempts",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    orderSn: text("order_sn"),
    method: verificationMethodEnum("method").notNull(),
    success: boolean("success").notNull(),
    reason: text("reason"),
    ip: text("ip"),
    userAgent: text("user_agent"),
    createdAt: createdAt(),
  },
  (table) => [
    index("claim_attempts_sn_idx").on(table.orderSn, table.createdAt),
    index("claim_attempts_ip_idx").on(table.ip, table.createdAt),
  ],
);

export const deliveryLogs = pgTable(
  "delivery_logs",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    claimId: uuid("claim_id")
      .notNull()
      .references(() => claims.id, { onDelete: "cascade" }),
    fulfillmentId: uuid("fulfillment_id")
      .notNull()
      .references(() => fulfillments.id, { onDelete: "cascade" }),
    digitalProductId: uuid("digital_product_id")
      .notNull()
      .references(() => digitalProducts.id, { onDelete: "restrict" }),
    kind: deliveryKindEnum("kind").notNull(),
    /** Signed-URL id or code label; never the secret itself. */
    reference: text("reference"),
    ip: text("ip"),
    createdAt: createdAt(),
  },
  (table) => [
    index("delivery_logs_claim_idx").on(table.claimId),
    index("delivery_logs_created_idx").on(table.createdAt),
  ],
);

/* ------------------------------------------------------------ operations */

export const syncJobs = pgTable(
  "sync_jobs",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    storeId: uuid("store_id")
      .notNull()
      .references(() => shopeeStores.id, { onDelete: "cascade" }),
    type: syncTypeEnum("type").notNull(),
    status: jobStatusEnum("status").notNull().default("QUEUED"),
    attempts: integer("attempts").notNull().default(0),
    /** e.g. { items: 42, created: 3, updated: 39, removed: 0 } */
    stats: jsonb("stats").$type<Record<string, unknown>>(),
    error: text("error"),
    triggeredBy: text("triggered_by").notNull().default("admin"),
    startedAt: timestamp("started_at", { withTimezone: true }),
    finishedAt: timestamp("finished_at", { withTimezone: true }),
    createdAt: createdAt(),
  },
  (table) => [
    index("sync_jobs_store_idx").on(table.storeId, table.createdAt),
    index("sync_jobs_status_idx").on(table.status),
  ],
);

export const webhookEvents = pgTable(
  "webhook_events",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    /** sha256(rawBody): the duplicate guard, since Shopee retries the same push. */
    bodyHash: text("body_hash").notNull(),
    code: integer("code"),
    shopId: bigint("shop_id", { mode: "number" }),
    storeId: uuid("store_id").references(() => shopeeStores.id, {
      onDelete: "set null",
    }),
    orderSn: text("order_sn"),
    signatureValid: boolean("signature_valid").notNull(),
    status: webhookStatusEnum("status").notNull().default("RECEIVED"),
    payload: jsonb("payload").$type<Record<string, unknown>>(),
    error: text("error"),
    processedAt: timestamp("processed_at", { withTimezone: true }),
    receivedAt: createdAt(),
  },
  (table) => [
    uniqueIndex("webhook_events_body_hash_key").on(table.bodyHash),
    index("webhook_events_received_idx").on(table.receivedAt),
  ],
);

/**
 * The job queue is a table, not Redis: the volume here is a few hundred jobs a
 * day, and SELECT ... FOR UPDATE SKIP LOCKED gives at-least-once delivery with
 * no extra service to operate.
 */
export const jobs = pgTable(
  "jobs",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    type: text("type").notNull(),
    payload: jsonb("payload").$type<Record<string, unknown>>().notNull(),
    /** Stable key so the same work can only be queued once while pending. */
    dedupeKey: text("dedupe_key"),
    status: jobStatusEnum("status").notNull().default("QUEUED"),
    attempts: integer("attempts").notNull().default(0),
    maxAttempts: integer("max_attempts").notNull().default(6),
    runAt: timestamp("run_at", { withTimezone: true }).notNull().defaultNow(),
    lockedAt: timestamp("locked_at", { withTimezone: true }),
    lockedBy: text("locked_by"),
    lastError: text("last_error"),
    completedAt: timestamp("completed_at", { withTimezone: true }),
    createdAt: createdAt(),
  },
  (table) => [
    uniqueIndex("jobs_dedupe_key")
      .on(table.dedupeKey)
      .where(
        sql`${table.dedupeKey} is not null and ${table.status} in ('QUEUED','RUNNING')`,
      ),
    index("jobs_poll_idx").on(table.status, table.runAt),
  ],
);

export const auditLogs = pgTable(
  "audit_logs",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    actorType: text("actor_type").notNull().default("ADMIN"),
    actorId: uuid("actor_id"),
    actorLabel: text("actor_label"),
    action: text("action").notNull(),
    targetType: text("target_type"),
    targetId: text("target_id"),
    metadata: jsonb("metadata").$type<Record<string, unknown>>(),
    ip: text("ip"),
    /**
     * Hash chain: each row covers the previous row's hash, so deleting or
     * editing a row is detectable by replaying the chain.
     */
    prevHash: text("prev_hash"),
    entryHash: text("entry_hash"),
    seq: bigserial("seq", { mode: "number" }).notNull().unique(),
    createdAt: createdAt(),
  },
  (table) => [
    index("audit_logs_created_idx").on(table.createdAt),
    index("audit_logs_action_idx").on(table.action),
  ],
);

/**
 * Manual verification queue. A buyer who cannot satisfy the automatic factors
 * (usually because Shopee returned no phone) asks an operator to check the
 * order out of band. Approval opens a time-boxed window in which the username
 * alone is accepted for that order, and every step is recorded.
 */
export const claimRequests = pgTable(
  "claim_requests",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    orderId: uuid("order_id")
      .notNull()
      .references(() => orders.id, { onDelete: "cascade" }),
    storeId: uuid("store_id")
      .notNull()
      .references(() => shopeeStores.id, { onDelete: "cascade" }),
    status: claimRequestStatusEnum("status").notNull().default("PENDING"),
    /** What the buyer told the operator, e.g. the Shopee account email. */
    contact: text("contact").notNull(),
    note: text("note"),
    ip: text("ip"),
    userAgent: text("user_agent"),
    reviewedBy: uuid("reviewed_by").references(() => users.id, {
      onDelete: "set null",
    }),
    reviewedAt: timestamp("reviewed_at", { withTimezone: true }),
    reviewNote: text("review_note"),
    /** While set and in the future, username-only verification is accepted. */
    approvedUntil: timestamp("approved_until", { withTimezone: true }),
    createdAt: createdAt(),
    updatedAt: updatedAt(),
  },
  (table) => [
    index("claim_requests_status_idx").on(table.status),
    index("claim_requests_order_idx").on(table.orderId),
    uniqueIndex("claim_requests_pending_key")
      .on(table.orderId)
      .where(sql`${table.status} = 'PENDING'`),
  ],
);

export const systemSettings = pgTable("system_settings", {
  key: text("key").primaryKey(),
  value: jsonb("value").$type<unknown>().notNull(),
  updatedAt: updatedAt(),
});

/* --------------------------------------------------------------- inferred */

export type User = typeof users.$inferSelect;
export type ShopeeStore = typeof shopeeStores.$inferSelect;
export type ShopeeProduct = typeof shopeeProducts.$inferSelect;
export type ShopeeVariation = typeof shopeeVariations.$inferSelect;
export type DigitalProduct = typeof digitalProducts.$inferSelect;
export type DigitalProductAsset = typeof digitalProductAssets.$inferSelect;
export type ProductMapping = typeof productMappings.$inferSelect;
export type Order = typeof orders.$inferSelect;
export type OrderItem = typeof orderItems.$inferSelect;
export type Fulfillment = typeof fulfillments.$inferSelect;
export type Claim = typeof claims.$inferSelect;
export type ClaimRequest = typeof claimRequests.$inferSelect;
export type LoginChallenge = typeof loginChallenges.$inferSelect;
export type ClaimSession = typeof claimSessions.$inferSelect;
export type DeliveryLog = typeof deliveryLogs.$inferSelect;
export type SyncJob = typeof syncJobs.$inferSelect;
export type WebhookEvent = typeof webhookEvents.$inferSelect;
export type Job = typeof jobs.$inferSelect;
export type AuditLog = typeof auditLogs.$inferSelect;
