import { afterEach, describe, expect, it } from "vitest";
import { createServer } from "node:http";
import { and, eq } from "drizzle-orm";
import {
  counterFor,
  decryptSecret,
  encryptSecret,
  hashPassword,
  totpCode,
} from "@qansa/core";
import { schema } from "@qansa/db";
import {
  beginTotpEnrollment,
  confirmTotpEnrollment,
  disableTotp,
  isTotpEnabled,
  recoveryCodesRemaining,
  regenerateRecoveryCodes,
  verifySecondFactor,
} from "../src/totp.js";
import {
  createLoginChallenge,
  findLoginChallenge,
  registerChallengeFailure,
  consumeLoginChallenge,
} from "../src/login.js";
import {
  createUser,
  isLastActiveOwner,
  listUsers,
  resetUserPassword,
  updateUser,
} from "../src/users.js";
import { runRetentionSweep } from "../src/retention.js";
import { rotateEncryptionKey } from "../src/rotation.js";
import { notify, signNotification } from "../src/notify.js";
import { FIXED_NOW, KEY, harness, type Harness } from "./helpers.js";

let h: Harness | undefined;

afterEach(async () => {
  await h?.close();
  h = undefined;
});

async function makeUser(
  email = "owner@qansa.web.id",
  role: "OWNER" | "ADMIN" | "OPERATOR" = "OWNER",
  password = "correct-horse-battery",
) {
  const [user] = await h!.db.db
    .insert(schema.users)
    .values({
      email,
      name: "Uji Coba",
      role,
      passwordHash: await hashPassword(password),
    })
    .returning();
  return user!;
}

