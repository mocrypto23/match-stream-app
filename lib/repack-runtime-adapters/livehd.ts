import { getSourceFamilyForSlotServer } from "@/lib/server-source-policy";

import {
  DEFAULT_RUNTIME_MANIFEST_MAX_AGE_MS,
  buildSessionOwnedRuntimeAdapter,
  type RuntimeAdapter,
} from "./shared";

function looksLikeLivehdSource(rawUrl: string) {
  try {
    const parsed = new URL(String(rawUrl || "").trim());
    const host = String(parsed.hostname || "").toLowerCase();
    return host === "livehd77.pro" || host.endsWith(".livehd77.pro") || host === "alkoora.live" || host.endsWith(".alkoora.live");
  } catch {
    return false;
  }
}

const livehdBaseAdapter = buildSessionOwnedRuntimeAdapter(
  "livehd",
  (input) =>
    input.slotServer === 3 ||
    looksLikeLivehdSource(input.sourceUrl) ||
    getSourceFamilyForSlotServer(input.slotServer) === "livehd",
  {
    adapterKind: "livehd",
    candidateMaxAgeMs: DEFAULT_RUNTIME_MANIFEST_MAX_AGE_MS,
    maxCandidatesToTry: 7,
    readyManifestMaxAgeMs: 12_000,
    warmingRuntimeMaxAgeMs: 22_000,
    warmingProgressMaxAgeMs: 14_000,
    runtimeWatchdogReadyStates: ["healthy"],
    runtimeWatchdogWarmingStates: ["recovering", "refreshing", "stalled"],
    preferUrlIncludes: [".m3u8", "/hls/", "/live/", "/stream/", "/manifest/"],
    preferReferrerIncludes: ["livehd77", "/tv/", "/albaplayer/"],
    preferManifestIncludes: ["#extm3u", "#extinf"],
  }
);

export const livehdRuntimeAdapter: RuntimeAdapter = {
  ...livehdBaseAdapter,
  currentManifest: async (input, queryOptions) => {
    const peek = livehdBaseAdapter.peekStatus(input);
    if (
      peek.state !== "ready" &&
      (!peek.currentSource || peek.watchdogState === "recovering" || peek.watchdogState === "stalled")
    ) {
      await livehdBaseAdapter.refresh(input, "livehd_preflight_refresh").catch(() => null);
    }

    let resolved = await livehdBaseAdapter.currentManifest(input, queryOptions);
    if (
      !resolved.ok &&
      queryOptions?.allowRotate !== false &&
      /(?:empty|manifest-no-media-playlist|manifest-not-hls|media-sequence-unchanged)/i.test(String(resolved.error || ""))
    ) {
      await livehdBaseAdapter.rotate(input, "livehd_retry_rotate").catch(() => null);
      resolved = await livehdBaseAdapter.currentManifest(input, {
        ...queryOptions,
        forceRefresh: true,
        allowRotate: false,
      });
    }
    return resolved;
  },
};
