/**
 * Role-based access control. Permissions live in code rather than the database
 * so a role edit cannot leave a stale grant behind, and so the full set is
 * visible in one place during review.
 */

export const PERMISSIONS = [
  "overview:read",
  "store:read",
  "store:write",
  "catalog:read",
  "product:read",
  "product:write",
  "mapping:write",
  "order:read",
  "claim:read",
  "claim:write",
  "monitoring:read",
  "audit:read",
  "settings:write",
  "user:write",
] as const;

export type Permission = (typeof PERMISSIONS)[number];
export type Role = "OWNER" | "ADMIN" | "OPERATOR" | "VIEWER";

const ROLE_PERMISSIONS: Record<Role, readonly Permission[]> = {
  OWNER: PERMISSIONS,
  ADMIN: [
    "overview:read",
    "store:read",
    "store:write",
    "catalog:read",
    "product:read",
    "product:write",
    "mapping:write",
    "order:read",
    "claim:read",
    "claim:write",
    "monitoring:read",
    "audit:read",
  ],
  // Operators run the day: they map products and help buyers, they do not
  // connect stores or change security settings.
  OPERATOR: ["overview:read", "store:read", "catalog:read", "product:read", "mapping:write", "order:read", "claim:read", "claim:write", "monitoring:read"],
  VIEWER: ["overview:read", "store:read", "catalog:read", "product:read", "order:read", "claim:read", "monitoring:read"],
};

export function permissionsFor(role: Role): readonly Permission[] {
  return ROLE_PERMISSIONS[role] ?? [];
}

export function can(role: Role, permission: Permission): boolean {
  return permissionsFor(role).includes(permission);
}
