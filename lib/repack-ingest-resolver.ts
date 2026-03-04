import { isValidHttpUrl } from "./server-source-policy";
import type { RepackResolverState } from "./repack-runtime-state";

export type RepackIngestMode = "direct_m3u8" | "backend_proxy_ingest" | "none";

type ResolverStage =
  | "validate-source"
  | "source-direct"
  | "source-fetch"
  | "candidate-probe"
  | "done";

export type RepackIngestResolverDiag = {
  stage: ResolverStage;
  candidatesFound: number;
  candidatesProbed: number;
  selectedCandidate: string | null;
  selectedKind: RepackIngestMode;
  rejectReason: string;
  resolverState: RepackResolverState;
};

export type RepackIngestResolution = {
  mode: RepackIngestMode;
  ingestUrl: string | null;
  reason: string;
  resolver: RepackIngestResolverDiag;
  probeEvidence: {
    playlistUrl: string | null;
    segmentUrl: string | null;
    playlistStatus: number;
    segmentStatus: number;
    contentType: string;
  } | null;
};

type ResolveRepackIngestInput = {
  sourceUrl: string;
  requestOrigin: string;
  referrerUrl?: string | null;
  timeoutMs?: number;
  maxCandidates?: number;
};

type FetchResult = {
  ok: boolean;
  status: number;
  finalUrl: string;
  contentType: string;
  body: string;
};

type ProbeResult = {
  ok: boolean;
  reason: string;
  evidence: RepackIngestResolution["probeEvidence"];
  extraCandidates: string[];
};

const DEFAULT_TIMEOUT_MS = 5200;
const DEFAULT_SEGMENT_TIMEOUT_MS = 2200;
const DEFAULT_MAX_CANDIDATES = 16;
const MAX_DYNAMIC_CANDIDATES = 32;

function normalizeHttpUrl(raw: unknown) {
  const value = String(raw || "").trim();
  if (!value || !isValidHttpUrl(value)) return "";
  return value;
}

function canonicalizeUrl(raw: string) {
  if (!isValidHttpUrl(raw)) return "";
  try {
    const u = new URL(raw);
    u.hash = "";
    if ((u.protocol === "http:" && u.port === "80") || (u.protocol === "https:" && u.port === "443")) {
      u.port = "";
    }
    if (u.pathname !== "/") u.pathname = u.pathname.replace(/\/+$/, "");
    return u.toString().toLowerCase();
  } catch {
    return String(raw || "").trim().toLowerCase();
  }
}

function safeDecodeURIComponent(value: string) {
  try {
    return decodeURIComponent(value);
  } catch {
    return value;
  }
}

