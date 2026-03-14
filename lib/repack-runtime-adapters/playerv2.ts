import { getSourceFamilyForSlotServer } from "@/lib/server-source-policy";

import {
  PLAYERV2_RUNTIME_MANIFEST_MAX_AGE_MS,
  buildSessionOwnedRuntimeAdapter,
  type RuntimeAdapter,
} from "./shared";

function looksLikePlayerv2Source(rawUrl: string) {
  try {
    const parsed = new URL(String(rawUrl || "").trim());
    return String(parsed.pathname || "").toLowerCase().includes("/playerv2.php");
  } catch {
    return false;
  }
}

const playerv2BaseAdapter = buildSessionOwnedRuntimeAdapter(
  "playerv2",
  (input) =>
    input.slotServer === 2 || looksLikePlayerv2Source(input.sourceUrl) || getSourceFamilyForSlotServer(input.slotServer) === "siiir",
  {
    adapterKind: "playerv2",
    candidateMaxAgeMs: PLAYERV2_RUNTIME_MANIFEST_MAX_AGE_MS,
    maxCandidatesToTry: 8,
    forceFreshManifest: true,
    readyManifestMaxAgeMs: 10_000,
    warmingRuntimeMaxAgeMs: 18_000,
    warmingProgressMaxAgeMs: 12_000,
    runtimeWatchdogReadyStates: ["healthy", "refreshing"],
    runtimeWatchdogWarmingStates: ["recovering", "stalled", "refreshing"],
    preferUrlIncludes: ["/kooora/", "token=", "sid=", "nonce=", ".m3u8"],
    preferReferrerIncludes: ["/playerv2.php", "siiir", "yallashot"],
    preferManifestIncludes: ["/kooora/", "#extm3u"],
  }
);

export const playerv2RuntimeAdapter: RuntimeAdapter = {
  ...playerv2BaseAdapter,
  currentManifest: async (input, queryOptions) => {
    const peek = playerv2BaseAdapter.peekStatus(input);
    if (
      peek.state !== "ready" &&
      (!peek.currentSource || peek.watchdogState === "stalled" || peek.watchdogState === "recovering")
    ) {
      await playerv2BaseAdapter.refresh(input, "playerv2_preflight_refresh").catch(() => null);
    }

    let resolved = await playerv2BaseAdapter.currentManifest(input, {
      ...queryOptions,
      forceRefresh: queryOptions?.forceRefresh || peek.watchdogState === "stalled",
    });
    if (
      !resolved.ok &&
      queryOptions?.allowRotate !== false &&
      /(?:403|404|empty|no-verified-manifest|media-sequence-unchanged)/i.test(String(resolved.error || ""))
    ) {
      await playerv2BaseAdapter.rotate(input, "playerv2_retry_rotate").catch(() => null);
      resolved = await playerv2BaseAdapter.currentManifest(input, {
        ...queryOptions,
        forceRefresh: true,
        allowRotate: false,
      });
    }
    return resolved;
  },
};
