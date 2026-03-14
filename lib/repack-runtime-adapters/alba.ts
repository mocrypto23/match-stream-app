import { fetchLiveEmbedText } from "@/lib/repack-embed-session";
import { extractCandidatesFromText, isLikelyAlbaLandingUrl } from "@/lib/repack-ingest-resolver";
import { getSourceFamilyForSlotServer, isValidHttpUrl } from "@/lib/server-source-policy";

import {
  DEFAULT_RUNTIME_MANIFEST_MAX_AGE_MS,
  buildSessionOwnedRuntimeAdapter,
  primeRuntimeHint,
  rewriteManifestForSessionMirror,
  type RuntimeManifestResult,
  type RuntimeAdapter,
  type RuntimeAdapterInput,
  type RuntimeHintCandidate,
} from "./shared";

const LIVEKORA_FAMILY_BASE_HOSTS = ["sportsurges.cc", "livekora.vip", "koooralive.click", "kooraxx.com"] as const;

function looksLikeAlbaSource(rawUrl: string) {
  try {
    const parsed = new URL(String(rawUrl || "").trim());
    const pathname = String(parsed.pathname || "").toLowerCase();
    return pathname.includes("/albaplayer/") || pathname.includes("/alba.php");
  } catch {
    return false;
  }
}

function normalizeHttpUrl(rawUrl: string) {
  try {
    const parsed = new URL(String(rawUrl || "").trim());
    return parsed.protocol === "http:" || parsed.protocol === "https:" ? parsed.toString() : "";
  } catch {
    return "";
  }
}

function isLivekoraFamilyHost(host: string) {
  const normalized = String(host || "").trim().toLowerCase();
  return LIVEKORA_FAMILY_BASE_HOSTS.some((suffix) => normalized === suffix || normalized.endsWith(`.${suffix}`));
}

function isLivekoraFamilyUrl(rawUrl: string) {
  try {
    return isLivekoraFamilyHost(new URL(String(rawUrl || "").trim()).hostname);
  } catch {
    return false;
  }
}

function resolveLivekoraIframeUrl(rawUrl: string, baseUrl: string) {
  try {
    const absolute = new URL(String(rawUrl || "").trim(), baseUrl).toString();
    return isValidHttpUrl(absolute) ? absolute : "";
  } catch {
    return "";
  }
}

function looksLikeStreamishUrl(rawUrl: string) {
  try {
    const parsed = new URL(String(rawUrl || "").trim());
    const pathname = String(parsed.pathname || "").toLowerCase();
    const search = String(parsed.search || "").toLowerCase();
    return (
      pathname.includes(".m3u8") ||
      pathname.includes("/hls/") ||
      pathname.includes("/stream/") ||
      pathname.includes("/live/") ||
      pathname.includes("/manifest/") ||
      pathname.includes("/kooora/") ||
      search.includes("token=") ||
      search.includes("sid=") ||
      search.includes("session")
    );
  } catch {
    return false;
  }
}

