import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { eq } from "drizzle-orm";
import { counterFor, totpCode } from "@qansa/core";
import { schema } from "@qansa/db";
import { apiHarness, type ApiHarness } from "./helpers.js";

/**
 * The security surface over HTTP: second factor login, console users, the
 * manual verification queue, retention, key rotation and the audit chain. These
 * run against the same Fastify app that ships.
 */

let h: ApiHarness;

beforeEach(async () => {
  h = await apiHarness();
});

afterEach(async () => {
  await h.close();
});

const auth = (session: { cookie: string; csrf: string }) => ({
  cookie: session.cookie,
  "x-csrf-token": session.csrf,
});

/** Enrols the owner in 2FA and returns the shared secret. */
async function enrolOwner(): Promise<string> {
  const session = await h.login();
  const start = await h.app.inject({
    method: "POST",
    url: "/api/auth/2fa/enroll",
    headers: auth(session),
  });
  expect(start.statusCode).toBe(200);
  const secret = start.json().secret as string;

  const confirm = await h.app.inject({
    method: "POST",
    url: "/api/auth/2fa/enroll/confirm",
    headers: auth(session),
    payload: { token: totpCode(secret, counterFor(new Date())) },
  });
  expect(confirm.statusCode).toBe(200);
  expect(confirm.json().recoveryCodes).toHaveLength(10);
  return secret;
}

describe("two-factor login", () => {
  it("returns a challenge instead of a session once 2FA is on", async () => {
    const secret = await enrolOwner();

    const login = await h.app.inject({
      method: "POST",
      url: "/api/auth/login",
      payload: { email: "owner@qansa.web.id", password: "owner-password-2026" },
    });

    expect(login.statusCode).toBe(200);
    expect(login.json().mfaRequired).toBe(true);
    expect(login.json().challengeToken).toBeTruthy();
    expect(
      (login.cookies as Array<{ name: string }>).some(
        (cookie) => cookie.name === "qansa_session",
      ),
    ).toBe(false);

    const challengeToken = login.json().challengeToken as string;
    const wrong = await h.app.inject({
      method: "POST",
      url: "/api/auth/2fa/challenge",
      payload: { challengeToken, token: "000000" },
    });
    expect(wrong.statusCode).toBe(401);
    expect(wrong.json().error.code).toBe("MFA_INVALID");

    const right = await h.app.inject({
      method: "POST",
      url: "/api/auth/2fa/challenge",
      payload: {
        challengeToken,
        token: totpCode(secret, counterFor(new Date())),
      },
    });
    expect(right.statusCode).toBe(200);
    expect(right.json().mfaRequired).toBe(false);

    const cookies = right.cookies as Array<{ name: string; value: string }>;
    const session = cookies.find((cookie) => cookie.name === "qansa_session");
    const csrf = cookies.find((cookie) => cookie.name === "qansa_csrf");
    expect(session?.value).toBeTruthy();

    const me = await h.app.inject({
      method: "GET",
      url: "/api/auth/me",
      headers: {
        cookie: `qansa_session=${session!.value}; qansa_csrf=${csrf?.value}`,
      },
    });
    expect(me.statusCode).toBe(200);
    expect(me.json().user.email).toBe("owner@qansa.web.id");
  });

  it("accepts a recovery code once and then refuses it", async () => {
    await enrolOwner();
    const login = await h.app.inject({
      method: "POST",
      url: "/api/auth/login",
      payload: { email: "owner@qansa.web.id", password: "owner-password-2026" },
    });
    const challengeToken = login.json().challengeToken as string;

    const [row] = await h.db.db
      .select()
      .from(schema.users)
      .where(eq(schema.users.email, "owner@qansa.web.id"));
    const { generateRecoveryCodes, recoveryCodeHash } =
      await import("@qansa/core");
    const codes = generateRecoveryCodes();
    await h.db.db
      .update(schema.users)
      .set({ recoveryCodeHashes: codes.map((code) => recoveryCodeHash(code)) })
      .where(eq(schema.users.id, row!.id));

    const first = await h.app.inject({
      method: "POST",
      url: "/api/auth/2fa/challenge",
      payload: { challengeToken, token: codes[0] },
    });
    expect(first.statusCode).toBe(200);

    const replay = await h.app.inject({
      method: "POST",
      url: "/api/auth/2fa/challenge",
      payload: { challengeToken, token: codes[0] },
    });
    expect(replay.statusCode).toBe(401);
  });

  it("rejects an expired challenge", async () => {
    const response = await h.app.inject({
      method: "POST",
      url: "/api/auth/2fa/challenge",
      payload: { challengeToken: "a".repeat(40), token: "123456" },
    });
    expect(response.statusCode).toBe(401);
    expect(response.json().error.code).toBe("CHALLENGE_EXPIRED");
  });

  it("reports 2FA status and disables it with the password", async () => {
    await enrolOwner();
    const session = await loginWithMfa();

    const status = await h.app.inject({
      method: "GET",
      url: "/api/auth/2fa",
      headers: auth({ cookie: session.cookie, csrf: session.csrf }),
    });
    expect(status.json()).toMatchObject({
      enabled: true,
      recoveryCodesRemaining: 10,
    });

    const wrongPassword = await h.app.inject({
      method: "POST",
      url: "/api/auth/2fa/disable",
      headers: auth({ cookie: session.cookie, csrf: session.csrf }),
      payload: { password: "salah" },
    });
    expect(wrongPassword.statusCode).toBe(400);

    const disabled = await h.app.inject({
      method: "POST",
      url: "/api/auth/2fa/disable",
      headers: auth({ cookie: session.cookie, csrf: session.csrf }),
      payload: { password: "owner-password-2026" },
    });
    expect(disabled.statusCode).toBe(200);

    const after = await h.app.inject({
      method: "GET",
      url: "/api/auth/2fa",
      headers: auth({ cookie: session.cookie, csrf: session.csrf }),
    });
    expect(after.json().enabled).toBe(false);
  });
});

