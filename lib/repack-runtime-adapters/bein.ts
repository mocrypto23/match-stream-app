import { getSourceFamilyForSlotServer } from "@/lib/server-source-policy";

import {
  DEFAULT_RUNTIME_MANIFEST_MAX_AGE_MS,
  buildSessionOwnedRuntimeAdapter,
  type RuntimeAdapter,
} from "./shared";

function looksLikeBeinSource(rawUrl: string) {
  try {
    const parsed = new URL(String(rawUrl || "").trim());
    const host = parsed.hostname.toLowerCase();
    const pathname = String(parsed.pathname || "").toLowerCase();
    return (host === "bein-live.com" || host.endsWith(".bein-live.com")) && pathname.includes("/matches/");
  } catch {
    return false;
  }
}

const beinBaseAdapter = buildSessionOwnedRuntimeAdapter(
  "bein",
  (input) =>
    input.slotServer === 1 || looksLikeBeinSource(input.sourceUrl) || getSourceFamilyForSlotServer(input.slotServer) === "bein",
  {
    adapterKind: "bein",
    candidateMaxAgeMs: DEFAULT_RUNTIME_MANIFEST_MAX_AGE_MS,
    maxCandidatesToTry: 6,
    readyManifestMaxAgeMs: 14_000,
    warmingRuntimeMaxAgeMs: 24_000,
    warmingProgressMaxAgeMs: 16_000,
    runtimeWatchdogReadyStates: ["healthy"],
    runtimeWatchdogWarmingStates: ["recovering", "refreshing", "stalled"],
    preferUrlIncludes: [".m3u8", "easybroadcast", "token=", "/manifest/", "/playlist/"],
    preferReferrerIncludes: ["bein-live", "/matches/"],
    preferManifestIncludes: ["#extm3u", "#ext-x-targetduration"],
  }
);

export const beinRuntimeAdapter: RuntimeAdapter = {
  ...beinBaseAdapter,
  currentManifest: async (input, queryOptions) => {
    const peek = beinBaseAdapter.peekStatus(input);
    if (
      peek.state === "warming" &&
      (peek.watchdogState === "recovering" ||
        peek.watchdogState === "stalled" ||
        (!peek.activeManifestAgeMs && !!peek.currentSource))
    ) {
      await beinBaseAdapter.refresh(input, "bein_preflight_refresh").catch(() => null);
    }

    let resolved = await beinBaseAdapter.currentManifest(input, queryOptions);
    if (
      !resolved.ok &&
      queryOptions?.allowRotate !== false &&
      /(?:manifest-http-5|manifest-not-hls|manifest-no-media-playlist|empty)/i.test(String(resolved.error || ""))
    ) {
      await beinBaseAdapter.refresh(input, "bein_retry_refresh").catch(() => null);
      resolved = await beinBaseAdapter.currentManifest(input, {
        ...queryOptions,
        forceRefresh: true,
        allowRotate: false,
      });
    }
    return resolved;
  },
};
