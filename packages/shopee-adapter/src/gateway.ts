import type { ItemDetail, ModelList, OrderDetail, OrderPage, ShopInfo } from "shopee-integration";
import { ShopeeClient, ShopeeApiError, authorizationUrl, exchangeCode, getItemDetails, getItemModels, getOrderDetails, getShopInfo, listAllItems, refreshAccessToken } from "shopee-integration";
import { DEFAULT_ORDER_FIELDS } from "shopee-integration";

/**
 * The seam between the business application and Shopee.
 *
 * The transport, signing, OAuth and push verification all come from
 * `shopee-integration` (vendored at vendor/shopee-integration, pinned by
 * commit). That package stays the single place where the API contract lives;
 * this adapter only adds the pieces the delivery application needs: normalising
 * Shopee's loosely typed payloads into the shapes the pipeline reasons about,
 * and a fixture implementation so the whole application can be exercised
 * without partner credentials.
 */

export interface ShopCredentials {
  partnerId: number;
  partnerKey: string;
  /** Sandbox or production host. */
  baseUrl: string;
}

export interface StoreAccess {
  shopId: number;
  accessToken: string;
}

export interface NormalisedProduct {
  itemId: number;
  name: string;
  status: string | null;
  imageUrl: string | null;
  hasModel: boolean;
  priceMin: string | null;
  priceMax: string | null;
  raw: Record<string, unknown>;
  variations: NormalisedVariation[];
}

export interface NormalisedVariation {
  modelId: number;
  name: string;
  sku: string | null;
  price: string | null;
  stock: number | null;
  raw: Record<string, unknown>;
}

export interface NormalisedOrder {
  orderSn: string;
  status: string;
  buyerUsername: string | null;
  buyerPhoneMasked: string | null;
  totalAmount: string | null;
  currency: string | null;
  paymentMethod: string | null;
  messageToSeller: string | null;
  createTime: Date | null;
  updateTime: Date | null;
  items: NormalisedOrderItem[];
  raw: Record<string, unknown>;
}

export interface NormalisedOrderItem {
  /** `${itemId}:${modelId ?? 0}` */
  lineKey: string;
  itemId: number;
  modelId: number | null;
  itemName: string;
  variationName: string | null;
  quantity: number;
  amount: string | null;
  imageUrl: string | null;
  raw: Record<string, unknown>;
}

export interface OrderWindowQuery {
  /** Unix seconds. */
  from: number;
  to: number;
  maxPages?: number;
}

export interface ShopeeGateway {
  /** Authorization URL the seller opens once per store. */
  buildAuthorizationUrl(input: { redirectUrl: string; callbackState?: string }): string;
  exchangeCode(input: { code: string; shopId: number }): Promise<{ accessToken: string; refreshToken: string; expiresIn: number }>;
  refreshToken(input: { shopId: number; refreshToken: string }): Promise<{ accessToken: string; refreshToken: string; expiresIn: number }>;
  getShopInfo(access: StoreAccess): Promise<{ shopId: number; shopName: string | null; region: string | null; status: string | null }>;
  listOrdersByUpdateTime(access: StoreAccess, window: OrderWindowQuery): Promise<{ orderSns: string[]; truncated: boolean }>;
  getOrders(access: StoreAccess, orderSns: string[]): Promise<NormalisedOrder[]>;
  listProducts(access: StoreAccess, options?: { maxPages?: number }): Promise<{ products: NormalisedProduct[]; truncated: boolean }>;
}

/* --------------------------------------------------------- normalisation */

const toMoney = (value: unknown): string | null => {
  if (typeof value === "number" && Number.isFinite(value)) return value.toFixed(2);
  if (typeof value === "string" && value.trim() !== "" && Number.isFinite(Number(value))) return Number(value).toFixed(2);
  return null;
};

const toDate = (unixSeconds: unknown): Date | null => {
  if (typeof unixSeconds !== "number" || unixSeconds <= 0) return null;
  return new Date(unixSeconds * 1000);
};

const firstPrice = (item: ItemDetail): { min: number | null; max: number | null } => {
  const prices = (item.price_info ?? [])
    .map((entry) => entry.current_price ?? entry.original_price)
    .filter((value): value is number => typeof value === "number");
  if (prices.length === 0) return { min: null, max: null };
  return { min: Math.min(...prices), max: Math.max(...prices) };
};

