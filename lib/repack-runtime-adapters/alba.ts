import { getSourceFamilyForSlotServer } from "@/lib/server-source-policy";

import {
  DEFAULT_RUNTIME_MANIFEST_MAX_AGE_MS,
  buildSessionOwnedRuntimeAdapter,
  type RuntimeAdapter,
} from "./shared";

function looksLikeAlbaSource(rawUrl: string) {
  try {
    const parsed = new URL(String(rawUrl || "").trim());
    const pathname = String(parsed.pathname || "").toLowerCase();
    return pathname.includes("/albaplayer/") || pathname.includes("/alba.php");
  } catch {
    return false;
  }
}

const albaBaseAdapter = buildSessionOwnedRuntimeAdapter(
  "alba",
  (input) =>
    input.slotServer === 4 ||
    looksLikeAlbaSource(input.sourceUrl) ||
    getSourceFamilyForSlotServer(input.slotServer) === "livekora",
  {
    adapterKind: "alba",
    candidateMaxAgeMs: DEFAULT_RUNTIME_MANIFEST_MAX_AGE_MS,
    maxCandidatesToTry: 7,
    readyManifestMaxAgeMs: 12_000,
    warmingRuntimeMaxAgeMs: 26_000,
    warmingProgressMaxAgeMs: 16_000,
    runtimeWatchdogReadyStates: ["healthy", "refreshing"],
    runtimeWatchdogWarmingStates: ["recovering", "refreshing", "stalled"],
    preferUrlIncludes: [".m3u8", "/hls/", "/live/", "/stream/", "/manifest/"],
    preferReferrerIncludes: ["/albaplayer/", "livehd", "sportsurges", "livekora"],
    preferManifestIncludes: ["#extm3u", "#extinf"],
  }
);

export const albaRuntimeAdapter: RuntimeAdapter = {
  ...albaBaseAdapter,
  currentManifest: async (input, queryOptions) => {
    const peek = albaBaseAdapter.peekStatus(input);
    if (
      peek.state !== "ready" &&
      (peek.sourceCount > 1 || !peek.currentSource || peek.watchdogState === "stalled")
    ) {
      await albaBaseAdapter.refresh(input, "alba_preflight_refresh").catch(() => null);
    }

    let resolved = await albaBaseAdapter.currentManifest(input, queryOptions);
    if (
      !resolved.ok &&
      queryOptions?.allowRotate !== false &&
      (peek.sourceCount > 1 || /(?:empty|403|404|no-candidate|media-sequence-unchanged)/i.test(String(resolved.error || "")))
    ) {
      await albaBaseAdapter.rotate(input, "alba_retry_rotate").catch(() => null);
      resolved = await albaBaseAdapter.currentManifest(input, {
        ...queryOptions,
        forceRefresh: true,
        allowRotate: false,
      });
    }
    return resolved;
  },
};
