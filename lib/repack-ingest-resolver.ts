import { isValidHttpUrl } from "./server-source-policy";

export type RepackIngestMode = "direct_m3u8" | "backend_proxy_ingest" | "none";

export type RepackIngestResolution = {
  mode: RepackIngestMode;
  ingestUrl: string | null;
  reason: string;
};

type ResolveRepackIngestInput = {
  sourceUrl: string;
  requestOrigin: string;
  referrerUrl?: string | null;
  timeoutMs?: number;
};

const DEFAULT_TIMEOUT_MS = 4200;

function normalizeHttpUrl(raw: unknown) {
  const value = String(raw || "").trim();
  if (!value || !isValidHttpUrl(value)) return "";
  return value;
}

function looksLikeHlsManifestUrl(raw: string) {
  if (!isValidHttpUrl(raw)) return false;
  try {
    const u = new URL(raw);
    const pathname = String(u.pathname || "").toLowerCase();
    const search = String(u.search || "").toLowerCase();
    const combined = `${pathname}${search}`;
    if (combined.includes(".mpd")) return false;
    if (combined.includes(".m3u8")) return true;
    if (
      pathname.includes("/hls/") ||
      pathname.includes("/live/") ||
      pathname.includes("/playlist/") ||
      pathname.includes("/manifest/") ||
      pathname.includes("/stream/")
    ) {
      return true;
    }
    return false;
  } catch {
    return false;
  }
}

