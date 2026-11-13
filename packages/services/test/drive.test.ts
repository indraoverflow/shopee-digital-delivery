import { createServer, type Server } from "node:http";
import {
  afterAll,
  afterEach,
  beforeAll,
  beforeEach,
  describe,
  expect,
  it,
} from "vitest";
import { AppError } from "@qansa/core";
import { schema } from "@qansa/db";
import { eq } from "drizzle-orm";
import {
  completeDriveConnect,
  driveConnectUrl,
  driveStatus,
  extractDriveFileId,
  grantDriveAccess,
  maskEmail,
} from "../src/drive.js";
import { verifyClaim } from "../src/claims.js";
import { harness, sampleStore, type Harness } from "./helpers.js";

/**
 * Google is a server here, not a mock library: the module talks HTTP, so the test
 * answers HTTP. What matters is what leaves the machine (the permission body, the
 * notification flag) and what is written down afterwards (grants, permissions, events).
 */

const FILE_URL =
  "https://drive.google.com/file/d/FILEID_abc123/view?usp=sharing";

interface Call {
  method: string;
  url: string;
  body: string;
}

let server: Server;
let calls: Call[] = [];
let base = "";
let h: Harness;
const saved = { ...process.env };

beforeAll(async () => {
  server = createServer((request, response) => {
    let body = "";
    request.on("data", (chunk) => (body += chunk));
    request.on("end", () => {
      const url = request.url ?? "/";
      calls.push({ method: request.method ?? "GET", url, body });
      const json = (status: number, payload: unknown) => {
        response.writeHead(status, { "content-type": "application/json" });
        response.end(JSON.stringify(payload));
      };

      if (url.startsWith("/token")) {
        const form = new URLSearchParams(body);
        if (form.get("grant_type") === "authorization_code")
          return json(200, {
            access_token: "access-code",
            refresh_token: "refresh-token-1",
            scope: "https://www.googleapis.com/auth/drive",
          });
        return json(200, { access_token: "access-refreshed" });
      }
      if (url.startsWith("/oauth2/v2/userinfo"))
        return json(200, { email: "Toko@Gmail.com" });
      if (request.method === "POST" && /\/permissions/.test(url))
        return json(200, { id: `perm-${calls.length}` });
      if (request.method === "DELETE" && /\/permissions\//.test(url)) {
        response.writeHead(204);
        return response.end();
      }
      if (url.startsWith("/revoke")) return json(200, {});
      return json(404, { error: { message: "not found" } });
    });
  });

  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const address = server.address();
  base = `http://127.0.0.1:${typeof address === "object" && address ? address.port : 0}`;

  process.env.GOOGLE_OAUTH_BASE = base;
  process.env.GOOGLE_DRIVE_BASE = base;
  process.env.GOOGLE_OAUTH_CLIENT_ID = "client-id.apps.googleusercontent.com";
  process.env.GOOGLE_OAUTH_CLIENT_SECRET = "client-secret";
  process.env.GOOGLE_DRIVE_REDIRECT_URI =
    "https://api.qansa.web.id/api/admin/drive/callback";
});

afterAll(async () => {
  await new Promise<void>((resolve) => server.close(() => resolve()));
  process.env = { ...saved };
});

beforeEach(async () => {
  calls = [];
  h = await harness([sampleStore()]);
});

afterEach(async () => {
  await h.close();
});

async function seedDriveFulfillment(options: { deliveryKind?: string } = {}) {
  const [product] = await h.db.db
    .insert(schema.digitalProducts)
    .values({
      name: "Template Notion",
      slug: "template-notion",
      deliveryKind: (options.deliveryKind ?? "DRIVE") as "DRIVE",
      status: "ACTIVE",
      externalUrl: FILE_URL,
      claimExpiryDays: 30,
      maxDeliveries: 3,
    })
    .returning();

  const [order] = await h.db.db
    .insert(schema.orders)
    .values({
      storeId: h.storeId,
      orderSn: "260101DRV0001",
      state: "FULFILLED",
      shopeeStatus: "COMPLETED",
      buyerUsername: "rina_kurnia",
    })
    .returning();

  const [item] = await h.db.db
    .insert(schema.orderItems)
    .values({
      orderId: order!.id,
      lineKey: "2001:0",
      itemId: 2001,
      itemName: "Template Notion",
      quantity: 1,
      mappingStatus: "MAPPED",
    })
    .returning();

  const [fulfillment] = await h.db.db
    .insert(schema.fulfillments)
    .values({
      orderId: order!.id,
      orderItemId: item!.id,
      storeId: h.storeId,
      digitalProductId: product!.id,
      status: "CLAIMABLE",
      quantity: 1,
      claimDeadline: new Date("2026-02-01T00:00:00Z"),
    })
    .returning();

  const verified = await verifyClaim(h.deps, {
    orderSn: "260101DRV0001",
    buyerUsername: "rina_kurnia",
  });

  return {
    product: product!,
    order: order!,
    fulfillment: fulfillment!,
    token: verified.token,
  };
}

