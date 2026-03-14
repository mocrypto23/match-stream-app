import { getSourceFamilyForSlotServer } from "@/lib/server-source-policy";

import {
  DEFAULT_RUNTIME_MANIFEST_MAX_AGE_MS,
  resolveSessionBackedManifest,
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

export const albaRuntimeAdapter: RuntimeAdapter = {
  kind: "alba",
  matches: (input) =>
    input.slotServer === 3 ||
    input.slotServer === 4 ||
    looksLikeAlbaSource(input.sourceUrl) ||
    getSourceFamilyForSlotServer(input.slotServer) === "livehd" ||
    getSourceFamilyForSlotServer(input.slotServer) === "livekora",
  resolve: async (input) =>
    resolveSessionBackedManifest(input, {
      adapterKind: "alba",
      candidateMaxAgeMs: DEFAULT_RUNTIME_MANIFEST_MAX_AGE_MS,
      maxCandidatesToTry: 7,
      preferUrlIncludes: [".m3u8", "/hls/", "/live/", "/stream/", "/manifest/"],
      preferReferrerIncludes: ["/albaplayer/", "livehd", "sportsurges", "livekora"],
      preferManifestIncludes: ["#extm3u", "#extinf"],
    }),
};