function extractCandidatesFromText(text: string, baseUrl: string) {
  const out = new Set<string>();
  const html = String(text || "");
  const normalized = html.replace(/&amp;/gi, "&");

  const absoluteUrlRe = /https?:\/\/[^\s"'<>`\\)]+/gi;
  for (const match of normalized.matchAll(absoluteUrlRe)) {
    const raw = String(match[0] || "").trim();
    if (!raw || !isValidHttpUrl(raw)) continue;
    out.add(raw);
  }

  const embedProxyRe = /\/api\/embed-proxy\?[^\s"'<>`\\)]+/gi;
  for (const match of normalized.matchAll(embedProxyRe)) {
    const raw = String(match[0] || "").trim();
    if (!raw) continue;
    try {
      const absolute = new URL(raw, baseUrl).toString();
      if (isValidHttpUrl(absolute)) out.add(absolute);
    } catch {}
  }

  return Array.from(out);
}

function pickBestDirectHlsCandidate(candidates: string[]) {
  let picked = "";
  let bestScore = Number.NEGATIVE_INFINITY;
  for (const candidate of candidates) {
    if (!isValidHttpUrl(candidate)) continue;
    if (!looksLikeHlsManifestUrl(candidate)) continue;
    let score = 0;
    if (candidate.includes(".m3u8")) score += 120;
    score += 80;
    if (candidate.includes("/api/embed-proxy?")) score -= 300;
    if (score > bestScore) {
      bestScore = score;
      picked = candidate;
    }
  }
  return picked;
}

function pickBestProxyCandidate(candidates: string[]) {
  let picked = "";
  let bestScore = Number.NEGATIVE_INFINITY;
  for (const candidate of candidates) {
    if (!isValidHttpUrl(candidate)) continue;
    if (!candidate.includes("/api/embed-proxy?")) continue;
    let score = 0;
    if (candidate.includes(".m3u8")) score += 80;
    if (candidate.includes("stable=1")) score += 30;
    if (score > bestScore) {
      bestScore = score;
      picked = candidate;
    }
  }
  return picked;
}

async function fetchTextWithTimeout(url: string, timeoutMs: number) {
  const controller = new AbortController();
  const timeoutId = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const response = await fetch(url, {
      method: "GET",
      cache: "no-store",
      redirect: "follow",
      signal: controller.signal,
      headers: {
        accept: "application/vnd.apple.mpegurl,application/x-mpegurl,text/html,*/*",
      },
    });
    const contentType = String(response.headers.get("content-type") || "").toLowerCase();
    const body = await response.text();
    return {
      ok: response.ok,
      status: response.status,
      contentType,
      body,
    };
  } catch {
    return {
      ok: false,
      status: 0,
      contentType: "",
      body: "",
    };
  } finally {
    clearTimeout(timeoutId);
  }
}

function looksLikeManifestBody(body: string, contentType: string) {
  const text = String(body || "");
  const type = String(contentType || "").toLowerCase();
  return (
    text.includes("#EXTM3U") ||
    type.includes("application/vnd.apple.mpegurl") ||
    type.includes("application/x-mpegurl")
  );
}

function buildInternalEmbedProxyUrl(input: { sourceUrl: string; requestOrigin: string; referrerUrl?: string | null }) {
  const params = new URLSearchParams();
  params.set("url", input.sourceUrl);
  params.set("depth", "0");
  params.set("stable", "1");
  const ref = normalizeHttpUrl(input.referrerUrl || input.sourceUrl);
  if (ref) params.set("ref", ref);
  return `${String(input.requestOrigin || "").replace(/\/+$/, "")}/api/embed-proxy?${params.toString()}`;
}

export async function resolveRepackIngestUrl(input: ResolveRepackIngestInput): Promise<RepackIngestResolution> {
  const sourceUrl = normalizeHttpUrl(input.sourceUrl);
  const requestOrigin = String(input.requestOrigin || "").trim().replace(/\/+$/, "");
  const timeoutMs = Math.max(1200, Number.parseInt(String(input.timeoutMs || DEFAULT_TIMEOUT_MS), 10) || DEFAULT_TIMEOUT_MS);
  if (!sourceUrl) return { mode: "none", ingestUrl: null, reason: "invalid-source-url" };
  if (!requestOrigin || !isValidHttpUrl(requestOrigin)) {
    return { mode: "none", ingestUrl: null, reason: "invalid-request-origin" };
  }

  if (looksLikeHlsManifestUrl(sourceUrl)) {
    return { mode: "direct_m3u8", ingestUrl: sourceUrl, reason: "source-is-manifest" };
  }

  const directFetch = await fetchTextWithTimeout(sourceUrl, timeoutMs);
  if (directFetch.ok && looksLikeManifestBody(directFetch.body, directFetch.contentType)) {
    return { mode: "direct_m3u8", ingestUrl: sourceUrl, reason: "source-served-manifest" };
  }
  if (directFetch.ok && directFetch.body) {
    const directCandidates = extractCandidatesFromText(directFetch.body, sourceUrl);
    const directManifest = pickBestDirectHlsCandidate(directCandidates);
    if (directManifest) {
      return {
        mode: "direct_m3u8",
        ingestUrl: directManifest,
        reason: "resolved-direct-candidate",
      };
    }
  }

  const internalProxyUrl = buildInternalEmbedProxyUrl({
    sourceUrl,
    requestOrigin,
    referrerUrl: input.referrerUrl || sourceUrl,
  });
  const proxiedFetch = await fetchTextWithTimeout(internalProxyUrl, timeoutMs);
  if (proxiedFetch.ok && looksLikeManifestBody(proxiedFetch.body, proxiedFetch.contentType)) {
    return {
      mode: "backend_proxy_ingest",
      ingestUrl: internalProxyUrl,
      reason: "proxy-served-manifest",
    };
  }
  if (proxiedFetch.ok && proxiedFetch.body) {
    const proxyCandidates = extractCandidatesFromText(proxiedFetch.body, requestOrigin);
    const directManifest = pickBestDirectHlsCandidate(proxyCandidates);
    if (directManifest) {
      return {
        mode: "direct_m3u8",
        ingestUrl: directManifest,
        reason: "proxy-resolved-direct-candidate",
      };
    }
    const proxiedManifest = pickBestProxyCandidate(proxyCandidates);
    if (proxiedManifest) {
      return {
        mode: "backend_proxy_ingest",
        ingestUrl: proxiedManifest,
        reason: "proxy-resolved-proxy-candidate",
      };
    }
  }

  return {
    mode: "none",
    ingestUrl: null,
    reason: "no-ingest-candidate",
  };
}
