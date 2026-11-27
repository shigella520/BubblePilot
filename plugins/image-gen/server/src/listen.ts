import type { NetworkInterfaceInfo } from "node:os";

function ipv4ToNumber(address: string) {
  const parts = address.split(".").map(Number);
  if (
    parts.length !== 4 ||
    parts.some((part) => !Number.isInteger(part) || part < 0 || part > 255)
  )
    throw new Error("Invalid IPv4 address");
  return (
    ((parts[0]! << 24) | (parts[1]! << 16) | (parts[2]! << 8) | parts[3]!) >>> 0
  );
}

export function inCidr(address: string, cidr: string) {
  const [network, bits] = cidr.split("/");
  const prefix = Number(bits);
  const mask = prefix === 0 ? 0 : (0xffffffff << (32 - prefix)) >>> 0;
  return (ipv4ToNumber(address) & mask) === (ipv4ToNumber(network!) & mask);
}

/**
 * Choose the bind address. An explicit LISTEN_HOST wins; otherwise bind to the
 * first non-loopback IPv4 outside every excluded CIDR (the LAN/macvlan range),
 * sorted for determinism. Fails closed: never falls back to 0.0.0.0.
 */
export function selectListenAddress(
  interfaces: NodeJS.Dict<NetworkInterfaceInfo[]>,
  exclude: readonly string[],
  explicit?: string,
) {
  if (explicit) {
    if (explicit === "0.0.0.0" && exclude.length)
      throw new Error("LISTEN_HOST 0.0.0.0 conflicts with LISTEN_EXCLUDE_CIDR");
    return explicit;
  }
  const candidates = Object.values(interfaces)
    .flatMap((entries) => entries ?? [])
    .filter((entry) => entry.family === "IPv4" && !entry.internal)
    .map((entry) => entry.address)
    .filter((address) => !exclude.some((cidr) => inCidr(address, cidr)))
    .sort((a, b) => ipv4ToNumber(a) - ipv4ToNumber(b));
  const chosen = candidates[0];
  if (!chosen)
    throw new Error("No IPv4 address outside LISTEN_EXCLUDE_CIDR to bind");
  return chosen;
}
