import { z } from "zod";

/** Shared query shapes, so every list endpoint paginates the same way. */
export const paginationSchema = z.object({
  page: z.coerce.number().int().min(1).default(1),
  pageSize: z.coerce.number().int().min(1).max(100).default(20),
});

export interface Paginated<T> {
  data: T[];
  page: number;
  pageSize: number;
  total: number;
  hasMore: boolean;
}

export function paginate<T>(data: T[], page: number, pageSize: number, total: number): Paginated<T> {
  return { data, page, pageSize, total, hasMore: page * pageSize < total };
}

export interface RequestMeta {
  ip: string | null;
  userAgent: string | null;
}

export function metaOf(request: { ip: string; headers: Record<string, unknown> }): RequestMeta {
  const userAgent = request.headers["user-agent"];
  return {
    ip: request.ip ?? null,
    userAgent: typeof userAgent === "string" ? userAgent : null,
  };
}
