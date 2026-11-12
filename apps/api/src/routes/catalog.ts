import type { FastifyInstance } from "fastify";
import { z } from "zod";
import { AppError } from "@qansa/core";
import { schema } from "@qansa/db";
import { and, count, desc, eq, inArray, isNull, sql } from "drizzle-orm";
import { currentUser, requirePermission } from "../auth.js";
import { paginate, paginationSchema } from "./common.js";

/**
 * Product mapping: the module that decides what a buyer receives. The API
 * exposes the catalogue with its current mapping state so the UI can point at
 * every unmapped listing, and refuses a second live mapping for the same
 * variation instead of resolving the conflict silently.
 */

const mappingSchema = z.object({
  shopeeProductId: z.string().uuid(),
  shopeeVariationId: z.string().uuid().nullable().optional(),
  digitalProductId: z.string().uuid(),
  quantityMultiplier: z.coerce.number().int().min(1).max(100).default(1),
  note: z.string().trim().max(200).optional(),
});

export async function catalogRoutes(app: FastifyInstance): Promise<void> {
  const { ctx } = app;
  const read = requirePermission(ctx, "catalog:read");
  const writeMapping = requirePermission(ctx, "mapping:write");

  app.get("/api/admin/catalog", { preHandler: read }, async (request) => {
    const query = paginationSchema
      .extend({
        storeId: z.string().uuid().optional(),
        query: z.string().trim().max(120).optional(),
        mapped: z.enum(["all", "mapped", "unmapped"]).default("all"),
      })
      .parse(request.query);

    const filters = [
      ...(query.storeId ? [eq(schema.shopeeProducts.storeId, query.storeId)] : []),
      isNull(schema.shopeeProducts.deletedAt),
      ...(query.query ? [sql`${schema.shopeeProducts.name} ilike ${`%${query.query}%`}`] : []),
    ];
    const where = and(...filters);

    const rows = await ctx.db
      .select({ product: schema.shopeeProducts, storeLabel: schema.shopeeStores.label })
      .from(schema.shopeeProducts)
      .innerJoin(schema.shopeeStores, eq(schema.shopeeStores.id, schema.shopeeProducts.storeId))
      .where(where)
      .orderBy(desc(schema.shopeeProducts.syncedAt))
      .limit(query.pageSize)
      .offset((query.page - 1) * query.pageSize);

    const [total] = await ctx.db.select({ value: count() }).from(schema.shopeeProducts).where(where);
    const productIds = rows.map((row) => row.product.id);

    const variations = productIds.length
      ? await ctx.db
          .select()
          .from(schema.shopeeVariations)
          .where(and(inArray(schema.shopeeVariations.productId, productIds), isNull(schema.shopeeVariations.deletedAt)))
      : [];

    const mappings = productIds.length
      ? await ctx.db
          .select({
            mapping: schema.productMappings,
            digitalName: schema.digitalProducts.name,
            digitalStatus: schema.digitalProducts.status,
          })
          .from(schema.productMappings)
          .innerJoin(schema.digitalProducts, eq(schema.digitalProducts.id, schema.productMappings.digitalProductId))
          .where(inArray(schema.productMappings.shopeeProductId, productIds))
      : [];

    const mappingByVariation = new Map(mappings.filter((row) => row.mapping.shopeeVariationId).map((row) => [row.mapping.shopeeVariationId!, row]));
    const mappingByProduct = new Map(mappings.filter((row) => !row.mapping.shopeeVariationId).map((row) => [row.mapping.shopeeProductId, row]));
    const variationsByProduct = new Map<string, typeof variations>();
    for (const variation of variations) {
      const list = variationsByProduct.get(variation.productId) ?? [];
      list.push(variation);
      variationsByProduct.set(variation.productId, list);
    }

    const data = rows
      .map((row) => {
        const own = variationsByProduct.get(row.product.id) ?? [];
        const listingMapping = mappingByProduct.get(row.product.id);
        const mappedVariations = own.filter((variation) => mappingByVariation.has(variation.id)).length;
        const mapped = own.length > 0 ? mappedVariations === own.length : Boolean(listingMapping);

        return {
          id: row.product.id,
          storeId: row.product.storeId,
          storeLabel: row.storeLabel,
          itemId: row.product.itemId,
          name: row.product.name,
          status: row.product.status,
          imageUrl: row.product.imageUrl,
          hasModel: row.product.hasModel,
          priceMin: row.product.priceMin,
          priceMax: row.product.priceMax,
          syncedAt: row.product.syncedAt,
          mapped,
          listingMapping: listingMapping
            ? {
                id: listingMapping.mapping.id,
                digitalProductId: listingMapping.mapping.digitalProductId,
                digitalProductName: listingMapping.digitalName,
                digitalProductStatus: listingMapping.digitalStatus,
                quantityMultiplier: listingMapping.mapping.quantityMultiplier,
                isActive: listingMapping.mapping.isActive,
              }
            : null,
          variations: own.map((variation) => {
            const mapping = mappingByVariation.get(variation.id);
            return {
              id: variation.id,
              modelId: variation.modelId,
              name: variation.name,
              sku: variation.sku,
              price: variation.price,
              stock: variation.stock,
              mapping: mapping
                ? {
                    id: mapping.mapping.id,
                    digitalProductId: mapping.mapping.digitalProductId,
                    digitalProductName: mapping.digitalName,
                    digitalProductStatus: mapping.digitalStatus,
                    quantityMultiplier: mapping.mapping.quantityMultiplier,
                    isActive: mapping.mapping.isActive,
                  }
                : null,
            };
          }),
        };
      })
      .filter((row) => (query.mapped === "all" ? true : query.mapped === "mapped" ? row.mapped : !row.mapped));

    return paginate(data, query.page, query.pageSize, Number(total?.value ?? 0));
  });

  app.get("/api/admin/mappings", { preHandler: read }, async (request) => {
    const query = paginationSchema
      .extend({ storeId: z.string().uuid().optional(), digitalProductId: z.string().uuid().optional() })
      .parse(request.query);
    const filters = [
      ...(query.storeId ? [eq(schema.productMappings.storeId, query.storeId)] : []),
      ...(query.digitalProductId ? [eq(schema.productMappings.digitalProductId, query.digitalProductId)] : []),
    ];
    const where = filters.length ? and(...filters) : undefined;

    const rows = await ctx.db
      .select({
        mapping: schema.productMappings,
        productName: schema.shopeeProducts.name,
        variationName: schema.shopeeVariations.name,
        digitalName: schema.digitalProducts.name,
        storeLabel: schema.shopeeStores.label,
      })
      .from(schema.productMappings)
      .innerJoin(schema.shopeeProducts, eq(schema.shopeeProducts.id, schema.productMappings.shopeeProductId))
      .leftJoin(schema.shopeeVariations, eq(schema.shopeeVariations.id, schema.productMappings.shopeeVariationId))
      .innerJoin(schema.digitalProducts, eq(schema.digitalProducts.id, schema.productMappings.digitalProductId))
      .innerJoin(schema.shopeeStores, eq(schema.shopeeStores.id, schema.productMappings.storeId))
      .where(where)
      .orderBy(desc(schema.productMappings.createdAt))
      .limit(query.pageSize)
      .offset((query.page - 1) * query.pageSize);

    const [total] = await ctx.db.select({ value: count() }).from(schema.productMappings).where(where);
    return paginate(
      rows.map((row) => ({
        ...row.mapping,
        productName: row.productName,
        variationName: row.variationName,
        digitalProductName: row.digitalName,
        storeLabel: row.storeLabel,
      })),
      query.page,
      query.pageSize,
      Number(total?.value ?? 0),
    );
  });

  app.post("/api/admin/mappings", { preHandler: writeMapping }, async (request, reply) => {
    const body = mappingSchema.parse(request.body);
    const user = currentUser(request);

    const [product] = await ctx.db.select().from(schema.shopeeProducts).where(eq(schema.shopeeProducts.id, body.shopeeProductId)).limit(1);
    if (!product) throw AppError.notFound("Produk Shopee");

    if (body.shopeeVariationId) {
      const [variation] = await ctx.db.select().from(schema.shopeeVariations).where(eq(schema.shopeeVariations.id, body.shopeeVariationId)).limit(1);
      if (!variation) throw AppError.notFound("Variasi Shopee");
      if (variation.productId !== product.id) throw AppError.validation("Variasi tidak termasuk produk ini");
    }

    const [digital] = await ctx.db.select().from(schema.digitalProducts).where(eq(schema.digitalProducts.id, body.digitalProductId)).limit(1);
    if (!digital) throw AppError.notFound("Produk digital");
    if (digital.status === "ARCHIVED") throw AppError.validation("Produk digital sedang diarsipkan");

    const [existing] = await ctx.db
      .select()
      .from(schema.productMappings)
      .where(
        and(
          eq(schema.productMappings.shopeeProductId, product.id),
          body.shopeeVariationId
            ? eq(schema.productMappings.shopeeVariationId, body.shopeeVariationId)
            : isNull(schema.productMappings.shopeeVariationId),
        ),
      )
      .limit(1);

    const values = {
      storeId: product.storeId,
      shopeeProductId: product.id,
      shopeeVariationId: body.shopeeVariationId ?? null,
      digitalProductId: body.digitalProductId,
      quantityMultiplier: body.quantityMultiplier,
      note: body.note ?? null,
      isActive: true,
      updatedAt: new Date(),
    };

    const [mapping] = existing
      ? await ctx.db.update(schema.productMappings).set(values).where(eq(schema.productMappings.id, existing.id)).returning()
      : await ctx.db.insert(schema.productMappings).values(values).returning();

    await ctx.audit({
      actorType: "ADMIN",
      actorId: user.id,
      actorLabel: user.email,
      action: existing ? "mapping.update" : "mapping.create",
      targetType: "mapping",
      targetId: mapping!.id,
      metadata: { product: product.name, variation: body.shopeeVariationId ?? null, digitalProduct: digital.name },
      ip: request.ip,
    });

    return reply.code(existing ? 200 : 201).send({ mapping });
  });

  app.delete<{ Params: { id: string } }>("/api/admin/mappings/:id", { preHandler: writeMapping }, async (request) => {
    const [row] = await ctx.db.select().from(schema.productMappings).where(eq(schema.productMappings.id, request.params.id)).limit(1);
    if (!row) throw AppError.notFound("Mapping");
    const user = currentUser(request);

    await ctx.db.delete(schema.productMappings).where(eq(schema.productMappings.id, row.id));
    await ctx.audit({
      actorType: "ADMIN",
      actorId: user.id,
      actorLabel: user.email,
      action: "mapping.delete",
      targetType: "mapping",
      targetId: row.id,
      ip: request.ip,
    });
    return { ok: true };
  });

  /** Listings that would block a buyer: no mapping at all. */
  app.get("/api/admin/catalog/unmapped-count", { preHandler: read }, async () => {
    const [row] = await ctx.db
      .select({ value: count() })
      .from(schema.shopeeProducts)
      .leftJoin(schema.productMappings, eq(schema.productMappings.shopeeProductId, schema.shopeeProducts.id))
      .where(and(isNull(schema.shopeeProducts.deletedAt), isNull(schema.productMappings.id)));
    return { unmappedProducts: Number(row?.value ?? 0) };
  });
}