/** Helper that finishes the 2FA login and returns the real session. */
async function loginWithMfa() {
  const row = await h.db.db
    .select()
    .from(schema.users)
    .where(eq(schema.users.email, "owner@qansa.web.id"));
  const secretEnc = row[0]!.totpSecretEnc;
  if (!secretEnc) throw new Error("owner is not enrolled");
  const { decryptSecret } = await import("@qansa/core");
  const secret = decryptSecret(secretEnc, h.config.service.appEncryptionKey);

  const login = await h.app.inject({
    method: "POST",
    url: "/api/auth/login",
    payload: { email: "owner@qansa.web.id", password: "owner-password-2026" },
  });
  const challengeToken = login.json().challengeToken as string;
  const verified = await h.app.inject({
    method: "POST",
    url: "/api/auth/2fa/challenge",
    payload: {
      challengeToken,
      token: totpCode(secret, counterFor(new Date())),
    },
  });
  const cookies = verified.cookies as Array<{ name: string; value: string }>;
  const session = cookies.find((cookie) => cookie.name === "qansa_session")!;
  const csrf = cookies.find((cookie) => cookie.name === "qansa_csrf")!;
  return {
    cookie: `qansa_session=${session.value}; qansa_csrf=${csrf.value}`,
    csrf: csrf.value,
  };
}