describe("two-factor enrolment", () => {
  it("enrols, confirms with a real code, and returns recovery codes once", async () => {
    h = await harness([]);
    const user = await makeUser();

    const start = await beginTotpEnrollment(h.deps, {
      id: user.id,
      email: user.email,
    });
    expect(start.otpauth).toContain("otpauth://totp/");
    expect(start.secret).toMatch(/^[A-Z2-7]{32}$/);
    expect(await isTotpEnabled(h.deps, user.id)).toBe(false);

    const code = totpCode(start.secret, counterFor(FIXED_NOW));
    const confirmed = await confirmTotpEnrollment(
      h.deps,
      { id: user.id, email: user.email },
      code,
    );

    expect(confirmed.recoveryCodes).toHaveLength(10);
    expect(await isTotpEnabled(h.deps, user.id)).toBe(true);
    expect(await recoveryCodesRemaining(h.deps, user.id)).toBe(10);

    const [row] = await h.db.db
      .select({ secretEnc: schema.users.totpSecretEnc })
      .from(schema.users)
      .where(eq(schema.users.id, user.id));
    expect(row!.secretEnc).not.toBe(start.secret);
    expect(decryptSecret(row!.secretEnc!, KEY)).toBe(start.secret);
  });

  it("refuses to confirm with a wrong code and does not enable", async () => {
    h = await harness([]);
    const user = await makeUser();
    const start = await beginTotpEnrollment(h.deps, {
      id: user.id,
      email: user.email,
    });

    await expect(
      confirmTotpEnrollment(
        h.deps,
        { id: user.id, email: user.email },
        "000000",
      ),
    ).rejects.toMatchObject({ code: "TOTP_INVALID" });
    expect(await isTotpEnabled(h.deps, user.id)).toBe(false);
    expect(start.secret).toBeTruthy();
  });

  it("refuses to confirm before enrolment started", async () => {
    h = await harness([]);
    const user = await makeUser();
    await expect(
      confirmTotpEnrollment(
        h.deps,
        { id: user.id, email: user.email },
        "123456",
      ),
    ).rejects.toMatchObject({ code: "TOTP_NOT_STARTED" });
  });

  it("accepts an authenticator code and consumes a recovery code only once", async () => {
    h = await harness([]);
    const user = await makeUser();
    const start = await beginTotpEnrollment(h.deps, {
      id: user.id,
      email: user.email,
    });
    const { recoveryCodes } = await confirmTotpEnrollment(
      h.deps,
      { id: user.id, email: user.email },
      totpCode(start.secret, counterFor(FIXED_NOW)),
    );

    const totp = await verifySecondFactor(
      h.deps,
      { id: user.id, email: user.email },
      totpCode(start.secret, counterFor(FIXED_NOW)),
    );
    expect(totp).toEqual({ ok: true, method: "totp" });

    const recovery = await verifySecondFactor(
      h.deps,
      { id: user.id, email: user.email },
      recoveryCodes[0]!,
    );
    expect(recovery).toEqual({ ok: true, method: "recovery" });
    expect(await recoveryCodesRemaining(h.deps, user.id)).toBe(9);

    const replay = await verifySecondFactor(
      h.deps,
      { id: user.id, email: user.email },
      recoveryCodes[0]!,
    );
    expect(replay).toEqual({ ok: false, method: null });
  });

  it("regenerates recovery codes and invalidates the old ones", async () => {
    h = await harness([]);
    const user = await makeUser();
    const start = await beginTotpEnrollment(h.deps, {
      id: user.id,
      email: user.email,
    });
    const first = await confirmTotpEnrollment(
      h.deps,
      { id: user.id, email: user.email },
      totpCode(start.secret, counterFor(FIXED_NOW)),
    );

    const fresh = await regenerateRecoveryCodes(
      h.deps,
      { id: user.id, email: user.email },
      totpCode(start.secret, counterFor(FIXED_NOW)),
    );
    expect(fresh).toHaveLength(10);
    expect(fresh).not.toEqual(first.recoveryCodes);

    expect(
      (
        await verifySecondFactor(
          h.deps,
          { id: user.id, email: user.email },
          first.recoveryCodes[0]!,
        )
      ).ok,
    ).toBe(false);
    expect(
      (
        await verifySecondFactor(
          h.deps,
          { id: user.id, email: user.email },
          fresh[0]!,
        )
      ).ok,
    ).toBe(true);
  });

  it("disables 2FA and clears the secret", async () => {
    h = await harness([]);
    const user = await makeUser();
    const start = await beginTotpEnrollment(h.deps, {
      id: user.id,
      email: user.email,
    });
    await confirmTotpEnrollment(
      h.deps,
      { id: user.id, email: user.email },
      totpCode(start.secret, counterFor(FIXED_NOW)),
    );

    await disableTotp(h.deps, { id: user.id, email: user.email });
    expect(await isTotpEnabled(h.deps, user.id)).toBe(false);

    const [row] = await h.db.db
      .select({
        secretEnc: schema.users.totpSecretEnc,
        hashes: schema.users.recoveryCodeHashes,
      })
      .from(schema.users)
      .where(eq(schema.users.id, user.id));
    expect(row!.secretEnc).toBeNull();
    expect(row!.hashes).toBeNull();
  });

  it("records both enrolment and disable in the audit chain", async () => {
    h = await harness([]);
    const user = await makeUser();
    const start = await beginTotpEnrollment(h.deps, {
      id: user.id,
      email: user.email,
    });
    await confirmTotpEnrollment(
      h.deps,
      { id: user.id, email: user.email },
      totpCode(start.secret, counterFor(FIXED_NOW)),
    );
    await disableTotp(h.deps, { id: user.id, email: user.email });

    const actions = (
      await h.db.db
        .select({ action: schema.auditLogs.action })
        .from(schema.auditLogs)
    ).map((row) => row.action);
    expect(actions).toContain("auth.totp_enabled");
    expect(actions).toContain("auth.totp_disabled");
  });
});