export function normaliseOrder(detail: OrderDetail): NormalisedOrder {
  const address = detail.recipient_address ?? {};
  const phone = (address.phone ?? address.masked_phone ?? null) as string | null;

  const items = (detail.item_list ?? []).map((item): NormalisedOrderItem => {
    const modelId = typeof item.model_id === "number" ? item.model_id : null;
    const quantity = typeof item.model_quantity_purchased === "number" ? item.model_quantity_purchased : 1;
    const image = item.image_info?.image_url ?? null;
    return {
      lineKey: `${item.item_id}:${modelId ?? 0}`,
      itemId: item.item_id,
      modelId,
      itemName: item.item_name ?? `Item ${item.item_id}`,
      variationName: item.model_name ?? null,
      quantity,
      amount: toMoney(item.model_discounted_price),
      imageUrl: image,
      raw: item as unknown as Record<string, unknown>,
    };
  });

  return {
    orderSn: detail.order_sn,
    status: (detail.order_status ?? "").toUpperCase(),
    buyerUsername: detail.buyer_username ?? null,
    buyerPhoneMasked: phone,
    totalAmount: toMoney(detail.total_amount),
    currency: detail.currency ?? null,
    paymentMethod: detail.payment_method ?? null,
    messageToSeller: detail.message_to_seller ?? null,
    createTime: toDate(detail.create_time),
    updateTime: toDate(detail.update_time),
    items,
    raw: detail as unknown as Record<string, unknown>,
  };
}

export function normaliseProduct(item: ItemDetail, models: ModelList): NormalisedProduct {
  const price = firstPrice(item);
  const image = item.image?.image_url_list?.[0] ?? null;

  const variations = models.models.map((model): NormalisedVariation => {
    const current = model.price_info?.[0];
    const stock =
      model.stock_info_v2?.summary_info?.total_available_stock ??
      model.stock_info_v2?.seller_stock?.reduce((total, entry) => total + (entry.stock ?? 0), 0) ??
      null;
    return {
      modelId: model.model_id,
      name: model.model_name ?? `Variation ${model.model_id}`,
      sku: model.model_sku ?? null,
      price: toMoney(current?.current_price ?? current?.original_price),
      stock: typeof stock === "number" ? stock : null,
      raw: model as unknown as Record<string, unknown>,
    };
  });

  return {
    itemId: item.item_id,
    name: item.item_name ?? `Item ${item.item_id}`,
    status: item.item_status ?? null,
    imageUrl: image,
    hasModel: item.has_model ?? variations.length > 0,
    priceMin: toMoney(price.min),
    priceMax: toMoney(price.max),
    raw: item as unknown as Record<string, unknown>,
    variations,
  };
}

/* ------------------------------------------------------------ live gateway */

export interface LiveGatewayOptions extends ShopCredentials {
  /** Injectable clock and fetch, for tests and for pinning a sandbox host. */
  fetchImpl?: typeof fetch;
}

export class LiveShopeeGateway implements ShopeeGateway {
  private readonly client: ShopeeClient;

  constructor(private readonly options: LiveGatewayOptions) {
    this.client = new ShopeeClient({
      partnerId: options.partnerId,
      partnerKey: options.partnerKey,
      baseUrl: options.baseUrl,
      ...(options.fetchImpl ? { fetchImpl: options.fetchImpl } : {}),
    });
  }

  buildAuthorizationUrl(input: { redirectUrl: string }): string {
    return authorizationUrl({
      partnerId: this.options.partnerId,
      partnerKey: this.options.partnerKey,
      redirectUrl: input.redirectUrl,
      baseUrl: this.options.baseUrl,
    });
  }

  async exchangeCode(input: { code: string; shopId: number }) {
    try {
      const token = await exchangeCode(this.client, this.options.partnerId, { code: input.code, shopId: input.shopId });
      return { accessToken: token.access_token, refreshToken: token.refresh_token, expiresIn: token.expire_in };
    } catch (error) {
      throw wrapShopeeError(error);
    }
  }

  async refreshToken(input: { shopId: number; refreshToken: string }) {
    try {
      const token = await refreshAccessToken(this.client, this.options.partnerId, {
        refreshToken: input.refreshToken,
        shopId: input.shopId,
      });
      return { accessToken: token.access_token, refreshToken: token.refresh_token, expiresIn: token.expire_in };
    } catch (error) {
      throw wrapShopeeError(error);
    }
  }

  async getShopInfo(access: StoreAccess) {
    try {
      const info: ShopInfo = await getShopInfo(this.client, { accessToken: access.accessToken, shopId: access.shopId });
      return {
        shopId: typeof info.shop_id === "number" ? info.shop_id : access.shopId,
        shopName: info.shop_name ?? null,
        region: info.region ?? null,
        status: info.status ?? null,
      };
    } catch (error) {
      throw wrapShopeeError(error);
    }
  }

