import { createServer, type Server } from "node:http";
import { afterAll, afterEach, beforeAll, describe, expect, it } from "vitest";
import { eq } from "drizzle-orm";
import { encryptSecret } from "@qansa/core";
import { schema } from "@qansa/db";
import { accessDelivery, verifyClaim } from "../src/claims.js";
import {
  decryptMeteraiPayload,
  encryptMeteraiPayload,
  mintFulfillmentLink,
} from "../src/meterai.js";
import { processOrder } from "../src/orders.js";
import { runProductSync } from "../src/sync.js";
import {
  KEY,
  createDigitalProduct,
  harness,
  mapVariation,
  sampleStore,
  type Harness,
} from "./helpers.js";

/**
 * e-Meterai mints a link per buyer and each mint costs money, so these tests are about
 * the money as much as the flow: mint once, never twice, never after a refusal, and the
 * buyer gets that one link and nothing else.
 */

let server: Server;
let baseUrl = "";
let mintCalls = 0;
let loginMode: "ok" | "refuse" = "ok";

beforeAll(async () => {
  server = createServer((request, response) => {
    const url = new URL(request.url ?? "/", "http://127.0.0.1");
    const send = (status: number, body: unknown) => {
      response.writeHead(status, { "content-type": "application/json" });
      response.end(JSON.stringify(body));
    };

    if (url.pathname === "/api/users/login") {
      let raw = "";
      request.on("data", (chunk) => (raw += chunk));
      request.on("end", () => {
        if (loginMode === "refuse")
          return send(200, { statusCode: "09", message: "Login Failed" });
        const { data } = JSON.parse(raw) as { data: string };
        const inside = decryptMeteraiPayload(data) as {
          user: string;
          password: string;
        };
        if (
          inside.user !== "meterai@qansa.web.id" ||
          inside.password !== "secret-pass"
        ) {
          return send(200, { statusCode: "09", message: "Login Failed" });
        }
        send(200, {
          statusCode: "00",
          message: "success",
          token: "token-1",
          result: encryptMeteraiPayload(
            { result: { data: { login: { token: "token-1" } } } },
            { randomIv: true },
          ),
        });
      });
      return;
    }

    if (url.pathname === "/api/function/saldopos")
      return send(200, { result: { status: "00", saldo: 484, notstamp: 0 } });

    if (url.pathname === "/api/v3/reseller/generate-link") {
      mintCalls += 1;
      const inside = decryptMeteraiPayload(
        url.searchParams.get("data") ?? "",
      ) as { qty: number; fullpath: boolean };
      if (!inside.fullpath || inside.qty < 1)
        return send(200, { status: "99", message: "bad payload" });
      return send(200, {
        status: "00",
        message: "success",
        result: {
          message: `success generate link reseller sebanyak ${inside.qty}`,
          linkUrl: [`${baseUrl}/pdfViewer?refid=REF${mintCalls}`],
        },
      });
    }

    send(404, { message: "not found" });
  });

  await new Promise<void>((resolve) =>
    server.listen(0, "127.0.0.1", () => resolve()),
  );
  const address = server.address();
  baseUrl = `http://127.0.0.1:${typeof address === "object" && address ? address.port : 0}`;
});

afterAll(async () => {
  await new Promise<void>((resolve) => server.close(() => resolve()));
});

let h: Harness | undefined;
afterEach(async () => {
  await h?.close();
  h = undefined;
  mintCalls = 0;
  loginMode = "ok";
});

async function meteraiFulfilment(options: { enabled?: boolean } = {}) {
  h = await harness([sampleStore()]);
  await runProductSync(h.deps, { storeId: h.storeId });

  const digital = await createDigitalProduct(h, {
    name: "E-Meterai 10.000",
    kind: "INSTRUCTIONS",
  });
  await h.db.db
    .update(schema.digitalProducts)
    .set({ meteraiEnabled: options.enabled ?? true })
    .where(eq(schema.digitalProducts.id, digital.id));
  await mapVariation(h, {
    itemId: 101,
    modelId: 1002,
    digitalProductId: digital.id,
  });

  await h.db.db.insert(schema.systemSettings).values({
    key: "meterai",
    value: {
      enabled: true,
      user: "meterai@qansa.web.id",
      passwordEnc: encryptSecret("secret-pass", KEY),
      baseUrl,
    },
  });

  await processOrder(h.deps, h.storeId, "260101TEST0001");
  const [fulfillment] = await h.db.db.select().from(schema.fulfillments);
  return fulfillment!;
}

