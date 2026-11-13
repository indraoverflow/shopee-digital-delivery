import type { FastifyInstance } from "fastify";
import { z } from "zod";
import { AppError, encryptSecret, maskSecret, slugify } from "@qansa/core";
import { schema } from "@qansa/db";
import { and, count, desc, eq, isNull, sql } from "drizzle-orm";
import "@fastify/multipart";
import { currentUser, requirePermission } from "../auth.js";
import { paginate, paginationSchema } from "./common.js";

/**
 * Digital products: what the buyer actually receives. Files live on a private
 * volume and codes are encrypted at rest, so this module never returns a
 * secret to the admin UI either, only labels that identify a row.
 */

const productSchema = z.object({
  name: z.string().trim().min(2).max(120),
  description: z.string().trim().max(2000).optional(),
  deliveryKind: z.enum(["FILE", "LINK", "CODE", "CREDENTIALS", "INSTRUCTIONS"]),
  instructions: z.string().trim().max(4000).optional(),
  externalUrl: z.string().url().max(500).optional(),
  status: z.enum(["DRAFT", "ACTIVE", "ARCHIVED"]).default("DRAFT"),
  /** Marks the product as minted per buyer at e-Meterai instead of stocked as codes. */
  meteraiEnabled: z.boolean().default(false),
  claimExpiryDays: z.coerce.number().int().min(1).max(365).default(30),
  maxDeliveries: z.coerce.number().int().min(1).max(50).default(3),
});

const updateSchema = productSchema.partial();

const codesSchema = z.object({
  codes: z.array(z.string().trim().min(4).max(500)).min(1).max(500),
  replace: z.coerce.boolean().default(false),
});

