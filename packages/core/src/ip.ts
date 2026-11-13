/**
 * Operator IP allow list, the cheap second fence in front of the console.
 *
 * Off by default; when ADMIN_IP_ALLOWLIST is set, the API refuses console calls
 * from anywhere else. Supports plain addresses and CIDR blocks for IPv4 and
 * IPv6, including the IPv4-mapped form Node reports on dual-stack sockets.
 */

export function parseIpv4(value: string): number | null {
  const parts = value.split(".");
  if (parts.length !== 4) return null;
  let result = 0;
  for (const part of parts) {
    if (!/^\d{1,3}$/.test(part)) return null;
    const octet = Number(part);
    if (octet > 255) return null;
    result = (result << 8) | octet;
  }
  return result >>> 0;
}

export function parseIpv6(value: string): bigint | null {
  const trimmed = value.replace(/^\[|\]$/g, "");
  if (!trimmed.includes(":")) return null;

  const [head, tail] = trimmed.includes("::")
    ? trimmed.split("::")
    : [trimmed, null];
  // "2001:db8:::1" parses as two empty jumps; a host has at most one.
  if (tail !== null && (head!.endsWith(":") || tail.startsWith(":")))
    return null;
  const headGroups = head ? head.split(":").filter(Boolean) : [];
  const tailGroups = tail ? tail.split(":").filter(Boolean) : [];

  const expandedTail = tailGroups.flatMap((group) => {
    // A trailing dotted quad (::ffff:192.0.2.1) counts as two groups.
    if (group.includes(".")) {
      const ipv4 = parseIpv4(group);
      if (ipv4 === null) return [];
      return [(ipv4 >>> 16).toString(16), (ipv4 & 0xffff).toString(16)];
    }
    return [group];
  });

  const missing = 8 - headGroups.length - expandedTail.length;
  if (missing < 0) return null;
  const groups = [
    ...headGroups,
    ...Array(tail === null ? 0 : missing).fill("0"),
    ...expandedTail,
  ];
  if (groups.length !== 8) return null;

  let result = 0n;
  for (const group of groups) {
    if (!/^[0-9a-fA-F]{1,4}$/.test(group)) return null;
    result = (result << 16n) | BigInt(parseInt(group, 16));
  }
  return result;
}

/** Node reports ::ffff:127.0.0.1 on dual-stack sockets; treat it as IPv4. */
function normalise(
  ip: string,
): { version: 4 | 6; numeric: number | bigint } | null {
  const value = ip.trim();
  const mapped = value.match(/^::ffff:(\d+\.\d+\.\d+\.\d+)$/i);
  if (mapped) {
    const parsed = parseIpv4(mapped[1]!);
    return parsed === null ? null : { version: 4, numeric: parsed };
  }

  const ipv4 = parseIpv4(value);
  if (ipv4 !== null) return { version: 4, numeric: ipv4 };

  const ipv6 = parseIpv6(value);
  if (ipv6 !== null) return { version: 6, numeric: ipv6 };
  return null;
}

function inCidr(
  ip: { version: 4 | 6; numeric: number | bigint },
  network: { version: 4 | 6; numeric: number | bigint },
  bits: number,
): boolean {
  if (ip.version !== network.version) return false;

  if (ip.version === 4) {
    if (bits <= 0) return true;
    if (bits > 32) return false;
    const mask = bits === 32 ? 0xffffffff : (0xffffffff << (32 - bits)) >>> 0;
    return (
      ((ip.numeric as number) & mask) === ((network.numeric as number) & mask)
    );
  }

  if (bits <= 0) return true;
  if (bits > 128) return false;
  const shift = BigInt(128 - bits);
  return (
    (ip.numeric as bigint) >> shift === (network.numeric as bigint) >> shift
  );
}

/**
 * True when `ip` matches any entry. An empty list allows everything, which is
 * what an unset ADMIN_IP_ALLOWLIST must mean.
 */
export function ipAllowed(
  ip: string | undefined | null,
  entries: readonly string[],
): boolean {
  if (entries.length === 0) return true;
  if (!ip) return false;

  const address = normalise(ip);
  if (!address) return false;

  for (const entry of entries) {
    const clean = entry.trim();
    if (!clean) continue;

    const [networkPart, bitsPart] = clean.split("/");
    const network = normalise(networkPart ?? "");
    if (!network) continue;

    const bits =
      bitsPart === undefined
        ? network.version === 4
          ? 32
          : 128
        : Number(bitsPart);
    if (!Number.isInteger(bits)) continue;
    if (inCidr(address, network, bits)) return true;
  }

  return false;
}