describe("login challenges", () => {
  it("issues a single-use challenge that can be found and consumed", async () => {
    h = await harness([]);
    const user = await makeUser();

    const challenge = await createLoginChallenge(h.deps, {
      userId: user.id,
      ip: "10.0.0.1",
    });
    const found = await findLoginChallenge(h.deps, challenge.token);
    expect(found?.userId).toBe(user.id);

    await consumeLoginChallenge(h.deps, found!.id);
    expect(await findLoginChallenge(h.deps, challenge.token)).toBeNull();
  });

  it("rejects an unknown or blank token", async () => {
    h = await harness([]);
    expect(await findLoginChallenge(h.deps, "not-a-token")).toBeNull();
    expect(await findLoginChallenge(h.deps, "")).toBeNull();
  });

  it("burns the challenge after five wrong codes", async () => {
    h = await harness([]);
    const user = await makeUser();
    const challenge = await createLoginChallenge(h.deps, { userId: user.id });
    const found = await findLoginChallenge(h.deps, challenge.token);

    for (let attempt = 1; attempt <= 4; attempt += 1) {
      expect(await registerChallengeFailure(h.deps, found!.id)).toEqual({
        attempts: attempt,
        burned: false,
      });
    }
    expect(await registerChallengeFailure(h.deps, found!.id)).toEqual({
      attempts: 5,
      burned: true,
    });
    expect(await findLoginChallenge(h.deps, challenge.token)).toBeNull();
  });

  it("expires after the ttl", async () => {
    h = await harness([]);
    const user = await makeUser();
    const challenge = await createLoginChallenge(h.deps, { userId: user.id });
    h.setNow(new Date(FIXED_NOW.getTime() + 6 * 60_000));
    expect(await findLoginChallenge(h.deps, challenge.token)).toBeNull();
  });
});

describe("console users", () => {
  it("creates a user with a generated password that is returned once", async () => {
    h = await harness([]);
    const actorUser = await makeUser();
    const actor = {
      id: actorUser.id,
      email: actorUser.email,
      role: "OWNER" as const,
    };

    const created = await createUser(h.deps, {
      email: "Operator@Qansa.web.id",
      name: "Operator Satu",
      role: "OPERATOR",
      actor,
    });
    expect(created.user.email).toBe("operator@qansa.web.id");
    expect(created.generatedPassword).toMatch(/^[A-Za-z0-9_-]{20,}$/);

    const all = await listUsers(h.deps);
    expect(all).toHaveLength(2);
  });

  it("rejects a duplicate email regardless of case", async () => {
    h = await harness([]);
    const actorUser = await makeUser("owner@qansa.web.id");
    const actor = {
      id: actorUser.id,
      email: actorUser.email,
      role: "OWNER" as const,
    };
    await expect(
      createUser(h.deps, {
        email: "OWNER@qansa.web.id",
        name: "Lain",
        role: "VIEWER",
        actor,
      }),
    ).rejects.toMatchObject({ code: "USER_EXISTS" });
  });

  it("refuses to create an owner unless the actor is one", async () => {
    h = await harness([]);
    const adminUser = await makeUser("admin@qansa.web.id", "ADMIN");
    await expect(
      createUser(h.deps, {
        email: "boss@qansa.web.id",
        name: "Boss",
        role: "OWNER",
        actor: { id: adminUser.id, email: adminUser.email, role: "ADMIN" },
      }),
    ).rejects.toMatchObject({ code: "FORBIDDEN" });
  });

  it("protects the last active owner from demotion and deactivation", async () => {
    h = await harness([]);
    const ownerUser = await makeUser("owner@qansa.web.id", "OWNER");
    const actor = {
      id: ownerUser.id,
      email: ownerUser.email,
      role: "OWNER" as const,
    };

    expect(await isLastActiveOwner(h.deps, ownerUser.id)).toBe(true);
    await expect(
      updateUser(h.deps, ownerUser.id, { role: "ADMIN", actor }),
    ).rejects.toMatchObject({ code: "LAST_OWNER" });
    await expect(
      updateUser(h.deps, ownerUser.id, { isActive: false, actor }),
    ).rejects.toMatchObject({ code: "LAST_OWNER" });

    const second = await makeUser("owner2@qansa.web.id", "OWNER");
    expect(await isLastActiveOwner(h.deps, ownerUser.id)).toBe(false);
    await updateUser(h.deps, ownerUser.id, { role: "ADMIN", actor });
    const [row] = await h.db.db
      .select({ role: schema.users.role })
      .from(schema.users)
      .where(eq(schema.users.id, second.id));
    expect(row!.role).toBe("OWNER");
  });

  it("revokes every session when a user is deactivated", async () => {
    h = await harness([]);
    const ownerUser = await makeUser("owner@qansa.web.id", "OWNER");
    const target = await makeUser("ops@qansa.web.id", "OPERATOR");
    await h.db.db.insert(schema.sessions).values({
      userId: target.id,
      tokenHash: "hash-1",
      expiresAt: new Date(FIXED_NOW.getTime() + 3600_000),
    });

    await updateUser(h.deps, target.id, {
      isActive: false,
      actor: { id: ownerUser.id, email: ownerUser.email, role: "OWNER" },
    });

    const [session] = await h.db.db
      .select({ revokedAt: schema.sessions.revokedAt })
      .from(schema.sessions)
      .where(eq(schema.sessions.userId, target.id));
    expect(session!.revokedAt).toBeInstanceOf(Date);
  });

  it("resets a password, revokes sessions and audits it", async () => {
    h = await harness([]);
    const ownerUser = await makeUser("owner@qansa.web.id", "OWNER");
    const target = await makeUser("ops@qansa.web.id", "OPERATOR");
    await h.db.db.insert(schema.sessions).values({
      userId: target.id,
      tokenHash: "hash-2",
      expiresAt: new Date(FIXED_NOW.getTime() + 3600_000),
    });

    const result = await resetUserPassword(h.deps, target.id, {
      id: ownerUser.id,
      email: ownerUser.email,
      role: "OWNER",
    });
    expect(result.generatedPassword).toBeTruthy();

    const [session] = await h.db.db
      .select({ revokedAt: schema.sessions.revokedAt })
      .from(schema.sessions)
      .where(
        and(
          eq(schema.sessions.userId, target.id),
          eq(schema.sessions.tokenHash, "hash-2"),
        ),
      );
    expect(session!.revokedAt).toBeInstanceOf(Date);

    const actions = (
      await h.db.db
        .select({ action: schema.auditLogs.action })
        .from(schema.auditLogs)
    ).map((row) => row.action);
    expect(actions).toContain("user.password_reset");
  });
});