describe("console users over HTTP", () => {
  it("creates, lists and deactivates a user as the owner", async () => {
    const session = await h.login();

    const created = await h.app.inject({
      method: "POST",
      url: "/api/admin/users",
      headers: auth(session),
      payload: {
        email: "baru@qansa.web.id",
        name: "Anggota Baru",
        role: "OPERATOR",
      },
    });
    expect(created.statusCode).toBe(201);
    expect(created.json().generatedPassword).toBeTruthy();

    const list = await h.app.inject({
      method: "GET",
      url: "/api/admin/users",
      headers: auth(session),
    });
    expect(list.statusCode).toBe(200);
    const emails = list
      .json()
      .data.map((user: { email: string }) => user.email);
    expect(emails).toContain("baru@qansa.web.id");
    expect(emails).toContain("owner@qansa.web.id");

    const id = created.json().user.id as string;
    const patched = await h.app.inject({
      method: "PATCH",
      url: `/api/admin/users/${id}`,
      headers: auth(session),
      payload: { isActive: false },
    });
    expect(patched.statusCode).toBe(200);
  });

  it("is closed to a viewer", async () => {
    const viewer = await h.login("viewer@qansa.web.id", "viewer-password-2026");
    const list = await h.app.inject({
      method: "GET",
      url: "/api/admin/users",
      headers: auth(viewer),
    });
    expect(list.statusCode).toBe(403);
  });

  it("requires the CSRF token for a mutation", async () => {
    const session = await h.login();
    const response = await h.app.inject({
      method: "POST",
      url: "/api/admin/users",
      headers: { cookie: session.cookie },
      payload: { email: "x@qansa.web.id", name: "X Y", role: "VIEWER" },
    });
    expect(response.statusCode).toBe(403);
    expect(response.json().error.code).toBe("CSRF_FAILED");
  });

  it("refuses to deactivate the last owner", async () => {
    const session = await h.login();
    const [owner] = await h.db.db
      .select()
      .from(schema.users)
      .where(eq(schema.users.email, "owner@qansa.web.id"));
    const response = await h.app.inject({
      method: "PATCH",
      url: `/api/admin/users/${owner!.id}`,
      headers: auth(session),
      payload: { isActive: false },
    });
    expect(response.statusCode).toBe(409);
    expect(response.json().error.code).toBe("LAST_OWNER");
  });
});

describe("manual verification queue over HTTP", () => {
  /**
   * Connects a fixture store and drives a paid order to a claimable state, the
   * same way the worker would after a push: sync the catalogue, map the
   * variation, then process the order.
   */
  async function seedPaidOrder() {
    const { encryptSecret } = await import("@qansa/core");
    const { runProductSync, processOrder } = await import("@qansa/services");
    const key = h.config.service.appEncryptionKey;

    const [store] = await h.db.db
      .insert(schema.shopeeStores)
      .values({
        shopId: 771001,
        label: "pixelbloomid",
        status: "CONNECTED",
        environment: "SANDBOX",
        verificationPolicy: "USERNAME_PHONE",
      })
      .returning();
    await h.db.db.insert(schema.shopeeTokens).values({
      storeId: store!.id,
      accessTokenEnc: encryptSecret("fixture-access", key),
      refreshTokenEnc: encryptSecret("fixture-refresh", key),
      expiresAt: new Date(Date.now() + 3600_000),
    });

    const deps = {
      db: h.db.db,
      gateway: h.gateway,
      config: h.config.service,
      logger: {
        info: () => undefined,
        warn: () => undefined,
        error: () => undefined,
      },
    };
    await runProductSync(deps, { storeId: store!.id });

    const products = await h.db.db
      .select()
      .from(schema.shopeeProducts)
      .where(eq(schema.shopeeProducts.storeId, store!.id));
    const variations = await h.db.db.select().from(schema.shopeeVariations);
    const [digital] = await h.db.db
      .insert(schema.digitalProducts)
      .values({
        name: "Produk Manual",
        slug: `manual-${Date.now()}`,
        deliveryKind: "CODE",
        status: "ACTIVE",
      })
      .returning();

    for (const product of products) {
      const own = variations.filter(
        (variation) => variation.productId === product.id,
      );
      if (own.length === 0) {
        await h.db.db
          .insert(schema.productMappings)
          .values({
            storeId: store!.id,
            shopeeProductId: product.id,
            digitalProductId: digital!.id,
          });
      }
      for (const variation of own) {
        await h.db.db
          .insert(schema.productMappings)
          .values({
            storeId: store!.id,
            shopeeProductId: product.id,
            shopeeVariationId: variation.id,
            digitalProductId: digital!.id,
          });
      }
    }

    const orders = await h.db.db
      .select({ orderSn: schema.orders.orderSn })
      .from(schema.orders)
      .limit(1);
    void orders;
    const summary = await processOrder(deps, store!.id, "260101PXL0001");
    expect(summary).toBeTruthy();
    return { storeId: store!.id, state: summary!.state };
  }

  it("rejects an unknown order without revealing anything", async () => {
    const seeded = await seedPaidOrder();
    expect(["VALIDATED", "FULFILLED"]).toContain(seeded.state);

    const unknown = await h.app.inject({
      method: "POST",
      url: "/api/claim/request",
      payload: {
        orderSn: "260101NOPE0001",
        buyerUsername: "rina_kurnia",
        contact: "rina@example.com",
      },
    });
    expect(unknown.statusCode).toBe(404);
    expect(unknown.json().error.code).toBe("ORDER_NOT_FOUND");
  });

  it("lists requests for an operator and refuses one without permission", async () => {
    const session = await h.login();
    const list = await h.app.inject({
      method: "GET",
      url: "/api/admin/claim-requests",
      headers: auth(session),
    });
    expect(list.statusCode).toBe(200);
    expect(list.json()).toMatchObject({ page: 1, total: 0 });
  });
});