function normalizeCandidate(raw: unknown, baseUrl: string) {
  const initial = String(raw || "").trim();
  if (!initial) return "";
  const value = initial
    .replace(/\\u002f/gi, "/")
    .replace(/\\\//g, "/")
    .replace(/&amp;/gi, "&")
    .replace(/[\u0000-\u001f]+/g, "")
    .trim();
  if (!value) return "";
  if (/^(javascript:|data:|blob:|mailto:|tel:)/i.test(value)) return "";
  try {
    const resolved = new URL(value, baseUrl).toString();
    if (!isValidHttpUrl(resolved)) return "";
    return resolved;
  } catch {
    return "";
  }
}

function looksLikeNonStreamAssetPath(pathname: string) {
  return /\.(?:css|js|png|jpe?g|gif|svg|webp|avif|ico|woff2?|ttf|eot|map|json|xml|txt|pdf)(?:$|[?#])/i.test(
    String(pathname || "").toLowerCase()
  );
}

function looksLikeHlsManifestUrl(raw: string) {
  if (!isValidHttpUrl(raw)) return false;
  try {
    const u = new URL(raw);
    const pathname = String(u.pathname || "").toLowerCase();
    const search = String(u.search || "").toLowerCase();
    const combined = `${pathname}${search}`;
    if (looksLikeNonStreamAssetPath(pathname)) return false;
    if (combined.includes(".mpd")) return false;
    if (combined.includes(".m3u8")) return true;
    if (pathname.includes("/api/embed-proxy")) {
      const target = safeDecodeURIComponent(String(u.searchParams.get("url") || "").trim());
      if (target && looksLikeHlsManifestUrl(target)) return true;
    }
    if (
      pathname.includes("/hls/") ||
      pathname.includes("/live/") ||
      pathname.includes("/playlist/") ||
      pathname.includes("/manifest/") ||
      pathname.includes("/stream/")
    ) {
      return true;
    }
    if (
      search.includes("token=") ||
      search.includes("session") ||
      search.includes("playlist") ||
      search.includes("m3u8")
    ) {
      return true;
    }
    return false;
  } catch {
    return false;
  }
}

function isLikelyHtmlResponse(contentType: string, body: string) {
  const ct = String(contentType || "").toLowerCase();
  if (ct.includes("text/html") || ct.includes("application/xhtml+xml")) return true;
  return /^\s*<(?:!doctype\s+html|html|head|body|script|iframe|div)\b/i.test(String(body || ""));
}

function isLikelyManifestResponse(contentType: string, body: string, url: string) {
  const ct = String(contentType || "").toLowerCase();
  const text = String(body || "");
  if (text.includes("#EXTM3U")) return true;
  if (ct.includes("application/vnd.apple.mpegurl") || ct.includes("application/x-mpegurl")) return true;
  if (looksLikeHlsManifestUrl(url) && /#EXTINF:|#EXT-X-TARGETDURATION|#EXT-X-MEDIA-SEQUENCE/i.test(text)) return true;
  return false;
}

function extractCandidatesFromQueryParams(rawUrl: string) {
  if (!isValidHttpUrl(rawUrl)) return [] as string[];
  const out: string[] = [];
  try {
    const u = new URL(rawUrl);
    for (const key of ["url", "src", "source", "file", "playlist", "hls", "stream"]) {
      const value = String(u.searchParams.get(key) || "").trim();
      if (!value) continue;
      out.push(value);
      const decoded = safeDecodeURIComponent(value);
      if (decoded && decoded !== value) out.push(decoded);
    }
  } catch {}
  return out;
}

function extractCandidatesFromText(text: string, baseUrl: string) {
  const out = new Set<string>();
  const html = String(text || "");
  const normalized = html
    .replace(/\\u002f/gi, "/")
    .replace(/\\\//g, "/")
    .replace(/&amp;/gi, "&");

  const push = (raw: unknown) => {
    const candidate = normalizeCandidate(raw, baseUrl);
    if (!candidate) return;
    out.add(candidate);

    for (const nested of extractCandidatesFromQueryParams(candidate)) {
      const nestedNormalized = normalizeCandidate(nested, candidate);
      if (nestedNormalized) out.add(nestedNormalized);
    }
  };

  const absoluteUrlRe = /https?:\/\/[^\s"'<>`\\)]+/gi;
  for (const match of normalized.matchAll(absoluteUrlRe)) {
    push(match[0]);
  }

  const escapedAbsRe = /https?:\\\/\\\/[^\s"'<>`\\)]+/gi;
  for (const match of html.matchAll(escapedAbsRe)) {
    const raw = String(match[0] || "").replace(/\\\//g, "/");
    push(raw);
  }

  const attrRe = /\b(?:src|href|data-src|data-hls|data-file|data-url)\s*=\s*["']([^"']+)["']/gi;
  for (const match of normalized.matchAll(attrRe)) {
    push(match[1]);
  }

  const fieldRe = /(?:file|source|src|hls|url|stream|playlist)\s*[:=]\s*["']([^"']+)["']/gi;
  for (const match of normalized.matchAll(fieldRe)) {
    push(match[1]);
  }

  const jsonFieldRe = /"(?:file|source|src|hls|url|stream|playlist)"\s*:\s*"([^"\\]*(?:\\.[^"\\]*)*)"/gi;
  for (const match of html.matchAll(jsonFieldRe)) {
    const decoded = safeDecodeURIComponent(String(match[1] || "").replace(/\\\//g, "/"));
    push(decoded);
  }

  const embedProxyPathRe = /\/api\/embed-proxy\?[^\s"'<>`\\)]+/gi;
  for (const match of normalized.matchAll(embedProxyPathRe)) {
    push(match[0]);
  }

  return Array.from(out);
}

function randomAlphaNum(length: number) {
  const chars = "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789";
  let out = "";
  for (let idx = 0; idx < length; idx += 1) {
    out += chars[Math.floor(Math.random() * chars.length)] || "x";
  }
  return out;
}

function buildPlayerv2Nonce(tsSec: number) {
  return `${randomAlphaNum(4)}${(Math.max(0, tsSec) % 100000).toString(36)}`;
}

function normalizeDomainPrefix(rawDomain: string, baseUrl: string) {
  const value = String(rawDomain || "").trim().replace(/\\\//g, "/");
  if (!value) return "";
  const normalized = normalizeCandidate(value, baseUrl);
  if (!normalized) return "";
  return normalized.replace(/\/+$/, "");
}

function extractPlayerv2Bootstrap(html: string) {
  const text = String(html || "");
  const match = text.match(/window\.tabsConfig\s*=\s*(\{[\s\S]*?\})\s*;/i);
  if (!match?.[1]) return null as { paths: string[]; activeDomains: string[] } | null;
  try {
    const raw = String(match[1] || "").replace(/\\\//g, "/");
    const parsed = JSON.parse(raw) as {
      tabs?: Array<{ path?: string; mobile_path?: string }>;
      activeDomains?: string[];
    };
    const paths = new Set<string>();
    const tabs = Array.isArray(parsed?.tabs) ? parsed.tabs : [];
    for (const tab of tabs) {
      const path = String(tab?.path || tab?.mobile_path || "").trim();
      if (!path) continue;
      paths.add(path.replace(/^\/+/, ""));
    }
    const activeDomains = Array.isArray(parsed?.activeDomains)
      ? parsed.activeDomains.map((item) => String(item || "").trim()).filter(Boolean)
      : [];
    if (!paths.size) return null;
    return {
      paths: Array.from(paths),
      activeDomains,
    };
  } catch {
    return null;
  }
}

async function requestPlayerv2Token(input: {
  tokenEndpoint: string;
  pathValue: string;
  timeoutMs: number;
  sourceUrl: string;
}) {
  const controller = new AbortController();
  const timeoutId = setTimeout(() => controller.abort(), input.timeoutMs);
  try {
    const body = new URLSearchParams();
    body.set("path", input.pathValue);
    const response = await fetch(input.tokenEndpoint, {
      method: "POST",
      cache: "no-store",
      redirect: "follow",
      signal: controller.signal,
      headers: {
        "content-type": "application/x-www-form-urlencoded",
        accept: "application/json,text/plain,*/*",
        origin: (() => {
          try {
            return new URL(input.sourceUrl).origin;
          } catch {
            return "";
          }
        })(),
        referer: input.sourceUrl,
      },
      body,
    });
    if (!response.ok) return null as { token: string; sessionId: string } | null;
    const payload = (await response.json().catch(() => null)) as { token?: string; session_id?: string } | null;
    const token = String(payload?.token || "").trim();
    const sessionId = String(payload?.session_id || "").trim();
    if (!token || !sessionId) return null;
    return { token, sessionId };
  } catch {
    return null;
  } finally {
    clearTimeout(timeoutId);
  }
}

async function buildPlayerv2Candidates(sourceUrl: string, html: string, timeoutMs: number) {
  const bootstrap = extractPlayerv2Bootstrap(html);
  if (!bootstrap) return [] as string[];
  const out: string[] = [];

  let tokenEndpoint = "";
  try {
    const source = new URL(sourceUrl);
    tokenEndpoint = new URL("/playerv2.php?action=generate_token", `${source.protocol}//${source.host}`).toString();
  } catch {
    return [] as string[];
  }

  const domains = bootstrap.activeDomains.length
    ? bootstrap.activeDomains.map((item) => normalizeDomainPrefix(item, sourceUrl)).filter(Boolean)
    : [normalizeDomainPrefix(sourceUrl, sourceUrl)];
  if (!domains.length) return [] as string[];

  const maxPaths = Math.min(4, bootstrap.paths.length);
  for (const rawPath of bootstrap.paths.slice(0, maxPaths)) {
    const pathValue = String(rawPath || "").trim().replace(/^\/+/, "");
    if (!pathValue) continue;
    const token = await requestPlayerv2Token({
      tokenEndpoint,
      pathValue,
      timeoutMs: Math.max(1200, timeoutMs),
      sourceUrl,
    });
    if (!token) continue;
    const ts = Math.floor(Date.now() / 1000);
    const nonce = buildPlayerv2Nonce(ts);
    for (const domain of domains.slice(0, 4)) {
      const finalUrl = `${domain}/${pathValue}?ts=${ts}&nonce=${encodeURIComponent(nonce)}&token=${encodeURIComponent(token.token)}&session_id=${encodeURIComponent(token.sessionId)}`;
      if (isValidHttpUrl(finalUrl)) out.push(finalUrl);
    }
  }
  return out;
}

function buildInternalEmbedProxyUrl(input: { sourceUrl: string; requestOrigin: string; referrerUrl?: string | null }) {
  if (!isValidHttpUrl(input.requestOrigin)) return "";
  const params = new URLSearchParams();
  params.set("url", input.sourceUrl);
  params.set("depth", "0");
  params.set("stable", "1");
  const ref = normalizeHttpUrl(input.referrerUrl || input.sourceUrl);
  if (ref) params.set("ref", ref);
  return `${String(input.requestOrigin || "").replace(/\/+$/, "")}/api/embed-proxy?${params.toString()}`;
}

function classifyMode(rawUrl: string): RepackIngestMode {
  if (!isValidHttpUrl(rawUrl)) return "none";
  try {
    const pathname = String(new URL(rawUrl).pathname || "").toLowerCase();
    if (pathname.includes("/api/embed-proxy")) return "backend_proxy_ingest";
    return "direct_m3u8";
  } catch {
    return "none";
  }
}

function scoreCandidate(rawUrl: string, sourceHost: string) {
  if (!isValidHttpUrl(rawUrl)) return Number.NEGATIVE_INFINITY;
  let score = 0;
  try {
    const u = new URL(rawUrl);
    const pathname = String(u.pathname || "").toLowerCase();
    const search = String(u.search || "").toLowerCase();
    const combined = `${pathname}${search}`;
    if (looksLikeNonStreamAssetPath(pathname)) return Number.NEGATIVE_INFINITY;
    if (combined.includes(".mpd")) return Number.NEGATIVE_INFINITY;

    if (combined.includes(".m3u8")) score += 220;
    if (pathname.includes("/api/embed-proxy")) score -= 70;
    if (pathname.includes("/hls/") || pathname.includes("/live/") || pathname.includes("/manifest/")) score += 80;
    if (search.includes("token=") || search.includes("session") || search.includes("playlist")) score += 45;
    if (u.hostname.toLowerCase() === sourceHost) score += 28;
    if (u.hostname.toLowerCase().endsWith(`.${sourceHost}`)) score += 18;
  } catch {
    return Number.NEGATIVE_INFINITY;
  }
  if (looksLikeHlsManifestUrl(rawUrl)) score += 60;
  return score;
}

function parseLastSegmentUrl(playlistUrl: string, body: string) {
  const lines = String(body || "").split(/\r?\n/);
  for (let idx = lines.length - 1; idx >= 0; idx -= 1) {
    const raw = String(lines[idx] || "").trim();
    if (!raw || raw.startsWith("#")) continue;
    try {
      const absolute = new URL(raw, playlistUrl).toString();
      if (isValidHttpUrl(absolute)) return absolute;
    } catch {}
  }
  return "";
}

async function fetchWithTimeout(url: string, timeoutMs: number, headers?: Record<string, string>) {
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
        ...(headers || {}),
      },
    });
    const body = await response.text();
    return {
      ok: response.ok,
      status: response.status,
      finalUrl: response.url || url,
      contentType: String(response.headers.get("content-type") || "").toLowerCase(),
      body,
    } satisfies FetchResult;
  } catch {
    return {
      ok: false,
      status: 0,
      finalUrl: url,
      contentType: "",
      body: "",
    } satisfies FetchResult;
  } finally {
    clearTimeout(timeoutId);
  }
}

async function probeSegmentUrl(segmentUrl: string, timeoutMs: number) {
  const controller = new AbortController();
  const timeoutId = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const head = await fetch(segmentUrl, {
      method: "HEAD",
      cache: "no-store",
      redirect: "follow",
      signal: controller.signal,
    });
    if (head.ok) return { ok: true, status: head.status };
    if (head.status !== 405) return { ok: false, status: head.status };

    const getResp = await fetch(segmentUrl, {
      method: "GET",
      cache: "no-store",
      redirect: "follow",
      signal: controller.signal,
      headers: {
        range: "bytes=0-1",
      },
    });
    if (getResp.ok || getResp.status === 206) return { ok: true, status: getResp.status };
    return { ok: false, status: getResp.status };
  } catch {
    return { ok: false, status: 0 };
  } finally {
    clearTimeout(timeoutId);
  }
}

async function probeCandidate(input: {
  candidateUrl: string;
  timeoutMs: number;
  segmentTimeoutMs: number;
}): Promise<ProbeResult> {
  const fetched = await fetchWithTimeout(input.candidateUrl, input.timeoutMs);
  if (!fetched.ok) {
    return {
      ok: false,
      reason: `playlist-http-${fetched.status || 0}`,
      evidence: {
        playlistUrl: fetched.finalUrl || input.candidateUrl,
        segmentUrl: null,
        playlistStatus: fetched.status || 0,
        segmentStatus: 0,
        contentType: fetched.contentType,
      },
      extraCandidates: [],
    };
  }

  const manifestLike = isLikelyManifestResponse(fetched.contentType, fetched.body, fetched.finalUrl || input.candidateUrl);
  if (!manifestLike) {
    const extraCandidates = isLikelyHtmlResponse(fetched.contentType, fetched.body)
      ? extractCandidatesFromText(fetched.body, fetched.finalUrl || input.candidateUrl)
      : [];
    return {
      ok: false,
      reason: "non-manifest",
      evidence: {
        playlistUrl: fetched.finalUrl || input.candidateUrl,
        segmentUrl: null,
        playlistStatus: fetched.status,
        segmentStatus: 0,
        contentType: fetched.contentType,
      },
      extraCandidates,
    };
  }

  const segmentUrl = parseLastSegmentUrl(fetched.finalUrl || input.candidateUrl, fetched.body);
  if (!segmentUrl) {
    return {
      ok: false,
      reason: "manifest-empty",
      evidence: {
        playlistUrl: fetched.finalUrl || input.candidateUrl,
        segmentUrl: null,
        playlistStatus: fetched.status,
        segmentStatus: 0,
        contentType: fetched.contentType,
      },
      extraCandidates: [],
    };
  }

  const segmentProbe = await probeSegmentUrl(segmentUrl, input.segmentTimeoutMs);
  if (!segmentProbe.ok) {
    return {
      ok: false,
      reason: `segment-http-${segmentProbe.status || 0}`,
      evidence: {
        playlistUrl: fetched.finalUrl || input.candidateUrl,
        segmentUrl,
        playlistStatus: fetched.status,
        segmentStatus: segmentProbe.status || 0,
        contentType: fetched.contentType,
      },
      extraCandidates: [],
    };
  }

  return {
    ok: true,
    reason: "manifest+segment-ok",
    evidence: {
      playlistUrl: fetched.finalUrl || input.candidateUrl,
      segmentUrl,
      playlistStatus: fetched.status,
      segmentStatus: segmentProbe.status,
      contentType: fetched.contentType,
    },
    extraCandidates: [],
  };
}

function pushCandidateUnique(list: string[], seen: Set<string>, candidateUrl: string) {
  if (!isValidHttpUrl(candidateUrl)) return;
  const key = canonicalizeUrl(candidateUrl) || candidateUrl.toLowerCase();
  if (!key || seen.has(key)) return;
  seen.add(key);
  list.push(candidateUrl);
}

function rankCandidates(candidates: string[], sourceUrl: string, maxCandidates: number) {
  const sourceHost = (() => {
    try {
      return new URL(sourceUrl).hostname.toLowerCase();
    } catch {
      return "";
    }
  })();

  return candidates
    .map((candidateUrl) => ({
      candidateUrl,
      score: scoreCandidate(candidateUrl, sourceHost),
      mode: classifyMode(candidateUrl),
    }))
    .filter((item) => Number.isFinite(item.score) && item.score > Number.NEGATIVE_INFINITY)
    .sort((a, b) => b.score - a.score)
    .slice(0, maxCandidates);
}

function emptyResolution(reason: string, resolver: Partial<RepackIngestResolverDiag>): RepackIngestResolution {
  return {
    mode: "none",
    ingestUrl: null,
    reason,
    resolver: {
      stage: resolver.stage || "done",
      candidatesFound: Number.isFinite(resolver.candidatesFound) ? Number(resolver.candidatesFound) : 0,
      candidatesProbed: Number.isFinite(resolver.candidatesProbed) ? Number(resolver.candidatesProbed) : 0,
      selectedCandidate: resolver.selectedCandidate || null,
      selectedKind: resolver.selectedKind || "none",
      rejectReason: String(resolver.rejectReason || reason || "unknown"),
      resolverState: resolver.resolverState || "unknown",
    },
    probeEvidence: null,
  };
}

export async function resolveRepackIngestUrl(input: ResolveRepackIngestInput): Promise<RepackIngestResolution> {
  const timeoutMs = Math.max(1200, Number.parseInt(String(input.timeoutMs || DEFAULT_TIMEOUT_MS), 10) || DEFAULT_TIMEOUT_MS);
  const segmentTimeoutMs = Math.max(
    900,
    Number.parseInt(String(process.env.REPACK_AGENT_PREFLIGHT_TIMEOUT_MS || DEFAULT_SEGMENT_TIMEOUT_MS), 10) ||
      DEFAULT_SEGMENT_TIMEOUT_MS
  );
  const maxCandidates = Math.max(
    4,
    Math.min(64, Number.parseInt(String(input.maxCandidates || process.env.REPACK_RESOLVE_MAX_CANDIDATES || DEFAULT_MAX_CANDIDATES), 10) || DEFAULT_MAX_CANDIDATES)
  );

  const sourceUrl = normalizeHttpUrl(input.sourceUrl);
  if (!sourceUrl) {
    return emptyResolution("invalid-source-url", {
      stage: "validate-source",
      rejectReason: "invalid-source-url",
      resolverState: "missing-source",
    });
  }

  const sourceFetch = await fetchWithTimeout(sourceUrl, timeoutMs, {
    referer: normalizeHttpUrl(input.referrerUrl || sourceUrl) || sourceUrl,
  });

  if (looksLikeHlsManifestUrl(sourceUrl)) {
    const directProbe = await probeCandidate({
      candidateUrl: sourceUrl,
      timeoutMs,
      segmentTimeoutMs,
    });
    if (directProbe.ok) {
      return {
        mode: classifyMode(sourceUrl),
        ingestUrl: sourceUrl,
        reason: "source-is-manifest",
        resolver: {
          stage: "source-direct",
          candidatesFound: 1,
          candidatesProbed: 1,
          selectedCandidate: sourceUrl,
          selectedKind: classifyMode(sourceUrl),
          rejectReason: "",
          resolverState: "ok",
        },
        probeEvidence: directProbe.evidence,
      };
    }
  }

  if (sourceFetch.ok && isLikelyManifestResponse(sourceFetch.contentType, sourceFetch.body, sourceFetch.finalUrl || sourceUrl)) {
    const servedProbe = await probeCandidate({
      candidateUrl: sourceFetch.finalUrl || sourceUrl,
      timeoutMs,
      segmentTimeoutMs,
    });
    if (servedProbe.ok) {
      const directUrl = sourceFetch.finalUrl || sourceUrl;
      return {
        mode: classifyMode(directUrl),
        ingestUrl: directUrl,
        reason: "source-served-manifest",
        resolver: {
          stage: "source-fetch",
          candidatesFound: 1,
          candidatesProbed: 1,
          selectedCandidate: directUrl,
          selectedKind: classifyMode(directUrl),
          rejectReason: "",
          resolverState: "ok",
        },
        probeEvidence: servedProbe.evidence,
      };
    }
  }

  const requestOrigin = normalizeHttpUrl(input.requestOrigin);
  const candidateSeed: string[] = [];
  const seen = new Set<string>();

  pushCandidateUnique(candidateSeed, seen, sourceUrl);
  pushCandidateUnique(candidateSeed, seen, sourceFetch.finalUrl || sourceUrl);
  if (sourceFetch.body) {
    for (const candidate of extractCandidatesFromText(sourceFetch.body, sourceFetch.finalUrl || sourceUrl)) {
      pushCandidateUnique(candidateSeed, seen, candidate);
    }

    const playerv2Candidates = await buildPlayerv2Candidates(
      sourceFetch.finalUrl || sourceUrl,
      sourceFetch.body,
      Math.min(timeoutMs, 2600)
    );
    for (const candidate of playerv2Candidates) {
      pushCandidateUnique(candidateSeed, seen, candidate);
    }
  }
  for (const nested of extractCandidatesFromQueryParams(sourceUrl)) {
    const normalized = normalizeCandidate(nested, sourceUrl);
    if (normalized) pushCandidateUnique(candidateSeed, seen, normalized);
  }

  const internalProxy = buildInternalEmbedProxyUrl({
    sourceUrl,
    requestOrigin,
    referrerUrl: input.referrerUrl || sourceUrl,
  });
  if (internalProxy) pushCandidateUnique(candidateSeed, seen, internalProxy);

  const rankedSeed = rankCandidates(candidateSeed, sourceUrl, maxCandidates);
  if (!rankedSeed.length) {
    return emptyResolution("no-ingest-candidate", {
      stage: "candidate-probe",
      candidatesFound: 0,
      candidatesProbed: 0,
      rejectReason: "no-ingest-candidate",
      resolverState: "no-candidate",
    });
  }

  const pending = [...rankedSeed];
  const seenProbeKeys = new Set<string>();
  let candidatesProbed = 0;
  let lastProbeReason = "probe-failed";
  let lastEvidence: RepackIngestResolution["probeEvidence"] = null;

  while (pending.length && candidatesProbed < maxCandidates) {
    const item = pending.shift();
    if (!item) continue;
    const key = canonicalizeUrl(item.candidateUrl) || item.candidateUrl.toLowerCase();
    if (!key || seenProbeKeys.has(key)) continue;
    seenProbeKeys.add(key);

    candidatesProbed += 1;
    const probe = await probeCandidate({
      candidateUrl: item.candidateUrl,
      timeoutMs,
      segmentTimeoutMs,
    });
    if (probe.ok) {
      return {
        mode: item.mode,
        ingestUrl: item.candidateUrl,
        reason: item.mode === "backend_proxy_ingest" ? "resolved-proxy-candidate" : "resolved-direct-candidate",
        resolver: {
          stage: "done",
          candidatesFound: rankedSeed.length,
          candidatesProbed,
          selectedCandidate: item.candidateUrl,
          selectedKind: item.mode,
          rejectReason: "",
          resolverState: "ok",
        },
        probeEvidence: probe.evidence,
      };
    }

    lastProbeReason = probe.reason || "probe-failed";
    lastEvidence = probe.evidence;
    if (!probe.extraCandidates.length) continue;

    const extraPool: string[] = [];
    for (const extra of probe.extraCandidates) {
      const normalized = normalizeCandidate(extra, item.candidateUrl);
      if (!normalized) continue;
      const extraKey = canonicalizeUrl(normalized) || normalized.toLowerCase();
      if (!extraKey || seenProbeKeys.has(extraKey) || seen.has(extraKey)) continue;
      seen.add(extraKey);
      extraPool.push(normalized);
      if (extraPool.length >= MAX_DYNAMIC_CANDIDATES) break;
    }
    if (!extraPool.length) continue;
    const rankedExtra = rankCandidates(extraPool, sourceUrl, Math.max(2, maxCandidates - candidatesProbed));
    pending.push(...rankedExtra);
  }

  const resolverState: RepackResolverState = rankedSeed.length ? "probe-failed" : "no-candidate";
  return {
    mode: "none",
    ingestUrl: null,
    reason: resolverState === "no-candidate" ? "no-ingest-candidate" : "probe-failed",
    resolver: {
      stage: "done",
      candidatesFound: rankedSeed.length,
      candidatesProbed,
      selectedCandidate: null,
      selectedKind: "none",
      rejectReason: lastProbeReason || "probe-failed",
      resolverState,
    },
    probeEvidence: lastEvidence,
  };
}