describe("retention sweep", () => {
  it("deletes only rows past their window", async () => {
    h = await harness([]);
    const user = await makeUser();
    const old = new Date(FIXED_NOW.getTime() - 200 * 24 * 3600_000);
    const recent = new Date(FIXED_NOW.getTime() - 1 * 24 * 3600_000);

    await h.db.db.insert(schema.webhookEvents).values([
      {
        bodyHash: "old-hash",
        signatureValid: true,
        payload: {},
        receivedAt: old,
      },
      {
        bodyHash: "new-hash",
        signatureValid: true,
        payload: {},
        receivedAt: recent,
      },
    ]);
    await h.db.db.insert(schema.jobs).values([
      {
        type: "SYNC_ORDERS",
        payload: {},
        status: "SUCCEEDED",
        runAt: old,
        completedAt: old,
      },
      {
        type: "SYNC_ORDERS",
        payload: {},
        status: "SUCCEEDED",
        runAt: recent,
        completedAt: recent,
      },
      {
        type: "SYNC_ORDERS",
        payload: {},
        status: "DEAD",
        runAt: old,
        completedAt: old,
      },
    ]);
    await h.db.db.insert(schema.sessions).values([
      { userId: user.id, tokenHash: "old-session", expiresAt: old },
      {
        userId: user.id,
        tokenHash: "live-session",
        expiresAt: new Date(FIXED_NOW.getTime() + 3600_000),
      },
    ]);

    const counts = await runRetentionSweep(h.deps);

    expect(counts.webhookEvents).toBe(1);
    expect(counts.jobs).toBe(1);
    expect(counts.sessions).toBe(1);

    const webhooks = await h.db.db
      .select({ bodyHash: schema.webhookEvents.bodyHash })
      .from(schema.webhookEvents);
    expect(webhooks.map((row) => row.bodyHash)).toEqual(["new-hash"]);

    const jobs = await h.db.db
      .select({ status: schema.jobs.status })
      .from(schema.jobs);
    // The dead letter stays: it is the only evidence of the failure.
    expect(jobs).toHaveLength(2);
    expect(jobs.some((job) => job.status === "DEAD")).toBe(true);
  });

  it("expires stale pending manual requests", async () => {
    h = await harness([]);
    const [store] = await h.db.db
      .insert(schema.shopeeStores)
      .values({
        shopId: 999,
        label: "t",
        status: "CONNECTED",
        environment: "SANDBOX",
      })
      .returning();
    const [order] = await h.db.db
      .insert(schema.orders)
      .values({
        storeId: store!.id,
        orderSn: "260101OLD0001",
        shopeeStatus: "READY_TO_SHIP",
        state: "VALIDATED",
        buyerUsername: "lama",
        currency: "IDR",
        totalAmount: "1000",
      })
      .returning();

    await h.db.db.insert(schema.claimRequests).values({
      orderId: order!.id,
      storeId: store!.id,
      contact: "buyer@example.com",
      status: "PENDING",
      createdAt: new Date(FIXED_NOW.getTime() - 30 * 24 * 3600_000),
    });

    const counts = await runRetentionSweep(h.deps);
    expect(counts.expiredClaimRequests).toBe(1);

    const [row] = await h.db.db
      .select({ status: schema.claimRequests.status })
      .from(schema.claimRequests);
    expect(row!.status).toBe("EXPIRED");
  });
});