  async listOrdersByUpdateTime(access: StoreAccess, window: OrderWindowQuery) {
    try {
      const page: OrderPage = await listOrdersByUpdateTimeCall(this.client, {
        accessToken: access.accessToken,
        shopId: access.shopId,
        from: window.from,
        to: window.to,
        ...(window.maxPages !== undefined ? { maxPages: window.maxPages } : {}),
      });
      const orderSns = page.orders
        .map((order) => order.order_sn)
        .filter((sn): sn is string => typeof sn === "string" && sn !== "");
      return { orderSns, truncated: page.truncated };
    } catch (error) {
      throw wrapShopeeError(error);
    }
  }

  async getOrders(access: StoreAccess, orderSns: string[]): Promise<NormalisedOrder[]> {
    if (orderSns.length === 0) return [];
    try {
      const details = await getOrderDetails(this.client, { accessToken: access.accessToken, shopId: access.shopId }, orderSns, DEFAULT_ORDER_FIELDS);
      return details.map(normaliseOrder);
    } catch (error) {
      throw wrapShopeeError(error);
    }
  }

  async listProducts(access: StoreAccess, options: { maxPages?: number } = {}) {
    try {
      const catalogue = await listAllItems(this.client, { accessToken: access.accessToken, shopId: access.shopId }, {
        pageSize: 50,
        ...(options.maxPages !== undefined ? { maxPages: options.maxPages } : {}),
      });
      const itemIds = catalogue.items.map((entry) => entry.item_id);
      const details = await getItemDetails(this.client, { accessToken: access.accessToken, shopId: access.shopId }, itemIds);

      const products: NormalisedProduct[] = [];
      for (const item of details) {
        const models = await getItemModels(this.client, { accessToken: access.accessToken, shopId: access.shopId }, item.item_id);
        products.push(normaliseProduct(item, models));
      }
      return { products, truncated: catalogue.truncated };
    } catch (error) {
      throw wrapShopeeError(error);
    }
  }
}

/* Thin import aliases keep the public surface of the two modules readable. */
import { listOrdersByUpdateTime as listOrdersByUpdateTimeCall } from "shopee-integration";

/** Never let a Shopee rejection reach the caller as an opaque Error. */
export class ShopeeGatewayError extends Error {
  constructor(
    readonly code: string,
    message: string,
    readonly retryable: boolean,
  ) {
    super(message);
    this.name = "ShopeeGatewayError";
  }
}

export function wrapShopeeError(error: unknown): Error {
  if (error instanceof ShopeeApiError) {
    // 4xx-style API errors (invalid signature, expired token) are not retryable;
    // a bare network failure is.
    const retryable = /network|fetch|ECONN|ETIMEDOUT|timeout/i.test(String(error.message));
    return new ShopeeGatewayError(String(error.code), error.message, retryable);
  }
  return error instanceof Error ? error : new Error(String(error));
}

/* --------------------------------------------------------------- fixtures */

export interface FixtureStore {
  shopId: number;
  shopName: string;
  region?: string;
  status?: string;
  orders?: FixtureOrder[];
  products?: FixtureProduct[];
}

export interface FixtureOrder {
  order_sn: string;
  order_status: string;
  buyer_username?: string;
  recipient_phone?: string;
  create_time?: number;
  update_time?: number;
  total_amount?: number;
  currency?: string;
  payment_method?: string;
  items: Array<{
    item_id: number;
    model_id?: number;
    item_name: string;
    model_name?: string;
    quantity?: number;
    price?: number;
    image_url?: string;
  }>;
}

export interface FixtureProduct {
  item_id: number;
  item_name: string;
  status?: string;
  image_url?: string;
  price?: number;
  models?: Array<{ model_id: number; model_name: string; price?: number; stock?: number; sku?: string }>;
}

/**
 * An in-memory Shopee that returns the same normalised shapes as the live
 * gateway. It exists so tests and the demo compose file exercise the real
 * pipeline, and so the application can be run before partner approval without
 * pretending that a live connection happened: the UI and the API both label a
 * store connected through this gateway as a simulation.
 */
export class FixtureShopeeGateway implements ShopeeGateway {
  constructor(
    private readonly stores: FixtureStore[],
    private readonly options: { partnerId?: number; failOn?: string[] } = {},
  ) {}

  buildAuthorizationUrl(input: { redirectUrl: string }): string {
    const base = "https://openplatform.sandbox.test-stable.shopee.sg";
    const params = new URLSearchParams({
      partner_id: String(this.options.partnerId ?? 2000000),
      timestamp: String(Math.floor(Date.now() / 1000)),
      sign: "fixture-signature",
      redirect: input.redirectUrl,
    });
    return `${base}/api/v2/shop/auth_partner?${params.toString()}`;
  }