async function connectStore(): Promise<string> {
  const url = await driveConnectUrl(h.deps, h.storeId);
  const state = new URL(url).searchParams.get("state")!;
  await completeDriveConnect(h.deps, { code: "auth-code", state });
  return state;
}

describe("connecting a store to Google Drive", () => {
  it("asks for the Drive scope with an offline refresh token", async () => {
    const url = new URL(await driveConnectUrl(h.deps, h.storeId));
    expect(url.searchParams.get("access_type")).toBe("offline");
    expect(url.searchParams.get("prompt")).toBe("consent");
    expect(url.searchParams.get("scope")).toBe(
      "https://www.googleapis.com/auth/drive",
    );
    expect(url.searchParams.get("redirect_uri")).toBe(
      process.env.GOOGLE_DRIVE_REDIRECT_URI,
    );
  });

  it("stores the refresh token encrypted and reports the account, never the token", async () => {
    await connectStore();

    const status = await driveStatus(h.deps, h.storeId);
    expect(status).toMatchObject({
      connected: true,
      accountEmail: "toko@gmail.com",
    });
    expect(JSON.stringify(status)).not.toContain("refresh-token-1");

    const [row] = await h.db.db
      .select()
      .from(schema.driveCredentials)
      .where(eq(schema.driveCredentials.storeId, h.storeId));
    expect(row!.refreshTokenEnc).not.toContain("refresh-token-1");
  });

  it("refuses a state it did not sign", async () => {
    await expect(
      completeDriveConnect(h.deps, {
        code: "auth-code",
        state: "forged.state",
      }),
    ).rejects.toThrow(/kedaluwarsa/i);
  });
});

