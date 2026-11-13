import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { apiHarness, type ApiHarness } from "./helpers.js";

/**
 * A PATCH that names one field must not rewrite the others. The create schema carries
 * `.default()`s, and applying it to a partial body turned a rename into "status: DRAFT,
 * meteraiEnabled: false", which silently disabled e-Meterai on a live product.
 */

let h: ApiHarness;

beforeEach(async () => {
  h = await apiHarness();
});

afterEach(async () => {
  await h.close();
});

async function asOwner(
  method: "POST" | "PATCH",
  url: string,
  payload: Record<string, unknown>,
) {
  const session = await h.login();
  const response = await h.app.inject({
    method,
    url,
    headers: { cookie: session.cookie, "x-csrf-token": session.csrf },
    payload,
  });
  return response;
}

async function createProduct() {
  const response = await asOwner("POST", "/api/admin/digital-products", {
    name: "E-Meterai 1 Lembar",
    deliveryKind: "INSTRUCTIONS",
    status: "ACTIVE",
    meteraiEnabled: true,
    claimExpiryDays: 45,
    maxDeliveries: 5,
  });
  expect(response.statusCode).toBe(201);
  return response.json().product as { id: string };
}

describe("PATCH /api/admin/digital-products/:id", () => {
  it("keeps status and the e-Meterai flag when only the name changes", async () => {
    const product = await createProduct();

    const response = await asOwner(
      "PATCH",
      `/api/admin/digital-products/${product.id}`,
      {
        name: "E-Meterai 1 Lembar (baru)",
      },
    );

    expect(response.statusCode).toBe(200);
    expect(response.json().product).toMatchObject({
      name: "E-Meterai 1 Lembar (baru)",
      status: "ACTIVE",
      meteraiEnabled: true,
      claimExpiryDays: 45,
      maxDeliveries: 5,
    });
  });

  it("turns the e-Meterai flag off without touching anything else", async () => {
    const product = await createProduct();

    const response = await asOwner(
      "PATCH",
      `/api/admin/digital-products/${product.id}`,
      {
        meteraiEnabled: false,
      },
    );

    expect(response.statusCode).toBe(200);
    expect(response.json().product).toMatchObject({
      name: "E-Meterai 1 Lembar",
      status: "ACTIVE",
      meteraiEnabled: false,
    });
  });

  it("clears an optional description when the operator empties it", async () => {
    const product = await createProduct();

    const response = await asOwner(
      "PATCH",
      `/api/admin/digital-products/${product.id}`,
      {
        description: null,
      },
    );

    expect(response.statusCode).toBe(200);
    expect(response.json().product.description).toBeNull();
  });
});