  async exchangeCode(input: { code: string; shopId: number }) {
    this.maybeFail("exchangeCode");
    if (input.code.trim() === "") throw new ShopeeGatewayError("error_param", "empty code", false);
    return {
      accessToken: `fixture-access-${input.shopId}`,
      refreshToken: `fixture-refresh-${input.shopId}`,
      expiresIn: 14_400,
    };
  }

  async refreshToken(input: { shopId: number }) {
    this.maybeFail("refreshToken");
    return {
      accessToken: `fixture-access-${input.shopId}-${Date.now()}`,
      refreshToken: `fixture-refresh-${input.shopId}-${Date.now()}`,
      expiresIn: 14_400,
    };
  }

  async getShopInfo(access: StoreAccess) {
    this.maybeFail("getShopInfo");
    const store = this.store(access.shopId);
    return {
      shopId: store.shopId,
      shopName: store.shopName,
      region: store.region ?? "ID",
      status: store.status ?? "NORMAL",
    };
  }

  async listOrdersByUpdateTime(access: StoreAccess, window: OrderWindowQuery) {
    this.maybeFail("listOrdersByUpdateTime");
    const store = this.store(access.shopId);
    const orderSns = (store.orders ?? [])
      .filter((order) => {
        const updated = order.update_time ?? 0;
        return updated >= window.from && updated <= window.to;
      })
      .map((order) => order.order_sn);
    return { orderSns, truncated: false };
  }

  async getOrders(access: StoreAccess, orderSns: string[]): Promise<NormalisedOrder[]> {
    this.maybeFail("getOrders");
    const store = this.store(access.shopId);
    return orderSns
      .map((sn) => (store.orders ?? []).find((order) => order.order_sn === sn))
      .filter((order): order is FixtureOrder => order !== undefined)
      .map((order) => ({
        orderSn: order.order_sn,
        status: order.order_status.toUpperCase(),
        buyerUsername: order.buyer_username ?? null,
        buyerPhoneMasked: order.recipient_phone ?? null,
        totalAmount: order.total_amount !== undefined ? order.total_amount.toFixed(2) : null,
        currency: order.currency ?? "IDR",
        paymentMethod: order.payment_method ?? "ShopeePay",
        messageToSeller: null,
        createTime: order.create_time ? new Date(order.create_time * 1000) : null,
        updateTime: order.update_time ? new Date(order.update_time * 1000) : null,
        items: order.items.map((item) => ({
          lineKey: `${item.item_id}:${item.model_id ?? 0}`,
          itemId: item.item_id,
          modelId: item.model_id ?? null,
          itemName: item.item_name,
          variationName: item.model_name ?? null,
          quantity: item.quantity ?? 1,
          amount: item.price !== undefined ? item.price.toFixed(2) : null,
          imageUrl: item.image_url ?? null,
          raw: item as unknown as Record<string, unknown>,
        })),
        raw: order as unknown as Record<string, unknown>,
      }));
  }

  async listProducts(access: StoreAccess) {
    this.maybeFail("listProducts");
    const store = this.store(access.shopId);
    const products: NormalisedProduct[] = (store.products ?? []).map((product) => ({
      itemId: product.item_id,
      name: product.item_name,
      status: product.status ?? "NORMAL",
      imageUrl: product.image_url ?? null,
      hasModel: (product.models ?? []).length > 0,
      priceMin: product.price !== undefined ? product.price.toFixed(2) : null,
      priceMax: product.price !== undefined ? product.price.toFixed(2) : null,
      raw: product as unknown as Record<string, unknown>,
      variations: (product.models ?? []).map((model) => ({
        modelId: model.model_id,
        name: model.model_name,
        sku: model.sku ?? null,
        price: model.price !== undefined ? model.price.toFixed(2) : null,
        stock: model.stock ?? null,
        raw: model as unknown as Record<string, unknown>,
      })),
    }));
    return { products, truncated: false };
  }

  private store(shopId: number): FixtureStore {
    const store = this.stores.find((entry) => entry.shopId === shopId);
    if (!store) throw new ShopeeGatewayError("shop_not_found", `no fixture store ${shopId}`, false);
    return store;
  }

  private maybeFail(operation: string): void {
    if (this.options.failOn?.includes(operation)) {
      throw new ShopeeGatewayError("fixture_failure", `fixture failure on ${operation}`, true);
    }
  }
}