describe("key rotation", () => {
  it("re-encrypts store tokens and activation codes under the new key", async () => {
    h = await harness([]);
    const newKey = "c".repeat(64);

    const [product] = await h.db.db
      .insert(schema.digitalProducts)
      .values({
        name: "Rotasi",
        slug: "rotasi",
        deliveryKind: "CODE",
        status: "ACTIVE",
      })
      .returning();
    await h.db.db.insert(schema.digitalProductCodes).values({
      digitalProductId: product!.id,
      secretEnc: encryptSecret("CODE-ROTATE-1", KEY),
      label: "****TE-1",
    });

    const result = await rotateEncryptionKey(h.deps, { oldKey: KEY, newKey });
    expect(result.shopeeTokens).toBe(1);
    expect(result.activationCodes).toBe(1);

    const [code] = await h.db.db
      .select({ secretEnc: schema.digitalProductCodes.secretEnc })
      .from(schema.digitalProductCodes);
    expect(decryptSecret(code!.secretEnc, newKey)).toBe("CODE-ROTATE-1");
    expect(() => decryptSecret(code!.secretEnc, KEY)).toThrow();

    const [token] = await h.db.db
      .select({ accessTokenEnc: schema.shopeeTokens.accessTokenEnc })
      .from(schema.shopeeTokens);
    expect(decryptSecret(token!.accessTokenEnc, newKey)).toBe("fixture-access");
  });

  it("rolls everything back on a dry run", async () => {
    h = await harness([]);
    const newKey = "d".repeat(64);

    const result = await rotateEncryptionKey(h.deps, {
      oldKey: KEY,
      newKey,
      dryRun: true,
    });
    expect(result.dryRun).toBe(true);
    expect(result.shopeeTokens).toBe(1);

    const [token] = await h.db.db
      .select({ accessTokenEnc: schema.shopeeTokens.accessTokenEnc })
      .from(schema.shopeeTokens);
    expect(decryptSecret(token!.accessTokenEnc, KEY)).toBe("fixture-access");
  });

  it("rejects the same key twice and malformed keys", async () => {
    h = await harness([]);
    await expect(
      rotateEncryptionKey(h.deps, { oldKey: KEY, newKey: KEY }),
    ).rejects.toMatchObject({ code: "VALIDATION_ERROR" });
    await expect(
      rotateEncryptionKey(h.deps, { oldKey: KEY, newKey: "short" }),
    ).rejects.toMatchObject({ code: "VALIDATION_ERROR" });
  });
});

