import { resultLimits } from "./plugin-result-store.js";
import { isPublicResourceAddressAllowed } from "../shared/public-network-policy.js";
import type { TrustedHostsProvider } from "../shared/network-settings.js";
import { lookup } from "node:dns/promises";
import { isIP } from "node:net";
import { Agent, fetch as request } from "undici";
import { pluginError, pluginLimits } from "./plugin-types.js";
export function privateAddress(address: string): boolean {
  return !isPublicResourceAddressAllowed("", address, isIP(address) as 4 | 6);
}
export async function resolveTarget(
  raw: string,
  allowPrivate: boolean,
  trustedHosts: readonly string[] = [],
) {
  const url = new URL(raw);
  const host = url.hostname.replace(/^\[|\]$/g, "");
  if (
    url.username ||
    url.password ||
    url.search ||
    url.hash ||
    (!allowPrivate && url.protocol !== "https:") ||
    !["https:", "http:"].includes(url.protocol)
  )
    pluginError("NETWORK_TARGET_DENIED");
  const addresses = isIP(host)
    ? [{ address: host, family: isIP(host) }]
    : await lookup(host, { all: true });
  if (
    !addresses.length ||
    (!allowPrivate &&
      addresses.some(
        (a) =>
          !isPublicResourceAddressAllowed(host, a.address, a.family as 4 | 6, {
            trustedProxyHosts: trustedHosts,
          }),
      ))
  )
    pluginError("NETWORK_TARGET_DENIED");
  return { url, host, addresses };
}
/** Pin the validated DNS answer in the actual socket lookup. Redirects never forward credentials. */
export function safeFetch(
  origin: string,
  allowPrivate: boolean,
  trustedHosts: TrustedHostsProvider = () => Promise.resolve([]),
  observe?: (
    init: RequestInit | undefined,
  ) => ((bytes: number, tooLarge: boolean) => void) | undefined,
): typeof fetch {
  return async (input, init) => {
    const report = observe?.(init);
    const target =
      typeof input === "string"
        ? input
        : input instanceof URL
          ? input.href
          : input.url;
    if (new URL(target).origin !== new URL(origin).origin)
      pluginError("CROSS_ORIGIN_DENIED");
    const { addresses } = await resolveTarget(
      target,
      allowPrivate,
      await trustedHosts(),
    );
    const first = addresses[0]!;
    const agent = new Agent({
      connect: {
        lookup: (_hostname, options, callback) => {
          if (options.all) callback(null, addresses);
          else callback(null, first.address, first.family);
        },
      },
    });
    try {
      const response = await request(target, {
        method: init?.method ?? "GET",
        ...(init?.headers
          ? { headers: init.headers as Record<string, string> }
          : {}),
        ...(init?.body ? { body: init.body as string } : {}),
        signal: init?.signal ?? AbortSignal.timeout(pluginLimits.timeoutMs),
        redirect: "manual",
        dispatcher: agent,
      });
      if (response.status >= 300 && response.status < 400) {
        await response.body?.cancel();
        pluginError("REDIRECT_DENIED");
      }
      if (!response.body) {
        await agent.close();
        return new Response(null, {
          status: response.status,
          headers: Object.fromEntries(response.headers),
        });
      }
      const reader = (response.body as ReadableStream<Uint8Array>).getReader();
      let bytes = 0;
      const stream = new ReadableStream<Uint8Array>({
        async pull(controller) {
          try {
            const item = await reader.read();
            if (item.done) {
              controller.close();
              await agent.close();
            } else {
              bytes += item.value.byteLength;
              report?.(bytes, bytes > resultLimits.responseBytes);
              if (bytes > resultLimits.responseBytes) {
                await reader.cancel();
                controller.error(new Error("PLUGIN_RESPONSE_TOO_LARGE"));
                await agent.close();
              } else controller.enqueue(item.value);
            }
          } catch {
            controller.error(new Error("PLUGIN_NETWORK_FAILED"));
            await agent.close();
          }
        },
        async cancel() {
          await reader.cancel();
          await agent.close();
        },
      });
      return new Response(stream, {
        status: response.status,
        headers: Object.fromEntries(response.headers),
      });
    } catch (error) {
      await agent.destroy();
      throw error;
    }
  };
}
