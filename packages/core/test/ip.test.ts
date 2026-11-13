import { describe, expect, it } from "vitest";
import { ipAllowed, parseIpv4, parseIpv6 } from "../src/ip.js";

describe("parseIpv4", () => {
  it("parses and rejects", () => {
    expect(parseIpv4("10.0.0.1")).toBe(0x0a000001);
    expect(parseIpv4("255.255.255.255")).toBe(0xffffffff);
    expect(parseIpv4("256.0.0.1")).toBeNull();
    expect(parseIpv4("10.0.0")).toBeNull();
    expect(parseIpv4("a.b.c.d")).toBeNull();
  });
});

describe("parseIpv6", () => {
  it("parses compressed and full forms", () => {
    expect(parseIpv6("::1")).toBe(1n);
    expect(parseIpv6("2001:db8::1")).toBe(0x20010db8000000000000000000000001n);
    expect(parseIpv6("2001:0db8:0000:0000:0000:0000:0000:0001")).toBe(
      0x20010db8000000000000000000000001n,
    );
    expect(parseIpv6("fe80::")).toBe(0xfe800000000000000000000000000000n);
  });

  it("handles a dotted quad tail", () => {
    expect(parseIpv6("::ffff:192.0.2.1")).toBe(0xffffc0000201n);
  });

  it("rejects garbage", () => {
    expect(parseIpv6("not-an-ip")).toBeNull();
    expect(parseIpv6("2001:db8:::1")).toBeNull();
  });
});

describe("ipAllowed", () => {
  it("allows everything when the list is empty", () => {
    expect(ipAllowed("203.0.113.9", [])).toBe(true);
    expect(ipAllowed(undefined, [])).toBe(true);
  });

  it("matches a single address", () => {
    expect(ipAllowed("203.0.113.9", ["203.0.113.9"])).toBe(true);
    expect(ipAllowed("203.0.113.10", ["203.0.113.9"])).toBe(false);
  });

  it("matches CIDR blocks", () => {
    expect(ipAllowed("10.4.5.6", ["10.0.0.0/8"])).toBe(true);
    expect(ipAllowed("11.4.5.6", ["10.0.0.0/8"])).toBe(false);
    expect(ipAllowed("192.168.1.200", ["192.168.1.0/24"])).toBe(true);
    expect(ipAllowed("192.168.2.200", ["192.168.1.0/24"])).toBe(false);
    expect(ipAllowed("203.0.113.9", ["10.0.0.0/8", "203.0.113.0/28"])).toBe(
      true,
    );
  });

  it("treats an IPv4-mapped address as IPv4", () => {
    expect(ipAllowed("::ffff:127.0.0.1", ["127.0.0.1"])).toBe(true);
    expect(ipAllowed("::ffff:10.1.2.3", ["10.0.0.0/8"])).toBe(true);
    expect(ipAllowed("::ffff:8.8.8.8", ["10.0.0.0/8"])).toBe(false);
  });

  it("matches IPv6 prefixes and rejects a mismatched family", () => {
    expect(ipAllowed("2001:db8:1::5", ["2001:db8::/32"])).toBe(true);
    expect(ipAllowed("2001:db9::5", ["2001:db8::/32"])).toBe(false);
    expect(ipAllowed("10.0.0.1", ["2001:db8::/32"])).toBe(false);
  });

  it("ignores blank entries", () => {
    expect(ipAllowed("10.0.0.1", ["", "  ", "10.0.0.0/8"])).toBe(true);
  });

  it("denies an unparseable client address when a list exists", () => {
    expect(ipAllowed("unknown", ["10.0.0.0/8"])).toBe(false);
    expect(ipAllowed(null, ["10.0.0.0/8"])).toBe(false);
  });
});
