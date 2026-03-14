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

export const playerv2RuntimeAdapter: RuntimeAdapter = buildSessionOwnedRuntimeAdapter(
  "playerv2",
  (input) =>
    input.slotServer === 2 || looksLikePlayerv2Source(input.sourceUrl) || getSourceFamilyForSlotServer(input.slotServer) === "siiir",
  {
    adapterKind: "playerv2",
    candidateMaxAgeMs: PLAYERV2_RUNTIME_MANIFEST_MAX_AGE_MS,
    maxCandidatesToTry: 8,
    forceFreshManifest: true,
    preferUrlIncludes: ["/kooora/", "token=", "sid=", "nonce=", ".m3u8"],
    preferReferrerIncludes: ["/playerv2.php", "siiir", "yallashot"],
    preferManifestIncludes: ["/kooora/", "#extm3u"],
  }
);