describe("sharing a Drive file with a buyer", () => {
  it("sends the invite with a notification and remembers the permission", async () => {
    await connectStore();
    const { fulfillment, token } = await seedDriveFulfillment();

    const result = await grantDriveAccess(h.deps, {
      token,
      fulfillmentId: fulfillment.id,
      email: "rina.kurnia@gmail.com",
      emailConfirm: "Rina.Kurnia@Gmail.com",
    });

    expect(result).toMatchObject({
      email: "rina.kurnia@gmail.com",
      already: false,
    });
    expect(result.maskedEmail).toBe("r***@gmail.com");

    const share = calls.find(
      (call) => call.method === "POST" && call.url.includes("/permissions"),
    )!;
    expect(share.url).toContain("sendNotificationEmail=true");
    expect(JSON.parse(share.body)).toEqual({
      type: "user",
      role: "reader",
      emailAddress: "rina.kurnia@gmail.com",
    });
    expect(share.url).toContain(encodeURIComponent("FILEID_abc123"));

    const [grant] = await h.db.db
      .select()
      .from(schema.driveGrants)
      .where(eq(schema.driveGrants.fulfillmentId, fulfillment.id));
    expect(grant).toMatchObject({
      status: "GRANTED",
      email: "rina.kurnia@gmail.com",
    });
    expect(grant!.permissionId).toBeTruthy();

    const [after] = await h.db.db
      .select()
      .from(schema.fulfillments)
      .where(eq(schema.fulfillments.id, fulfillment.id));
    expect(after!.status).toBe("CLAIMED");

    const events = await h.db.db
      .select()
      .from(schema.orderEvents)
      .where(eq(schema.orderEvents.type, "DRIVE_SHARED"));
    expect(events).toHaveLength(1);
  });

  it("refuses when the two addresses differ, before touching Google", async () => {
    await connectStore();
    const { fulfillment, token } = await seedDriveFulfillment();

    await expect(
      grantDriveAccess(h.deps, {
        token,
        fulfillmentId: fulfillment.id,
        email: "rina@gmail.com",
        emailConfirm: "rinaa@gmail.com",
      }),
    ).rejects.toThrow(/tidak sama/i);

    expect(calls.some((call) => call.url.includes("/permissions"))).toBe(false);
  });

  it("is idempotent: the same address twice creates one permission", async () => {
    await connectStore();
    const { fulfillment, token } = await seedDriveFulfillment();
    const input = {
      token,
      fulfillmentId: fulfillment.id,
      email: "rina@gmail.com",
      emailConfirm: "rina@gmail.com",
    };

    await grantDriveAccess(h.deps, input);
    const second = await grantDriveAccess(h.deps, input);

    expect(second.already).toBe(true);
    expect(
      calls.filter(
        (call) => call.method === "POST" && call.url.includes("/permissions"),
      ),
    ).toHaveLength(1);
  });

  it("fixes a typo inside the window by revoking the wrong address first", async () => {
    await connectStore();
    const { fulfillment, token } = await seedDriveFulfillment();

    await grantDriveAccess(h.deps, {
      token,
      fulfillmentId: fulfillment.id,
      email: "rina.wrong@gmail.com",
      emailConfirm: "rina.wrong@gmail.com",
    });

    h.setNow(new Date("2026-01-01T00:05:00Z"));
    const corrected = await grantDriveAccess(h.deps, {
      token,
      fulfillmentId: fulfillment.id,
      email: "rina.right@gmail.com",
      emailConfirm: "rina.right@gmail.com",
    });

    expect(corrected.already).toBe(false);
    expect(
      calls.some(
        (call) =>
          call.method === "DELETE" && call.url.includes("/permissions/"),
      ),
    ).toBe(true);

    const grants = await h.db.db
      .select()
      .from(schema.driveGrants)
      .where(eq(schema.driveGrants.fulfillmentId, fulfillment.id));
    expect(grants.map((grant) => grant.status).sort()).toEqual([
      "GRANTED",
      "REVOKED",
    ]);
    const granted = grants.find((grant) => grant.status === "GRANTED")!;
    expect(granted.correctedFrom).toBe("rina.wrong@gmail.com");
  });

  it("locks the address once the window has passed", async () => {
    await connectStore();
    const { fulfillment, token } = await seedDriveFulfillment();
    await grantDriveAccess(h.deps, {
      token,
      fulfillmentId: fulfillment.id,
      email: "rina@gmail.com",
      emailConfirm: "rina@gmail.com",
    });

    h.setNow(new Date("2026-01-01T00:20:00Z"));
    await expect(
      grantDriveAccess(h.deps, {
        token,
        fulfillmentId: fulfillment.id,
        email: "lain@gmail.com",
        emailConfirm: "lain@gmail.com",
      }),
    ).rejects.toMatchObject({ code: "ADDRESS_LOCKED" });
  });

  it("refuses a product that is not delivered through Drive", async () => {
    await connectStore();
    const { fulfillment, token } = await seedDriveFulfillment({
      deliveryKind: "LINK",
    });

    await expect(
      grantDriveAccess(h.deps, {
        token,
        fulfillmentId: fulfillment.id,
        email: "rina@gmail.com",
        emailConfirm: "rina@gmail.com",
      }),
    ).rejects.toThrow(/bukan produk Google Drive/i);
  });
});

describe("small helpers", () => {
  it("reads a file id out of the link shapes Google hands out", () => {
    expect(
      extractDriveFileId("https://drive.google.com/file/d/abcDEF123456/view"),
    ).toBe("abcDEF123456");
    expect(
      extractDriveFileId("https://drive.google.com/open?id=abcDEF123456"),
    ).toBe("abcDEF123456");
    expect(extractDriveFileId("abcDEF123456")).toBe("abcDEF123456");
    expect(extractDriveFileId("https://example.com/nothing")).toBeNull();
  });

  it("masks an address for a screen a stranger may see", () => {
    expect(maskEmail("rina.kurnia@gmail.com")).toBe("r***@gmail.com");
  });

  it("keeps the AppError code stable for the API layer", () => {
    expect(new AppError("ADDRESS_LOCKED", "x", 409).code).toBe(
      "ADDRESS_LOCKED",
    );
  });
});