function buildAlbaVariants(sourceUrl: string) {
  try {
    const parsed = new URL(String(sourceUrl || "").trim());
    const host = String(parsed.hostname || "").toLowerCase();
    if (
      !host.endsWith("sportsurges.cc") &&
      host !== "sportsurges.cc" &&
      !host.endsWith("livekora.vip") &&
      host !== "livekora.vip" &&
      !host.endsWith("koooralive.click") &&
      host !== "koooralive.click" &&
      !host.endsWith("kooraxx.com") &&
      host !== "kooraxx.com"
    ) {
      return [parsed.toString()];
    }
    const scheme = parsed.protocol === "http:" ? "http" : "https";
    const hostParts = host.split(".").filter(Boolean);
    const firstLabel = hostParts.length > 2 ? hostParts[0] || "" : "";
    const originVariants = new Set<string>([parsed.origin]);
    for (const familyHost of LIVEKORA_FAMILY_BASE_HOSTS) {
      originVariants.add(`${scheme}://${familyHost}`);
      if (familyHost === "sportsurges.cc" && firstLabel && /^\d+$/.test(firstLabel)) {
        originVariants.add(`${scheme}://${firstLabel}.${familyHost}`);
      }
    }
    const parts = String(parsed.pathname || "")
      .split("/")
      .map((item) => item.trim())
      .filter(Boolean);
    const slug = (parts[0] === "albaplayer" ? parts[1] : parts[0] || "").toLowerCase();
    if (!slug) return [parsed.toString()];
    const variants: string[] = [];
    const pushVariant = (value: string) => {
      const normalized = normalizeHttpUrl(value);
      if (!normalized || variants.includes(normalized)) return;
      variants.push(normalized);
    };
    for (const origin of originVariants) {
      pushVariant(`${origin}/${slug}/`);
    }
    pushVariant(parsed.toString());
    for (const origin of originVariants) {
      pushVariant(`${origin}/albaplayer/${slug}/`);
      for (const serv of ["2", "5", "1", "0", "3", "4"]) {
        pushVariant(`${origin}/albaplayer/${slug}/?serv=${serv}`);
      }
    }
    return variants;
  } catch {
    return [String(sourceUrl || "").trim()].filter(Boolean);
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

async function deriveAlbaHintCandidates(input: RuntimeAdapterInput) {
  const startedAt = Date.now();
  const deadlineAt = startedAt + 12_000;
  const queue = buildAlbaVariants(input.sourceUrl).map((url) => ({
    url,
    depth: 0,
    referrerUrl: input.sourceUrl,
  }));
  const visited = new Set<string>();
  const derived: RuntimeHintCandidate[] = [];

  while (queue.length && visited.size < 6 && derived.length < 12 && Date.now() < deadlineAt) {
    const current = queue.shift();
    if (!current) continue;
    const pageUrl = normalizeHttpUrl(current.url);
    if (!pageUrl || visited.has(pageUrl)) continue;
    visited.add(pageUrl);
    const remainingMs = Math.max(2_500, Math.min(7_000, deadlineAt - Date.now()));
    if (remainingMs <= 0) break;

    const fetched = await fetchLiveEmbedText({
      sourceUrl: input.sourceUrl,
      requestOrigin: input.internalOrigin,
      slotServerId: input.slotServer,
      targetUrl: pageUrl,
      fetchUrl: pageUrl,
      referrerUrl: current.referrerUrl,
      timeoutMs: remainingMs,
    }).catch(() => null);
    const body = String(fetched?.body || "").trim();
    const finalUrl = String(fetched?.finalUrl || pageUrl).trim() || pageUrl;
    if (!body) continue;

    for (const rawCandidate of extractCandidatesFromText(body, finalUrl)) {
      const candidate = normalizeHttpUrl(rawCandidate);
      if (!candidate || candidate.includes("/api/embed-proxy")) continue;
      if (isLikelyAlbaLandingUrl(candidate) && current.depth < 2) {
        queue.push({
          url: candidate,
          depth: current.depth + 1,
          referrerUrl: finalUrl,
        });
        continue;
      }
      if (!looksLikeStreamishUrl(candidate)) continue;
      derived.push({
        targetUrl: candidate,
        fetchUrl: candidate,
        referrerUrl: finalUrl,
      });
      if (derived.length >= 12) break;
    }
  }

  return uniqHints(derived);
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
    if (peek.state !== "ready" && (!peek.currentSource || peek.sourceCount === 0)) {
      for (const candidate of await deriveAlbaHintCandidates(input)) {
        primeRuntimeHint(input, candidate);
      }
    }
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
    if (!resolved.ok) {
      for (const candidate of await deriveAlbaHintCandidates(input)) {
        if (!primeRuntimeHint(input, candidate)) continue;
        resolved = await albaBaseAdapter.currentManifest(input, {
          ...queryOptions,
          forceRefresh: true,
          allowRotate: false,
        });
        if (resolved.ok) break;
      }
    }
    return resolved;
  },
  fetchAsset: (input) => albaBaseAdapter.fetchAsset(input),
};
