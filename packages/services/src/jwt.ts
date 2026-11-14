import { sign } from "node:crypto";

/**
 * A JWT signed the way Google wants a service account assertion signed.
 *
 * Kept in its own module with its own name because it is not a password hash and must never be
 * mistaken for one: the private key signs a short-lived claim set, and the result is exchanged
 * for an access token. `sign` with an explicit algorithm is the whole job here.
 */
export function signServiceAccountAssertion(
  claims: Record<string, unknown>,
  privateKey: string,
): string {
  const encode = (value: unknown): string =>
    Buffer.from(JSON.stringify(value)).toString("base64url");

  const unsigned = `${encode({ alg: "RS256", typ: "JWT" })}.${encode(claims)}`;
  const signature = sign("RSA-SHA256", Buffer.from(unsigned), privateKey);
  return `${unsigned}.${signature.toString("base64url")}`;
}