export async function digitalProductRoutes(
  app: FastifyInstance,
): Promise<void> {
  const { ctx } = app;
  const read = requirePermission(ctx, "product:read");
  const write = requirePermission(ctx, "product:write");

  app.get(
    "/api/admin/digital-products",
    { preHandler: read },
    async (request) => {
      const query = paginationSchema
        .extend({
          query: z.string().trim().max(120).optional(),
          status: z.enum(["DRAFT", "ACTIVE", "ARCHIVED"]).optional(),
        })
        .parse(request.query);

      const filters = [
        ...(query.status
          ? [eq(schema.digitalProducts.status, query.status)]
          : []),
        ...(query.query
          ? [sql`${schema.digitalProducts.name} ilike ${`%${query.query}%`}`]
          : []),
      ];
      const where = filters.length ? and(...filters) : undefined;

      const rows = await ctx.db
        .select()
        .from(schema.digitalProducts)
        .where(where)
        .orderBy(desc(schema.digitalProducts.createdAt))
        .limit(query.pageSize)
        .offset((query.page - 1) * query.pageSize);
      const [total] = await ctx.db
        .select({ value: count() })
        .from(schema.digitalProducts)
        .where(where);

      const ids = rows.map((row) => row.id);
      const mappingCounts = ids.length
        ? await ctx.db
            .select({
              digitalProductId: schema.productMappings.digitalProductId,
              value: count(),
            })
            .from(schema.productMappings)
            .where(sql`${schema.productMappings.digitalProductId} in ${ids}`)
            .groupBy(schema.productMappings.digitalProductId)
        : [];
      const codeCounts = ids.length
        ? await ctx.db
            .select({
              digitalProductId: schema.digitalProductCodes.digitalProductId,
              available: count(),
            })
            .from(schema.digitalProductCodes)
            .where(
              and(
                sql`${schema.digitalProductCodes.digitalProductId} in ${ids}`,
                isNull(schema.digitalProductCodes.assignedClaimId),
              ),
            )
            .groupBy(schema.digitalProductCodes.digitalProductId)
        : [];
      const assets = ids.length
        ? await ctx.db
            .select()
            .from(schema.digitalProductAssets)
            .where(
              sql`${schema.digitalProductAssets.digitalProductId} in ${ids}`,
            )
        : [];

      const mappingsByProduct = new Map(
        mappingCounts.map((row) => [row.digitalProductId, Number(row.value)]),
      );
      const codesByProduct = new Map(
        codeCounts.map((row) => [row.digitalProductId, Number(row.available)]),
      );
      const assetByProduct = new Map(
        assets.map((row) => [row.digitalProductId, row]),
      );

      return paginate(
        rows.map((row) => ({
          ...row,
          mappingCount: mappingsByProduct.get(row.id) ?? 0,
          availableCodes: codesByProduct.get(row.id) ?? 0,
          asset: assetByProduct.get(row.id)
            ? {
                fileName: assetByProduct.get(row.id)!.fileName,
                sizeBytes: assetByProduct.get(row.id)!.sizeBytes,
                mimeType: assetByProduct.get(row.id)!.mimeType,
              }
            : null,
        })),
        query.page,
        query.pageSize,
        Number(total?.value ?? 0),
      );
    },
  );

  app.post(
    "/api/admin/digital-products",
    { preHandler: write },
    async (request, reply) => {
      const body = productSchema.parse(request.body);
      const user = currentUser(request);

      if (body.deliveryKind === "LINK" && !body.externalUrl)
        throw AppError.validation("Produk bertipe LINK wajib punya tautan");
      if (body.deliveryKind === "FILE" && body.externalUrl)
        throw AppError.validation("Produk bertipe FILE tidak memakai tautan");

      let slug = slugify(body.name);
      const [clash] = await ctx.db
        .select({ id: schema.digitalProducts.id })
        .from(schema.digitalProducts)
        .where(eq(schema.digitalProducts.slug, slug))
        .limit(1);
      if (clash) slug = `${slug}-${Date.now().toString(36).slice(-4)}`;

      const [row] = await ctx.db
        .insert(schema.digitalProducts)
        .values({
          name: body.name,
          slug,
          description: body.description ?? null,
          deliveryKind: body.deliveryKind,
          instructions: body.instructions ?? null,
          externalUrl: body.externalUrl ?? null,
          status: body.status,
          meteraiEnabled: body.meteraiEnabled,
          claimExpiryDays: body.claimExpiryDays,
          maxDeliveries: body.maxDeliveries,
        })
        .returning();

      await ctx.audit({
        actorType: "ADMIN",
        actorId: user.id,
        actorLabel: user.email,
        action: "digital_product.create",
        targetType: "digital_product",
        targetId: row!.id,
        metadata: { name: body.name, deliveryKind: body.deliveryKind },
        ip: request.ip,
      });

      return reply.code(201).send({ product: row });
    },
  );

  app.get<{ Params: { id: string } }>(
    "/api/admin/digital-products/:id",
    { preHandler: read },
    async (request) => {
      const [row] = await ctx.db
        .select()
        .from(schema.digitalProducts)
        .where(eq(schema.digitalProducts.id, request.params.id))
        .limit(1);
      if (!row) throw AppError.notFound("Produk digital");

      const assets = await ctx.db
        .select()
        .from(schema.digitalProductAssets)
        .where(eq(schema.digitalProductAssets.digitalProductId, row.id));
      const mappings = await ctx.db
        .select({
          id: schema.productMappings.id,
          productName: schema.shopeeProducts.name,
          variationName: schema.shopeeVariations.name,
          storeLabel: schema.shopeeStores.label,
          quantityMultiplier: schema.productMappings.quantityMultiplier,
        })
        .from(schema.productMappings)
        .innerJoin(
          schema.shopeeProducts,
          eq(schema.shopeeProducts.id, schema.productMappings.shopeeProductId),
        )
        .leftJoin(
          schema.shopeeVariations,
          eq(
            schema.shopeeVariations.id,
            schema.productMappings.shopeeVariationId,
          ),
        )
        .innerJoin(
          schema.shopeeStores,
          eq(schema.shopeeStores.id, schema.productMappings.storeId),
        )
        .where(eq(schema.productMappings.digitalProductId, row.id));

      const [codeStats] = await ctx.db
        .select({
          total: count(),
          available: sql<number>`count(*) filter (where ${schema.digitalProductCodes.assignedClaimId} is null)`,
        })
        .from(schema.digitalProductCodes)
        .where(eq(schema.digitalProductCodes.digitalProductId, row.id));

      return {
        product: row,
        assets,
        mappings,
        codes: {
          total: Number(codeStats?.total ?? 0),
          available: Number(codeStats?.available ?? 0),
        },
      };
    },
  );

  app.patch<{ Params: { id: string } }>(
    "/api/admin/digital-products/:id",
    { preHandler: write },
    async (request) => {
      const body = updateSchema.parse(request.body);
      const user = currentUser(request);

      const [existing] = await ctx.db
        .select()
        .from(schema.digitalProducts)
        .where(eq(schema.digitalProducts.id, request.params.id))
        .limit(1);
      if (!existing) throw AppError.notFound("Produk digital");

      const nextKind = body.deliveryKind ?? existing.deliveryKind;
      const nextUrl = body.externalUrl ?? existing.externalUrl;
      if (nextKind === "LINK" && !nextUrl)
        throw AppError.validation("Produk bertipe LINK wajib punya tautan");

      const [row] = await ctx.db
        .update(schema.digitalProducts)
        .set({
          ...body,
          ...(body.status === "ARCHIVED" ? { archivedAt: new Date() } : {}),
          ...(body.status && body.status !== "ARCHIVED"
            ? { archivedAt: null }
            : {}),
          updatedAt: new Date(),
        })
        .where(eq(schema.digitalProducts.id, existing.id))
        .returning();

      await ctx.audit({
        actorType: "ADMIN",
        actorId: user.id,
        actorLabel: user.email,
        action: "digital_product.update",
        targetType: "digital_product",
        targetId: existing.id,
        metadata: body,
        ip: request.ip,
      });
      return { product: row };
    },
  );

  /** Archive, never hard delete: fulfilments and claims point at the row. */
  app.delete<{ Params: { id: string } }>(
    "/api/admin/digital-products/:id",
    { preHandler: write },
    async (request) => {
      const user = currentUser(request);
      const [row] = await ctx.db
        .update(schema.digitalProducts)
        .set({
          status: "ARCHIVED",
          archivedAt: new Date(),
          updatedAt: new Date(),
        })
        .where(eq(schema.digitalProducts.id, request.params.id))
        .returning();
      if (!row) throw AppError.notFound("Produk digital");

      await ctx.audit({
        actorType: "ADMIN",
        actorId: user.id,
        actorLabel: user.email,
        action: "digital_product.archive",
        targetType: "digital_product",
        targetId: row.id,
        ip: request.ip,
      });
      return { ok: true, product: row };
    },
  );

  app.post<{ Params: { id: string } }>(
    "/api/admin/digital-products/:id/assets",
    { preHandler: write },
    async (request) => {
      const [product] = await ctx.db
        .select()
        .from(schema.digitalProducts)
        .where(eq(schema.digitalProducts.id, request.params.id))
        .limit(1);
      if (!product) throw AppError.notFound("Produk digital");
      if (product.deliveryKind !== "FILE")
        throw AppError.validation(
          "Hanya produk bertipe FILE yang bisa punya berkas",
        );

      const upload = await request.file({
        limits: { fileSize: 50 * 1024 * 1024, files: 1 },
      });
      if (!upload) throw AppError.validation("Tidak ada berkas yang diunggah");

      const buffer = await upload.toBuffer();
      const stored = await ctx.assets.save({
        fileName: upload.filename,
        data: buffer,
      });

      // One asset per product: replacing the file removes the previous row.
      await ctx.db
        .delete(schema.digitalProductAssets)
        .where(eq(schema.digitalProductAssets.digitalProductId, product.id));
      const [asset] = await ctx.db
        .insert(schema.digitalProductAssets)
        .values({
          digitalProductId: product.id,
          storageKey: stored.storageKey,
          fileName: stored.fileName,
          mimeType: stored.mimeType,
          sizeBytes: stored.sizeBytes,
          sha256: stored.sha256,
        })
        .returning();

      await ctx.audit({
        actorType: "ADMIN",
        actorId: currentUser(request).id,
        actorLabel: currentUser(request).email,
        action: "digital_product.asset_upload",
        targetType: "digital_product",
        targetId: product.id,
        metadata: { fileName: stored.fileName, sizeBytes: stored.sizeBytes },
        ip: request.ip,
      });

      return { asset };
    },
  );

  app.post<{ Params: { id: string } }>(
    "/api/admin/digital-products/:id/codes",
    { preHandler: write },
    async (request) => {
      const body = codesSchema.parse(request.body);
      const [product] = await ctx.db
        .select()
        .from(schema.digitalProducts)
        .where(eq(schema.digitalProducts.id, request.params.id))
        .limit(1);
      if (!product) throw AppError.notFound("Produk digital");
      if (!["CODE", "CREDENTIALS"].includes(product.deliveryKind)) {
        throw AppError.validation(
          "Aktivasi kode hanya untuk produk bertipe CODE atau CREDENTIALS",
        );
      }

      if (body.replace) {
        await ctx.db
          .delete(schema.digitalProductCodes)
          .where(
            and(
              eq(schema.digitalProductCodes.digitalProductId, product.id),
              isNull(schema.digitalProductCodes.assignedClaimId),
            ),
          );
      }

      const unique = [
        ...new Set(
          body.codes.map((code) => code.trim()).filter((code) => code !== ""),
        ),
      ];
      const values = unique.map((code) => ({
        digitalProductId: product.id,
        secretEnc: encryptSecret(code, ctx.config.service.appEncryptionKey),
        label: maskSecret(code, 4),
      }));

      if (values.length > 0)
        await ctx.db.insert(schema.digitalProductCodes).values(values);

      await ctx.audit({
        actorType: "ADMIN",
        actorId: currentUser(request).id,
        actorLabel: currentUser(request).email,
        action: "digital_product.codes_added",
        targetType: "digital_product",
        targetId: product.id,
        metadata: { added: values.length, replace: body.replace },
        ip: request.ip,
      });

      return {
        added: values.length,
        skippedDuplicates: body.codes.length - values.length,
      };
    },
  );

  app.get<{ Params: { id: string } }>(
    "/api/admin/digital-products/:id/codes",
    { preHandler: read },
    async (request) => {
      const rows = await ctx.db
        .select({
          id: schema.digitalProductCodes.id,
          label: schema.digitalProductCodes.label,
          assignedClaimId: schema.digitalProductCodes.assignedClaimId,
          assignedAt: schema.digitalProductCodes.assignedAt,
          createdAt: schema.digitalProductCodes.createdAt,
        })
        .from(schema.digitalProductCodes)
        .where(
          eq(schema.digitalProductCodes.digitalProductId, request.params.id),
        )
        .orderBy(desc(schema.digitalProductCodes.createdAt))
        .limit(500);
      return { data: rows };
    },
  );

  app.delete<{ Params: { id: string; codeId: string } }>(
    "/api/admin/digital-products/:id/codes/:codeId",
    { preHandler: write },
    async (request) => {
      const [row] = await ctx.db
        .select()
        .from(schema.digitalProductCodes)
        .where(
          and(
            eq(schema.digitalProductCodes.id, request.params.codeId),
            eq(schema.digitalProductCodes.digitalProductId, request.params.id),
          ),
        )
        .limit(1);
      if (!row) throw AppError.notFound("Kode");
      if (row.assignedClaimId)
        throw AppError.conflict(
          "CODE_ASSIGNED",
          "Kode ini sudah dikirim ke pembeli dan tidak bisa dihapus",
        );

      await ctx.db
        .delete(schema.digitalProductCodes)
        .where(eq(schema.digitalProductCodes.id, row.id));
      return { ok: true };
    },
  );

  /**
   * What the buyer would see, without touching a claim: useful before the first
   * sale, and the only place that shows an operator a code sample.
   */
  app.get<{ Params: { id: string } }>(
    "/api/admin/digital-products/:id/preview",
    { preHandler: read },
    async (request) => {
      const [product] = await ctx.db
        .select()
        .from(schema.digitalProducts)
        .where(eq(schema.digitalProducts.id, request.params.id))
        .limit(1);
      if (!product) throw AppError.notFound("Produk digital");

      const [asset] = await ctx.db
        .select()
        .from(schema.digitalProductAssets)
        .where(eq(schema.digitalProductAssets.digitalProductId, product.id))
        .limit(1);
      const [code] = await ctx.db
        .select({ label: schema.digitalProductCodes.label })
        .from(schema.digitalProductCodes)
        .where(
          and(
            eq(schema.digitalProductCodes.digitalProductId, product.id),
            isNull(schema.digitalProductCodes.assignedClaimId),
          ),
        )
        .limit(1);

      return {
        product: {
          name: product.name,
          deliveryKind: product.deliveryKind,
          instructions: product.instructions,
          status: product.status,
        },
        sample:
          product.deliveryKind === "FILE"
            ? asset
              ? {
                  kind: "FILE",
                  fileName: asset.fileName,
                  sizeBytes: asset.sizeBytes,
                  note: "Tautan unduhan asli dibuat saat pembeli mengklaim.",
                }
              : { kind: "FILE", missing: "Belum ada berkas diunggah" }
            : product.deliveryKind === "LINK"
              ? { kind: "LINK", url: product.externalUrl }
              : product.deliveryKind === "INSTRUCTIONS"
                ? { kind: "INSTRUCTIONS", instructions: product.instructions }
                : {
                    kind: product.deliveryKind,
                    nextCode: code?.label ?? "Belum ada kode tersedia",
                  },
        warnings: [
          ...(product.status !== "ACTIVE"
            ? ["Produk belum ACTIVE, pembeli tidak bisa mengaksesnya"]
            : []),
          ...(product.deliveryKind === "FILE" && !asset
            ? ["Berkas belum diunggah"]
            : []),
          ...(product.deliveryKind === "LINK" && !product.externalUrl
            ? ["Tautan belum diisi"]
            : []),
          ...(["CODE", "CREDENTIALS"].includes(product.deliveryKind) && !code
            ? ["Stok kode kosong"]
            : []),
        ],
      };
    },
  );
}
