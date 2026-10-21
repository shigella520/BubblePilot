import { BlockList, isIP } from "node:net";
const blockedIpv4 = new BlockList();
for (const [network, prefix] of [
  ["0.0.0.0", 8],
  ["10.0.0.0", 8],
  ["100.64.0.0", 10],
  ["127.0.0.0", 8],
  ["169.254.0.0", 16],
  ["172.16.0.0", 12],
  ["192.0.0.0", 24],
  ["192.0.2.0", 24],
  ["192.168.0.0", 16],
  ["198.18.0.0", 15],
  ["198.51.100.0", 24],
  ["203.0.113.0", 24],
  ["224.0.0.0", 4],
  ["240.0.0.0", 4],
] as const) {
  blockedIpv4.addSubnet(network, prefix, "ipv4");
}
const proxyFakeAddresses = new BlockList();
proxyFakeAddresses.addSubnet("198.18.0.0", 15, "ipv4");
const globalIpv6 = new BlockList();
globalIpv6.addSubnet("2000::", 3, "ipv6");
globalIpv6.addSubnet("::ffff:0:0", 96, "ipv6");
const blockedIpv6 = new BlockList();
for (const [network, prefix] of [
  ["::", 128],
  ["::1", 128],
  ["fc00::", 7],
  ["fe80::", 10],
  ["ff00::", 8],
  ["2001:db8::", 32],
] as const) {
  blockedIpv6.addSubnet(network, prefix, "ipv6");
}

export interface PublicResourceFetchPolicy {
  trustedProxyHosts?: readonly string[];
}

function normalizedHost(value: string): string {
  return value.toLowerCase().replace(/\.$/u, "");
}

function trustsProxyFakeAddress(
  hostname: string,
  policy: PublicResourceFetchPolicy,
): boolean {
  const candidate = normalizedHost(hostname);
  return (policy.trustedProxyHosts ?? []).some(
    (host) => normalizedHost(host) === candidate,
  );
}

function isBlockedAddress(
  address: string,
  family: 4 | 6,
  allowProxyFakeAddress: boolean,
): boolean {
  const blocked =
    family === 4
      ? blockedIpv4.check(address, "ipv4")
      : !globalIpv6.check(address, "ipv6") ||
        blockedIpv6.check(address, "ipv6") ||
        blockedIpv4.check(address, "ipv6");
  if (!blocked) return false;
  return !(
    allowProxyFakeAddress &&
    family === 4 &&
    proxyFakeAddresses.check(address, "ipv4")
  );
}

export function isPublicResourceAddressAllowed(
  hostname: string,
  address: string,
  family: 4 | 6,
  policy: PublicResourceFetchPolicy = {},
): boolean {
  if (isIP(address) !== family) return false;
  return !isBlockedAddress(
    address,
    family,
    trustsProxyFakeAddress(hostname, policy),
  );
}