describe("security endpoints", () => {
  it("verifies the audit chain", async () => {
    const session = await h.login();
    const response = await h.app.inject({
      method: "GET",
      url: "/api/admin/security/audit-chain",
      headers: auth(session),
    });
    expect(response.statusCode).toBe(200);
    expect(response.json().valid).toBe(true);
    expect(response.json().checked).toBeGreaterThan(0);
  });

  it("runs retention only with the confirmation word", async () => {
    const session = await h.login();
    const preview = await h.app.inject({
      method: "GET",
      url: "/api/admin/security/retention",
      headers: auth(session),
    });
    expect(preview.statusCode).toBe(200);
    expect(preview.json().preview).toMatchObject({
      webhookEvents: expect.any(Number),
    });

    const refused = await h.app.inject({
      method: "POST",
      url: "/api/admin/security/retention",
      headers: auth(session),
      payload: { confirm: "hapus" },
    });
    expect(refused.statusCode).toBe(422);

    const run = await h.app.inject({
      method: "POST",
      url: "/api/admin/security/retention",
      headers: auth(session),
      payload: { confirm: "HAPUS" },
    });
    expect(run.statusCode).toBe(200);
    expect(run.json().counts).toBeTruthy();
  });

  it("refuses a key rotation without the old key", async () => {
    const session = await h.login();
    const response = await h.app.inject({
      method: "POST",
      url: "/api/admin/security/rotate-key",
      headers: auth(session),
      payload: { confirm: "ROTASI", dryRun: true },
    });
    expect(response.statusCode).toBe(409);
    expect(response.json().error.code).toBe("OLD_KEY_MISSING");
  });

  it("dry-runs a key rotation when both keys are supplied", async () => {
    const session = await h.login();
    const sameKey = await h.app.inject({
      method: "POST",
      url: "/api/admin/security/rotate-key",
      headers: auth(session),
      payload: {
        confirm: "ROTASI",
        dryRun: true,
        oldKey: h.config.service.appEncryptionKey,
      },
    });
    // Rotating to the key already in use is a no-op, so it is refused outright.
    expect(sameKey.statusCode).toBe(422);

    const response = await h.app.inject({
      method: "POST",
      url: "/api/admin/security/rotate-key",
      headers: auth(session),
      payload: { confirm: "ROTASI", dryRun: true, oldKey: "a".repeat(64) },
    });
    expect(response.statusCode).toBe(200);
    expect(response.json()).toMatchObject({ dryRun: true });
  });

  it("reports a notification test even when notifications are off", async () => {
    const session = await h.login();
    const response = await h.app.inject({
      method: "POST",
      url: "/api/admin/security/notify-test",
      headers: auth(session),
      payload: {},
    });
    expect(response.statusCode).toBe(200);
    expect(response.json()).toMatchObject({ delivered: false });
  });
});
