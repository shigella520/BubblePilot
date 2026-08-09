import { lookup } from "node:dns/promises";
import { request as httpRequest, type IncomingHttpHeaders } from "node:http";
import { request as httpsRequest } from "node:https";
import { BlockList, isIP, type LookupFunction } from "node:net";

import { loadBuffer } from "cheerio";

import type { LinkPreviewItem } from "../../ingestion/link-preview.js";

const maxBodyBytes = 1_048_576;
const maxRedirects = 3;

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

export class OpenGraphFetchError extends Error {
  constructor(
    readonly code: string,
    message: string,
    readonly httpStatus: number | null = null,
  ) {
    super(message);
  }
}

function clean(value: string | undefined, limit: number): string | null {
  const result = (value ?? "")
    .replace(/[\p{Cc}\p{Cf}]/gu, " ")
    .replace(/\s+/gu, " ")
    .trim()
    .slice(0, limit);
  return result.length === 0 ? null : result;
}

function validateUrl(value: string, base?: URL): URL {
  let url: URL;
  try {
    url = base === undefined ? new URL(value) : new URL(value, base);
  } catch {
    throw new OpenGraphFetchError(
      "LINK_PREVIEW_OG_INVALID_URL",
      "Invalid URL.",
    );
  }
  if (
    !["http:", "https:"].includes(url.protocol) ||
    url.username.length > 0 ||
    url.password.length > 0 ||
    (url.port.length > 0 && !["80", "443"].includes(url.port))
  ) {
    throw new OpenGraphFetchError(
      "LINK_PREVIEW_OG_BLOCKED_URL",
      "The URL is not allowed.",
    );
  }
  return url;
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
      : blockedIpv6.check(address, "ipv6") ||
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
  return !isBlockedAddress(
    address,
    family,
    trustsProxyFakeAddress(hostname, policy),
  );
}

async function resolvePublicAddress(
  hostname: string,
  policy: PublicResourceFetchPolicy,
): Promise<{ address: string; family: 4 | 6 }> {
  const normalizedHostname =
    hostname.startsWith("[") && hostname.endsWith("]")
      ? hostname.slice(1, -1)
      : hostname;
  const literalFamily = isIP(normalizedHostname);
  let addresses: readonly { address: string; family: number }[];
  try {
    addresses =
      literalFamily === 0
        ? await lookup(normalizedHostname, { all: true, verbatim: true })
        : [{ address: normalizedHostname, family: literalFamily }];
  } catch {
    throw new OpenGraphFetchError(
      "LINK_PREVIEW_OG_DNS_FAILED",
      "The hostname could not be resolved.",
    );
  }
  if (
    addresses.length === 0 ||
    addresses.some(
      (item) =>
        (item.family !== 4 && item.family !== 6) ||
        !isPublicResourceAddressAllowed(
          normalizedHostname,
          item.address,
          item.family,
          policy,
        ),
    )
  ) {
    throw new OpenGraphFetchError(
      "LINK_PREVIEW_OG_BLOCKED_ADDRESS",
      "The hostname resolves to a blocked address.",
    );
  }
  const selected = addresses[0];
  if (
    selected === undefined ||
    (selected.family !== 4 && selected.family !== 6)
  )
    throw new OpenGraphFetchError(
      "LINK_PREVIEW_OG_DNS_FAILED",
      "The hostname could not be resolved.",
    );
  return { address: selected.address, family: selected.family };
}

export interface PublicResource {
  url: URL;
  body: Buffer;
  status: number;
  headers: IncomingHttpHeaders;
}

async function requestBuffer(
  url: URL,
  timeoutMs: number,
  maximumBytes = maxBodyBytes,
  accept = "text/html,application/xhtml+xml;q=0.9",
  policy: PublicResourceFetchPolicy = {},
): Promise<{
  status: number;
  headers: IncomingHttpHeaders;
  body: Buffer;
}> {
  const selected = await resolvePublicAddress(url.hostname, policy);
  const pinnedLookup: LookupFunction = (_hostname, _options, callback) => {
    callback(null, selected.address, selected.family);
  };
  return new Promise((resolve, reject) => {
    let settled = false;
    const succeed = (value: {
      status: number;
      headers: IncomingHttpHeaders;
      body: Buffer;
    }) => {
      if (settled) return;
      settled = true;
      resolve(value);
    };
    const fail = (error: Error) => {
      if (settled) return;
      settled = true;
      reject(error);
    };
    const request = (url.protocol === "https:" ? httpsRequest : httpRequest)(
      url,
      {
        method: "GET",
        lookup: pinnedLookup,
        headers: {
          accept,
          "user-agent": "BubblePilot-LinkPreview/1.0",
        },
      },
      (response) => {
        const chunks: Buffer[] = [];
        let bytes = 0;
        response.on("data", (chunk: Buffer | string) => {
          const buffer = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
          bytes += buffer.length;
          if (bytes > maximumBytes) {
            response.destroy(
              new OpenGraphFetchError(
                "LINK_PREVIEW_OG_RESPONSE_TOO_LARGE",
                "The HTML response exceeds its size limit.",
                response.statusCode ?? null,
              ),
            );
            return;
          }
          chunks.push(buffer);
        });
        response.on("end", () =>
          succeed({
            status: response.statusCode ?? 0,
            headers: response.headers,
            body: Buffer.concat(chunks),
          }),
        );
        response.on("error", fail);
      },
    );
    request.setTimeout(timeoutMs, () =>
      request.destroy(
        new OpenGraphFetchError(
          "LINK_PREVIEW_OG_TIMEOUT",
          "The Open Graph request timed out.",
        ),
      ),
    );
    request.on("error", fail);
    request.end();
  });
}