describe("minting an e-Meterai link", () => {
  it("stores one link for the buyer and records who spent it", async () => {
    const fulfillment = await meteraiFulfilment();

    const result = await mintFulfillmentLink(h!.deps, {
      fulfillmentId: fulfillment.id,
      actor: {
        id: "11111111-1111-1111-1111-111111111111",
        email: "ops@qansa.web.id",
      },
    });

    expect(result.alreadyMinted).toBe(false);
    expect(result.url).toBe(`${baseUrl}/pdfViewer?refid=REF1`);
    expect(mintCalls).toBe(1);

    const [stored] = await h!.db.db
      .select()
      .from(schema.fulfillments)
      .where(eq(schema.fulfillments.id, fulfillment.id));
    expect(stored!.mintedSecretEnc).toBeTruthy();
    expect(stored!.mintedSecretEnc).not.toContain("pdfViewer"); // encrypted at rest

    const events = await h!.db.db
      .select()
      .from(schema.orderEvents)
      .where(eq(schema.orderEvents.orderId, fulfillment.orderId));
    expect(events.map((event) => event.type)).toContain("METERAI_LINK_MINTED");

    const audit = await h!.db.db
      .select()
      .from(schema.auditLogs)
      .where(eq(schema.auditLogs.action, "meterai.mint"));
    expect(audit).toHaveLength(1);
  });

  it("never spends a second time on a retry", async () => {
    const fulfillment = await meteraiFulfilment();
    const actor = {
      id: "11111111-1111-1111-1111-111111111111",
      email: "ops@qansa.web.id",
    };

    const first = await mintFulfillmentLink(h!.deps, {
      fulfillmentId: fulfillment.id,
      actor,
    });
    const second = await mintFulfillmentLink(h!.deps, {
      fulfillmentId: fulfillment.id,
      actor,
    });

    expect(second.alreadyMinted).toBe(true);
    expect(second.url).toBe(first.url);
    expect(mintCalls).toBe(1);
  });

  it("refuses without touching the supplier when the account is not configured", async () => {
    const fulfillment = await meteraiFulfilment();
    await h!.db.db
      .update(schema.systemSettings)
      .set({ value: { enabled: false, user: "", passwordEnc: null, baseUrl } })
      .where(eq(schema.systemSettings.key, "meterai"));

    await expect(
      mintFulfillmentLink(h!.deps, {
        fulfillmentId: fulfillment.id,
        actor: { id: "1", email: "ops@qansa.web.id" },
      }),
    ).rejects.toMatchObject({ code: "METERAI_DISABLED" });
    expect(mintCalls).toBe(0);
  });

  it("surfaces a refused login and stores nothing", async () => {
    const fulfillment = await meteraiFulfilment();
    loginMode = "refuse";

    await expect(
      mintFulfillmentLink(h!.deps, {
        fulfillmentId: fulfillment.id,
        actor: { id: "1", email: "ops@qansa.web.id" },
      }),
    ).rejects.toMatchObject({ code: "METERAI_LOGIN_FAILED" });

    const [stored] = await h!.db.db
      .select()
      .from(schema.fulfillments)
      .where(eq(schema.fulfillments.id, fulfillment.id));
    expect(stored!.mintedSecretEnc).toBeNull();
    expect(mintCalls).toBe(0);
  });

  it("refuses a product that is not an e-Meterai product", async () => {
    const fulfillment = await meteraiFulfilment({ enabled: false });

    await expect(
      mintFulfillmentLink(h!.deps, {
        fulfillmentId: fulfillment.id,
        actor: { id: "1", email: "ops@qansa.web.id" },
      }),
    ).rejects.toMatchObject({ code: "VALIDATION_ERROR" });
    expect(mintCalls).toBe(0);
  });
});

describe("delivering a minted link", () => {
  it("hands the buyer the minted link, not a pooled code", async () => {
    const fulfillment = await meteraiFulfilment();
    await mintFulfillmentLink(h!.deps, {
      fulfillmentId: fulfillment.id,
      actor: {
        id: "11111111-1111-1111-1111-111111111111",
        email: "ops@qansa.web.id",
      },
    });

    const verified = await verifyClaim(h!.deps, {
      orderSn: "260101TEST0001",
      buyerUsername: "rina_kurnia",
    });
    const payload = await accessDelivery(h!.deps, {
      token: verified.token,
      fulfillmentId: fulfillment.id,
    });

    expect(payload).toMatchObject({
      kind: "LINK",
      url: `${baseUrl}/pdfViewer?refid=REF1`,
    });
  });

  it("tells the buyer support will follow up when no link was minted yet", async () => {
    const fulfillment = await meteraiFulfilment();
    const verified = await verifyClaim(h!.deps, {
      orderSn: "260101TEST0001",
      buyerUsername: "rina_kurnia",
    });

    await expect(
      accessDelivery(h!.deps, {
        token: verified.token,
        fulfillmentId: fulfillment.id,
      }),
    ).rejects.toMatchObject({
      code: "OUT_OF_STOCK",
    });
  });
});
