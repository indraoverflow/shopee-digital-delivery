import { AppError } from "@qansa/core";
import { schema } from "@qansa/db";
import { and, count, desc, eq, sql } from "drizzle-orm";
import { recordAudit } from "./audit.js";
import { notify } from "./notify.js";
import { loadSettings } from "./settings.js";
import type { ServiceDeps } from "./types.js";
import { nowOf } from "./types.js";

/**
 * Manual verification, the answer to a Shopee mask that hides the phone.
 *
 * The buyer asks, an operator checks the order out of band, and approval opens a
 * time-boxed window in which the username alone is accepted for that one order.
 * Nothing here bypasses the order check: the order still has to be paid and
 * claimable, and every step is audited.
 */

export interface CreateClaimRequestInput {
  orderSn: string;
  buyerUsername: string;
  contact: string;
  note?: string | undefined;
  ip?: string | undefined;
  userAgent?: string | undefined;
}

export interface ClaimRequestCreated {
  id: string;
  status: "PENDING";
  /** True when an identical request was already waiting. */
  existing: boolean;
}

export async function createClaimRequest(
  deps: ServiceDeps,
  input: CreateClaimRequestInput,
): Promise<ClaimRequestCreated> {
  const orderSn = input.orderSn.trim().toUpperCase();

  const [row] = await deps.db
    .select({ order: schema.orders })
    .from(schema.orders)
    .where(eq(schema.orders.orderSn, orderSn))
    .limit(1);

  // A wrong username is answered exactly like an unknown order: this endpoint
  // must not become an order-number oracle.
  const expected = row?.order.buyerUsername?.trim().toLowerCase() ?? "";
  const provided = input.buyerUsername.trim().toLowerCase();
  if (!row || !expected || expected !== provided) {
    throw new AppError(
      "ORDER_NOT_FOUND",
      "Nomor pesanan tidak ditemukan. Periksa kembali nomor pesanan Shopee Anda.",
      404,
    );
  }

  const claimableStates = ["VALIDATED", "FULFILLED", "CLAIMED", "COMPLETED"];
  if (!claimableStates.includes(row.order.state)) {
    throw new AppError(
      "ORDER_NOT_ELIGIBLE",
      "Pesanan belum dibayar atau sudah dibatalkan, jadi belum bisa diverifikasi manual.",
      409,
    );
  }

  const [pending] = await deps.db
    .select({ id: schema.claimRequests.id })
    .from(schema.claimRequests)
    .where(
      and(
        eq(schema.claimRequests.orderId, row.order.id),
        eq(schema.claimRequests.status, "PENDING"),
      ),
    )
    .limit(1);

  if (pending) return { id: pending.id, status: "PENDING", existing: true };

  const [created] = await deps.db
    .insert(schema.claimRequests)
    .values({
      orderId: row.order.id,
      storeId: row.order.storeId,
      status: "PENDING",
      contact: input.contact.trim().slice(0, 200),
      note: input.note?.trim().slice(0, 500) ?? null,
      ip: input.ip ?? null,
      userAgent: input.userAgent?.slice(0, 300) ?? null,
    })
    .onConflictDoNothing()
    .returning({ id: schema.claimRequests.id });

  if (!created) {
    const [again] = await deps.db
      .select({ id: schema.claimRequests.id })
      .from(schema.claimRequests)
      .where(
        and(
          eq(schema.claimRequests.orderId, row.order.id),
          eq(schema.claimRequests.status, "PENDING"),
        ),
      )
      .limit(1);
    return { id: again!.id, status: "PENDING", existing: true };
  }

  await deps.db.insert(schema.orderEvents).values({
    orderId: row.order.id,
    type: "CLAIM_REQUESTED",
    payload: { requestId: created.id, contact: input.contact.slice(0, 80) },
  });

  await recordAudit(deps, {
    actorType: "BUYER",
    action: "claim_request.create",
    targetType: "claim_request",
    targetId: created.id,
    metadata: { orderSn: row.order.orderSn },
    ip: input.ip ?? null,
  });

  await notify(deps, {
    type: "manual_request.created",
    title: `Verifikasi manual diminta untuk ${row.order.orderSn}`,
    data: { orderSn: row.order.orderSn, contact: input.contact.slice(0, 80) },
  });

  return { id: created.id, status: "PENDING", existing: false };
}

export interface ClaimRequestListQuery {
  status?: "PENDING" | "APPROVED" | "REJECTED" | "EXPIRED" | undefined;
  page: number;
  pageSize: number;
}

