import { getSourceFamilyForSlotServer } from "@/lib/server-source-policy";

import {
  DEFAULT_RUNTIME_MANIFEST_MAX_AGE_MS,
  resolveSessionBackedManifest,
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

export const beinRuntimeAdapter: RuntimeAdapter = {
  kind: "bein",
  matches: (input) =>
    input.slotServer === 1 || looksLikeBeinSource(input.sourceUrl) || getSourceFamilyForSlotServer(input.slotServer) === "bein",
  resolve: async (input) =>
    resolveSessionBackedManifest(input, {
      adapterKind: "bein",
      candidateMaxAgeMs: DEFAULT_RUNTIME_MANIFEST_MAX_AGE_MS,
      maxCandidatesToTry: 6,
      preferUrlIncludes: [".m3u8", "easybroadcast", "token=", "/manifest/", "/playlist/"],
      preferReferrerIncludes: ["bein-live", "/matches/"],
      preferManifestIncludes: ["#extm3u", "#ext-x-targetduration"],
    }),
};
