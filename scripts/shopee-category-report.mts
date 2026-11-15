/**
 * Category report. Shopee stores the category id on every listing but the
 * dashboard only knows "mapped" or "not mapped", so a shop with 380 listings
 * arrives as 380 problems. This prints the category name behind each id, which
 * is what turns that pile into a handful of decisions.
 *
 * Reads {"shopId": 123, "access": "<encrypted token>"} on stdin and writes
 * id|name|path lines, deepest category last.
 */
import { readFileSync } from "node:fs";
import { decryptSecret } from "../packages/core/src/crypto.ts";
import { ShopeeClient } from "../vendor/shopee-integration/src/index.ts";

const raw = readFileSync(0, "utf8").trim();
if (!raw) {
  console.error("no store given on stdin");
  process.exit(2);
}
const input = JSON.parse(raw) as { shopId: number; access: string };

const client = new ShopeeClient({
  partnerId: Number(process.env.SHOPEE_PARTNER_ID ?? ""),
  partnerKey: process.env.SHOPEE_PARTNER_KEY ?? "",
  baseUrl: process.env.SHOPEE_PROBE_BASE_URL ?? "https://partner.shopeemobile.com",
});

const auth = {
  shopId: input.shopId,
  accessToken: decryptSecret(input.access, process.env.APP_ENCRYPTION_KEY ?? ""),
};

type Node = { category_id: number; display_category_name: string; parent_category_id?: number; has_children?: boolean };

const response = await client.shopGet<{ category_list?: Node[] }>(
  "/api/v2/product/get_category",
  auth,
  { language: process.env.SHOPEE_CATEGORY_LANGUAGE ?? "id" },
);

const byId = new Map<number, Node>();
for (const node of response.category_list ?? []) byId.set(node.category_id, node);

function pathOf(node: Node): string {
  const parts: string[] = [node.display_category_name];
  let parentId = node.parent_category_id ?? 0;
  let guard = 0;
  while (parentId && guard < 10) {
    const parent = byId.get(parentId);
    if (!parent) break;
    parts.unshift(parent.display_category_name);
    parentId = parent.parent_category_id ?? 0;
    guard += 1;
  }
  return parts.join(" > ");
}

for (const node of [...byId.values()].sort((a, b) => a.category_id - b.category_id)) {
  console.log(`${node.category_id}|${node.display_category_name}|${pathOf(node)}`);
}
