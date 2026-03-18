import axios from "axios";

import { fetchLiveEmbedText } from "@/lib/repack-embed-session";
import {
  buildPlayerv2Candidates,
  looksLikePlayerv2Html,
  looksLikePlayerv2PageUrl,
} from "@/lib/repack-ingest-resolver";
import { getSourceFamilyForSlotServer } from "@/lib/server-source-policy";

import {
  PLAYERV2_RUNTIME_MANIFEST_MAX_AGE_MS,
  buildSessionOwnedRuntimeAdapter,
  primeRuntimeHint,
  type RuntimeAdapter,
  type RuntimeAdapterInput,
  type RuntimeHintCandidate,
} from "./shared";

const DEFAULT_PLAYERV2_USER_AGENT =
  "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/145.0.0.0 Safari/537.36";

function looksLikePlayerv2Source(rawUrl: string) {
  try {
    const parsed = new URL(String(rawUrl || "").trim());
    return /\/playerv\d+\.php/i.test(String(parsed.pathname || "").toLowerCase());
  } catch {
    return false;
  }
}

function uniqHints(candidates: RuntimeHintCandidate[]) {
  const out: RuntimeHintCandidate[] = [];
  const seen = new Set<string>();
  for (const candidate of candidates) {
    const targetUrl = String(candidate.targetUrl || "").trim();
    const fetchUrl = String(candidate.fetchUrl || "").trim();
    const key = `${targetUrl}|${fetchUrl}`;
    if (!targetUrl || seen.has(key)) continue;
    seen.add(key);
    out.push(candidate);
  }
  return out;
}

async function derivePlayerv2HintCandidates(input: RuntimeAdapterInput) {
  const referrerUrl = input.sourceUrl;
  let body = "";
  let contextUrl = input.sourceUrl;

  if (looksLikePlayerv2PageUrl(input.sourceUrl)) {
    const direct = await axios
      .get<string>(input.sourceUrl, {
        responseType: "text",
        timeout: 9_000,
        maxRedirects: 5,
        validateStatus: () => true,
        headers: {
          "user-agent": DEFAULT_PLAYERV2_USER_AGENT,
          accept: "text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8",
          "accept-language": "ar,en;q=0.9",
          referer: referrerUrl,
        },
      })
      .catch(() => null);
    const directBody =
      Number(direct?.status || 0) >= 200 && Number(direct?.status || 0) < 300 ? String(direct?.data || "").trim() : "";
    if (directBody && looksLikePlayerv2Html(directBody)) {
      body = directBody;
      contextUrl = input.sourceUrl;
    }
  }

  if (!body) {
    const fetched = await fetchLiveEmbedText({
      sourceUrl: input.sourceUrl,
      requestOrigin: input.internalOrigin,
      slotServerId: input.slotServer,
      targetUrl: input.sourceUrl,
      fetchUrl: input.sourceUrl,
      referrerUrl,
      timeoutMs: 9_000,
    }).catch(() => null);
    body = String(fetched?.body || "").trim();
    const finalUrl = String(fetched?.finalUrl || input.sourceUrl).trim() || input.sourceUrl;
    contextUrl = looksLikePlayerv2PageUrl(finalUrl) ? finalUrl : input.sourceUrl;
  }

  if (!body || !looksLikePlayerv2Html(body)) return [] as RuntimeHintCandidate[];

  const candidates = await buildPlayerv2Candidates(contextUrl, body, 5_500, input.internalOrigin).catch(() => []);
  return uniqHints(
    candidates
      .filter((candidate) => candidate && !candidate.includes("/api/embed-proxy"))
      .slice(0, 8)
      .map((candidate) => ({
        targetUrl: candidate,
        fetchUrl: candidate,
        referrerUrl: contextUrl,
      }))
  );
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
    preferReferrerIncludes: ["/playerv", "siiir", "yallashot"],
    preferManifestIncludes: ["/kooora/", "#extm3u"],
  }
);

export const playerv2RuntimeAdapter: RuntimeAdapter = {
  ...playerv2BaseAdapter,
  currentManifest: async (input, queryOptions) => {
    const peek = playerv2BaseAdapter.peekStatus(input);
    if (queryOptions?.forceRefresh) {
      await playerv2BaseAdapter.refresh(input, "playerv2_forced_manifest_refresh").catch(() => null);
    }
    if (peek.state !== "ready" && !peek.currentSource) {
      for (const candidate of await derivePlayerv2HintCandidates(input)) {
        primeRuntimeHint(input, candidate);
      }
    }
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
    if (!resolved.ok) {
      for (const candidate of await derivePlayerv2HintCandidates(input)) {
        if (!primeRuntimeHint(input, candidate)) continue;
        resolved = await playerv2BaseAdapter.currentManifest(input, {
          ...queryOptions,
          forceRefresh: true,
          allowRotate: false,
        });
        if (resolved.ok) break;
      }
    }
    return resolved;
  },
};