export async function listClaimRequests(
  deps: ServiceDeps,
  query: ClaimRequestListQuery,
) {
  const where = query.status
    ? eq(schema.claimRequests.status, query.status)
    : undefined;

  const rows = await deps.db
    .select({
      request: schema.claimRequests,
      orderSn: schema.orders.orderSn,
      orderState: schema.orders.state,
      buyerUsername: schema.orders.buyerUsername,
      shopeeStatus: schema.orders.shopeeStatus,
      storeLabel: schema.shopeeStores.label,
      reviewer: schema.users.email,
    })
    .from(schema.claimRequests)
    .innerJoin(
      schema.orders,
      eq(schema.orders.id, schema.claimRequests.orderId),
    )
    .innerJoin(
      schema.shopeeStores,
      eq(schema.shopeeStores.id, schema.claimRequests.storeId),
    )
    .leftJoin(
      schema.users,
      eq(schema.users.id, schema.claimRequests.reviewedBy),
    )
    .where(where)
    .orderBy(desc(schema.claimRequests.createdAt))
    .limit(query.pageSize)
    .offset((query.page - 1) * query.pageSize);

  const [total] = await deps.db
    .select({ value: count() })
    .from(schema.claimRequests)
    .where(where);

  return {
    data: rows.map((row) => ({
      ...row.request,
      orderSn: row.orderSn,
      orderState: row.orderState,
      buyerUsername: row.buyerUsername,
      shopeeStatus: row.shopeeStatus,
      storeLabel: row.storeLabel,
      reviewer: row.reviewer,
    })),
    page: query.page,
    pageSize: query.pageSize,
    total: Number(total?.value ?? 0),
    hasMore: query.page * query.pageSize < Number(total?.value ?? 0),
  };
}

export interface ReviewInput {
  requestId: string;
  decision: "APPROVED" | "REJECTED";
  note?: string | undefined;
  hours?: number | undefined;
  actor: { id: string; email: string };
  ip?: string | null;
}

export async function reviewClaimRequest(
  deps: ServiceDeps,
  input: ReviewInput,
): Promise<{ status: string; approvedUntil: Date | null }> {
  const [request] = await deps.db
    .select()
    .from(schema.claimRequests)
    .where(eq(schema.claimRequests.id, input.requestId))
    .limit(1);
  if (!request) throw AppError.notFound("Permintaan verifikasi");
  if (request.status !== "PENDING") {
    throw AppError.conflict(
      "REQUEST_REVIEWED",
      `Permintaan ini sudah ${request.status.toLowerCase()}`,
    );
  }

  const settings = await loadSettings(deps);
  const now = nowOf(deps);
  const approvedUntil =
    input.decision === "APPROVED"
      ? new Date(
          now.getTime() +
            (input.hours ?? settings.claim.manualApprovalHours) * 3600_000,
        )
      : null;

  const [updated] = await deps.db
    .update(schema.claimRequests)
    .set({
      status: input.decision,
      reviewedBy: input.actor.id,
      reviewedAt: now,
      reviewNote: input.note?.slice(0, 500) ?? null,
      approvedUntil,
      updatedAt: now,
    })
    .where(eq(schema.claimRequests.id, request.id))
    .returning({
      status: schema.claimRequests.status,
      approvedUntil: schema.claimRequests.approvedUntil,
    });

  await deps.db.insert(schema.orderEvents).values({
    orderId: request.orderId,
    type:
      input.decision === "APPROVED"
        ? "CLAIM_MANUALLY_APPROVED"
        : "CLAIM_MANUALLY_REJECTED",
    payload: {
      requestId: request.id,
      reviewer: input.actor.email,
      note: input.note ?? null,
    },
  });

  await recordAudit(deps, {
    actorType: "ADMIN",
    actorId: input.actor.id,
    actorLabel: input.actor.email,
    action: `claim_request.${input.decision === "APPROVED" ? "approve" : "reject"}`,
    targetType: "claim_request",
    targetId: request.id,
    metadata: {
      note: input.note ?? null,
      approvedUntil: approvedUntil?.toISOString() ?? null,
    },
    ip: input.ip ?? null,
  });

  return { status: updated!.status, approvedUntil: updated!.approvedUntil };
}

/** Non-null while a manual approval still lets this order through. */
export async function findApprovedWindow(
  deps: ServiceDeps,
  orderId: string,
): Promise<Date | null> {
  const [row] = await deps.db
    .select({ approvedUntil: schema.claimRequests.approvedUntil })
    .from(schema.claimRequests)
    .where(
      and(
        eq(schema.claimRequests.orderId, orderId),
        eq(schema.claimRequests.status, "APPROVED"),
        sql`${schema.claimRequests.approvedUntil} > ${nowOf(deps).toISOString()}::timestamptz`,
      ),
    )
    .orderBy(desc(schema.claimRequests.approvedUntil))
    .limit(1);
  return row?.approvedUntil ?? null;
}

export async function pendingClaimRequestCount(
  deps: ServiceDeps,
): Promise<number> {
  const [row] = await deps.db
    .select({ value: count() })
    .from(schema.claimRequests)
    .where(eq(schema.claimRequests.status, "PENDING"));
  return Number(row?.value ?? 0);
}