export async function fetchPublicResource(
  initialUrl: string,
  timeoutMs: number,
  maximumBytes = maxBodyBytes,
  accept = "*/*",
  policy: PublicResourceFetchPolicy = {},
): Promise<PublicResource> {
  let url = validateUrl(initialUrl);
  for (let redirect = 0; redirect <= maxRedirects; redirect += 1) {
    const response = await requestBuffer(
      url,
      timeoutMs,
      maximumBytes,
      accept,
      policy,
    );
    if ([301, 302, 303, 307, 308].includes(response.status)) {
      const location = response.headers.location;
      if (location === undefined || redirect === maxRedirects)
        throw new OpenGraphFetchError(
          "LINK_PREVIEW_OG_REDIRECT_FAILED",
          "The redirect chain is invalid.",
          response.status,
        );
      url = validateUrl(location, url);
      continue;
    }
    if (response.status < 200 || response.status >= 300)
      throw new OpenGraphFetchError(
        `LINK_PREVIEW_OG_HTTP_${response.status}`,
        "The page returned an unsuccessful response.",
        response.status,
      );
    return {
      url,
      body: response.body,
      status: response.status,
      headers: response.headers,
    };
  }
  throw new OpenGraphFetchError(
    "LINK_PREVIEW_OG_REDIRECT_FAILED",
    "The redirect chain is too long.",
  );
}

async function fetchHtml(
  initialUrl: string,
  timeoutMs: number,
): Promise<PublicResource> {
  const response = await fetchPublicResource(
    initialUrl,
    timeoutMs,
    maxBodyBytes,
    "text/html,application/xhtml+xml;q=0.9",
  );
  const contentType = response.headers["content-type"] ?? "";
  if (!/^text\/html\b|^application\/xhtml\+xml\b/iu.test(contentType))
    throw new OpenGraphFetchError(
      "LINK_PREVIEW_OG_INVALID_CONTENT_TYPE",
      "The URL did not return HTML.",
      response.status,
    );
  return response;
}

function meta(
  $: ReturnType<typeof loadBuffer>,
  property: string,
  name = property,
): string | undefined {
  return (
    $(`meta[property="${property}"]`).first().attr("content") ??
    $(`meta[name="${name}"]`).first().attr("content")
  );
}

export class OpenGraphClient {
  async fetch(url: string, timeoutMs: number): Promise<LinkPreviewItem | null> {
    const response = await fetchHtml(url, timeoutMs);
    const $ = loadBuffer(response.body);
    const title = clean(
      meta($, "og:title", "twitter:title") ?? $("title").first().text(),
      500,
    );
    const summary = clean(
      meta($, "og:description", "twitter:description") ??
        $("meta[name=description]").first().attr("content"),
      2_000,
    );
    const siteName = clean(meta($, "og:site_name"), 200);
    const imageValue = clean(meta($, "og:image", "twitter:image"), 2_048);
    let imageUrl: string | null = null;
    if (imageValue !== null) {
      try {
        imageUrl = validateUrl(imageValue, response.url).toString();
      } catch {
        imageUrl = null;
      }
    }
    if (
      title === null &&
      summary === null &&
      siteName === null &&
      imageUrl === null
    )
      return null;
    return {
      source: "open-graph",
      url: response.url.toString(),
      originalUrl: validateUrl(url).toString(),
      title,
      summary,
      siteName,
      imageAvailable: imageUrl !== null,
      imageUrl,
      imageSource: imageUrl === null ? null : "open-graph",
      iconAvailable:
        $("link[rel~='icon'],link[rel='apple-touch-icon']").length > 0,
    };
  }
}