describe("notifications", () => {
  async function withWebhook(
    handler: (
      body: string,
      headers: Record<string, string | string[] | undefined>,
    ) => { status: number },
  ) {
    const received: Array<{
      body: string;
      headers: Record<string, string | string[] | undefined>;
    }> = [];
    const server = createServer((request, response) => {
      let body = "";
      request.on("data", (chunk) => (body += chunk));
      request.on("end", () => {
        received.push({ body, headers: request.headers });
        const result = handler(body, request.headers);
        response.writeHead(result.status).end("{}");
      });
    });
    await new Promise<void>((resolve) =>
      server.listen(0, "127.0.0.1", resolve),
    );
    const address = server.address();
    const port = typeof address === "object" && address ? address.port : 0;
    return {
      received,
      url: `http://127.0.0.1:${port}/hook`,
      close: () =>
        new Promise<void>((resolve) => server.close(() => resolve())),
    };
  }

  async function configure(h: Harness, value: Record<string, unknown>) {
    await h.db.db
      .insert(schema.systemSettings)
      .values({ key: "notify", value })
      .onConflictDoUpdate({
        target: schema.systemSettings.key,
        set: { value, updatedAt: new Date() },
      });
  }

  it("posts a signed payload when enabled", async () => {
    h = await harness([]);
    const hook = await withWebhook(() => ({ status: 200 }));
    try {
      await configure(h, {
        enabled: true,
        webhookUrl: hook.url,
        secret: "s3cr3t",
        events: ["claim.completed"],
      });
      const result = await notify(h.deps, {
        type: "claim.completed",
        title: "Uji",
        data: { orderSn: "260101TEST0001" },
      });

      expect(result.delivered).toBe(true);
      expect(hook.received).toHaveLength(1);
      const [entry] = hook.received;
      expect(entry!.headers["x-qansa-signature"]).toBe(
        signNotification("s3cr3t", entry!.body),
      );
      expect(JSON.parse(entry!.body)).toMatchObject({
        type: "claim.completed",
        source: "qansa-delivery",
      });
    } finally {
      await hook.close();
    }
  });

  it("stays quiet when disabled, unset, or filtered", async () => {
    h = await harness([]);
    const hook = await withWebhook(() => ({ status: 200 }));
    try {
      expect(
        await notify(h.deps, { type: "claim.completed", title: "x", data: {} }),
      ).toEqual({ delivered: false, reason: "disabled" });

      await configure(h, {
        enabled: true,
        webhookUrl: null,
        secret: null,
        events: [],
      });
      expect(
        await notify(h.deps, { type: "claim.completed", title: "x", data: {} }),
      ).toEqual({ delivered: false, reason: "no_url" });

      await configure(h, {
        enabled: true,
        webhookUrl: hook.url,
        secret: null,
        events: ["claim.revoked"],
      });
      expect(
        await notify(h.deps, { type: "claim.completed", title: "x", data: {} }),
      ).toEqual({ delivered: false, reason: "filtered" });
      expect(hook.received).toHaveLength(0);
    } finally {
      await hook.close();
    }
  });

  it("reports a rejected webhook without throwing", async () => {
    h = await harness([]);
    const hook = await withWebhook(() => ({ status: 500 }));
    try {
      await configure(h, {
        enabled: true,
        webhookUrl: hook.url,
        secret: null,
        events: [],
      });
      expect(
        await notify(h.deps, { type: "sync.failed", title: "Gagal", data: {} }),
      ).toMatchObject({ delivered: false, reason: "http_error", status: 500 });
    } finally {
      await hook.close();
    }
  });

  it("never throws when the endpoint is unreachable", async () => {
    h = await harness([]);
    await configure(h, {
      enabled: true,
      webhookUrl: "http://127.0.0.1:9/hook",
      secret: null,
      events: [],
    });
    expect(
      await notify(h.deps, { type: "claim.completed", title: "x", data: {} }),
    ).toMatchObject({ delivered: false, reason: "exception" });
  });
});
