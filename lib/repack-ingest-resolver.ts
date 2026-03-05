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

type RankedCandidate = {
  candidateUrl: string;
  score: number;
  mode: RepackIngestMode;
  referrerUrl: string;
};

const DEFAULT_TIMEOUT_MS = 5200;
const DEFAULT_SEGMENT_TIMEOUT_MS = 2200;
const DEFAULT_MAX_CANDIDATES = 32;
const MAX_DYNAMIC_CANDIDATES = 64;
const DEFAULT_RESOLVER_USER_AGENT =
  "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/141.0.0.0 Safari/537.36";

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

function safeOrigin(value: string) {
  if (!isValidHttpUrl(value)) return "";
  try {
    return new URL(value).origin;
  } catch {
    return "";
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

const NOISE_HOST_SUFFIXES = [
  "ogp.me",
  "schema.org",
  "gmpg.org",
  "w3.org",
  "w3schools.com",
  "gravatar.com",
  "facebook.com",
  "twitter.com",
  "instagram.com",
  "youtube.com",
  "ytimg.com",
  "tiktok.com",
  "googletagmanager.com",
  "google-analytics.com",
  "histats.com",
  "boldgrid.com",
  "wprediscache.com",
  "jsdelivr.net",
  "cloudflareinsights.com",
];

function hostMatchesSuffix(hostname: string, suffixes: string[]) {
  const host = String(hostname || "").trim().toLowerCase().replace(/\.$/, "");
  if (!host) return false;
  return suffixes.some((suffix) => host === suffix || host.endsWith(`.${suffix}`));
}

function isKnownNoiseCandidateUrl(rawUrl: string, depth = 0): boolean {
  if (depth > 2) return false;
  if (!isValidHttpUrl(rawUrl)) return true;
  try {
    const u = new URL(rawUrl);
    const host = u.hostname.toLowerCase();
    const pathname = String(u.pathname || "").toLowerCase();
    if (pathname.includes("/api/embed-proxy")) {
      const targetRaw = safeDecodeURIComponent(String(u.searchParams.get("url") || "").trim());
      if (!targetRaw) return true;
      if (!isValidHttpUrl(targetRaw)) return true;
      return isKnownNoiseCandidateUrl(targetRaw, depth + 1);
    }
    if (hostMatchesSuffix(host, NOISE_HOST_SUFFIXES)) return true;
    if (looksLikeNonStreamAssetPath(pathname)) return true;
    if (pathname === "/" && !u.search) {
      if (!/live|stream|player|hls|playlist|m3u8|albaplayer|playerv2/i.test(host)) return true;
    }
    return false;
  } catch {
    return true;
  }
}

function looksLikeHlsManifestUrl(raw: string) {
  if (!isValidHttpUrl(raw)) return false;
  try {
    const u = new URL(raw);
    const pathname = String(u.pathname || "").toLowerCase();
    const search = String(u.search || "").toLowerCase();
    const combined = `${pathname}${search}`;
    if (looksLikeNonStreamAssetPath(pathname)) return false;
    if (/\.(?:ts|m4s|m4a|mp4|aac|mp3|vtt)(?:$|[?#])/i.test(pathname)) return false;
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
      search.includes("stream=") ||
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

function shouldExtractCandidatesFromBody(contentType: string, body: string) {
  if (!body) return false;
  const ct = String(contentType || "").toLowerCase();
  if (isLikelyHtmlResponse(ct, body)) return true;
  if (ct.includes("javascript") || ct.includes("ecmascript")) return true;
  if (ct.includes("text/plain") || ct.includes("application/json")) return true;
  return /^[\s\[{("']*(?:https?:\/\/|var\s+|const\s+|let\s+|function\b)/i.test(String(body || ""));
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

function decodeMaybeBase64Url(raw: string, baseUrl: string) {
  const token = String(raw || "")
    .trim()
    .replace(/\\x3d/gi, "=")
    .replace(/\s+/g, "");
  if (!token || token.length < 20 || token.length > 8000) return "";
  if (!/^[A-Za-z0-9+/=]+$/.test(token)) return "";
  if (token.length % 4 !== 0) return "";
  try {
    const decoded = Buffer.from(token, "base64").toString("utf8").trim();
    return normalizeCandidate(decoded, baseUrl);
  } catch {
    return "";
  }
}

function extractBase64ManifestCandidates(text: string, baseUrl: string) {
  const out = new Set<string>();
  const pushDecoded = (raw: string) => {
    const candidate = decodeMaybeBase64Url(raw, baseUrl);
    if (!candidate || !isValidHttpUrl(candidate)) return;
    out.add(candidate);
  };

  const albaControlRe = /AlbaPlayerControl\s*\(\s*['"]([A-Za-z0-9+/=]{20,})['"]\s*,/gi;
  for (const match of text.matchAll(albaControlRe)) {
    pushDecoded(String(match[1] || ""));
  }

  const atobRe = /atob\(\s*['"]([A-Za-z0-9+/=]{20,})['"]\s*\)/gi;
  for (const match of text.matchAll(atobRe)) {
    pushDecoded(String(match[1] || ""));
  }

  const longBase64Re = /['"]([A-Za-z0-9+/=]{40,})['"]/g;
  for (const match of text.matchAll(longBase64Re)) {
    pushDecoded(String(match[1] || ""));
    if (out.size >= 24) break;
  }

  return Array.from(out);
}

function decodeTokenInBase(raw: string, base: number) {
  if (!raw || base < 2 || base > 62) return -1;
  const alphabet = "0123456789abcdefghijklmnopqrstuvwxyzABCDEFGHIJKLMNOPQRSTUVWXYZ";
  let value = 0;
  for (const ch of raw) {
    const idx = alphabet.indexOf(ch);
    if (idx < 0 || idx >= base) return -1;
    value = value * base + idx;
  }
  return Number.isFinite(value) ? value : -1;
}

function unpackDeanPackerPayloads(text: string) {
  const out: string[] = [];
  const packedEvalRe =
    /eval\(function\(p,a,c,k,e,d\)\{[\s\S]*?\}\('((?:\\'|[^'])*)',\s*(\d+),\s*(\d+),\s*'((?:\\'|[^'])*)'\.split\('\|'\),\s*0,\s*\{\}\)\)/gi;
  for (const match of text.matchAll(packedEvalRe)) {
    const payload = String(match[1] || "").replace(/\\'/g, "'");
    const base = Number.parseInt(String(match[2] || "0"), 10);
    const count = Number.parseInt(String(match[3] || "0"), 10);
    const dict = String(match[4] || "").replace(/\\'/g, "'").split("|");
    if (!payload || !Number.isFinite(base) || base < 2 || base > 62 || !Number.isFinite(count) || count <= 0) continue;
    const unpacked = payload.replace(/\b[0-9A-Za-z]+\b/g, (token) => {
      const idx = decodeTokenInBase(token, base);
      if (idx >= 0 && idx < count && idx < dict.length && dict[idx]) return dict[idx] || token;
      return token;
    });
    if (unpacked) out.push(unpacked);
    if (out.length >= 8) break;
  }
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

  const fieldRe = /(?:file|source|src|hls|url|stream|playlist|streamurl|stream_url)\s*[:=]\s*["']([^"']+)["']/gi;
  for (const match of normalized.matchAll(fieldRe)) {
    push(match[1]);
  }

  for (const candidate of extractBase64ManifestCandidates(normalized, baseUrl)) {
    push(candidate);
  }

  const jsonFieldRe =
    /"(?:file|source|src|hls|url|stream|playlist|streamUrl|stream_url)"\s*:\s*"([^"\\]*(?:\\.[^"\\]*)*)"/gi;
  for (const match of html.matchAll(jsonFieldRe)) {
    const decoded = safeDecodeURIComponent(String(match[1] || "").replace(/\\\//g, "/"));
    push(decoded);
  }

  const embedProxyPathRe = /\/api\/embed-proxy\?[^\s"'<>`\\)]+/gi;
  for (const match of normalized.matchAll(embedProxyPathRe)) {
    push(match[0]);
  }

  const dynamicAlbaManifestCandidates = extractAlbaDynamicManifestCandidates(normalized, baseUrl);
  for (const candidate of dynamicAlbaManifestCandidates) {
    push(candidate);
  }

  for (const unpacked of unpackDeanPackerPayloads(normalized)) {
    for (const match of unpacked.matchAll(absoluteUrlRe)) {
      push(match[0]);
    }
    for (const match of unpacked.matchAll(fieldRe)) {
      push(match[1]);
    }
    for (const candidate of extractBase64ManifestCandidates(unpacked, baseUrl)) {
      push(candidate);
    }
  }

  return Array.from(out);
}

function extractAlbaDynamicManifestCandidates(text: string, baseUrl: string) {
  const out = new Set<string>();
  const sourceHost = (() => {
    try {
      return new URL(baseUrl).hostname.toLowerCase();
    } catch {
      return "";
    }
  })();
  const sourceSubdomain = (() => {
    const parts = sourceHost.split(".").filter(Boolean);
    if (parts.length < 3) return "";
    return parts[0] || "";
  })();

  const domainPool = new Set<string>();
  const domainListRe = /\bD\s*=\s*\[([^\]]+)\]/gi;
  for (const match of text.matchAll(domainListRe)) {
    const block = String(match[1] || "");
    for (const token of block.matchAll(/["']([^"']+)["']/g)) {
      const host = String(token[1] || "").trim().toLowerCase();
      if (!host || !/^[a-z0-9.-]+\.[a-z]{2,}$/i.test(host)) continue;
      domainPool.add(host);
    }
  }

  if (!domainPool.size) return [] as string[];

  const pathPool = new Set<string>();
  const hlsPathRe = /\/hls\/[a-z0-9_-]+\/live\/index\.m3u8/gi;
  for (const match of text.matchAll(hlsPathRe)) {
    const path = String(match[0] || "").trim();
    if (!path) continue;
    pathPool.add(path.startsWith("/") ? path : `/${path}`);
  }
  if (!pathPool.size) return [] as string[];

  const subdomainPool = new Set<string>();
  if (sourceSubdomain) subdomainPool.add(sourceSubdomain);

  const computeRotatingSubdomain = (tsMs: number) => {
    let v = Math.floor(tsMs / 144e5) + Math.floor((tsMs / 864e5) * 1.5);
    let length = (v % 7) + 6;
    const chars = "abcdefghijklmnopqrstuvwxyz";
    let outValue = "";
    while (length > 0) {
      outValue += chars[v % 26] || "a";
      v = Math.floor(v / 26);
      length -= 1;
    }
    return outValue;
  };
  const now = Date.now();
  for (const offsetHours of [-12, 0, 12]) {
    const dynamic = computeRotatingSubdomain(now + offsetHours * 60 * 60 * 1000);
    if (dynamic) subdomainPool.add(dynamic);
  }

  if (!subdomainPool.size) return [] as string[];

  for (const sub of subdomainPool) {
    for (const domain of domainPool) {
      for (const path of pathPool) {
        const candidate = `https://${sub}.${domain}${path}`;
        if (!isValidHttpUrl(candidate)) continue;
        out.add(candidate);
      }
    }
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
    const fingerprint = randomAlphaNum(10);
    const body = new URLSearchParams();
    body.set("path", input.pathValue);
    body.set("fp", fingerprint);
    const response = await fetch(input.tokenEndpoint, {
      method: "POST",
      cache: "no-store",
      redirect: "follow",
      signal: controller.signal,
      headers: {
        "content-type": "application/x-www-form-urlencoded",
        accept: "application/json,text/plain,*/*",
        "user-agent": DEFAULT_RESOLVER_USER_AGENT,
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
    const pathValue = String(rawPath || "")
      .trim()
      .replace(/^\/+/, "")
      .replace(/\.m3u8$/i, "");
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
      const variants = [`${pathValue}.m3u8`, pathValue];
      for (const variantPath of variants) {
        const finalUrl = `${domain}/${variantPath}?ts=${ts}&nonce=${encodeURIComponent(nonce)}&token=${encodeURIComponent(token.token)}&session_id=${encodeURIComponent(token.sessionId)}`;
        if (isValidHttpUrl(finalUrl)) out.push(finalUrl);
      }
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

function isLikelyAlbaLandingUrl(rawUrl: string) {
  if (!isValidHttpUrl(rawUrl)) return false;
  try {
    const u = new URL(rawUrl);
    const pathname = String(u.pathname || "").toLowerCase();
    if (!pathname.includes("/albaplayer/")) return false;
    if (pathname.includes(".m3u8")) return false;
    return true;
  } catch {
    return false;
  }
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
  if (isKnownNoiseCandidateUrl(rawUrl)) return Number.NEGATIVE_INFINITY;
  let score = 0;
  try {
    const u = new URL(rawUrl);
    const pathname = String(u.pathname || "").toLowerCase();
    const search = String(u.search || "").toLowerCase();
    const combined = `${pathname}${search}`;
    const isYallashotKoooraDirect =
      (u.hostname.toLowerCase().endsWith(".yallashot.us") || u.hostname.toLowerCase() === "yallashot.us") &&
      pathname.includes("/kooora/");

    if (looksLikeNonStreamAssetPath(pathname)) return Number.NEGATIVE_INFINITY;
    if (combined.includes(".mpd")) return Number.NEGATIVE_INFINITY;
    const hasStreamishPath =
      pathname.includes("/hls/") ||
      pathname.includes("/live/") ||
      pathname.includes("/manifest/") ||
      pathname.includes("/albaplayer/") ||
      pathname.includes("/player/") ||
      pathname.includes("/go.php") ||
      pathname.includes("/chtv/");

    if (combined.includes(".m3u8")) score += 220;
    if (pathname.includes("/api/embed-proxy")) {
      score += 40;
      const target = safeDecodeURIComponent(String(u.searchParams.get("url") || "").trim());
      if (isValidHttpUrl(target)) {
        if (looksLikeHlsManifestUrl(target)) score += 120;
        try {
          const tu = new URL(target);
          const tPath = String(tu.pathname || "").toLowerCase();
          const tHost = tu.hostname.toLowerCase();
          if ((tHost.endsWith(".yallashot.us") || tHost === "yallashot.us") && tPath.includes("/kooora/")) {
            score += 240;
          }
        } catch {}
      }
    }
    if (pathname.includes("/hls/") || pathname.includes("/live/") || pathname.includes("/manifest/")) score += 80;
    if (pathname.includes("/albaplayer/")) score += 160;
    if (pathname.includes("/player/")) score += 60;
    if (pathname.includes("/go.php")) score += 48;
    if (pathname.includes("/chtv/")) score += 52;
    if (search.includes("serv=")) score += 26;
    if (search.includes("stream=")) score += 34;
    if (search.includes("token=") || search.includes("session") || search.includes("playlist")) score += 45;
    if (u.hostname.toLowerCase() === sourceHost) score += 28;
    if (u.hostname.toLowerCase().endsWith(`.${sourceHost}`)) score += 18;
    if (u.hostname.toLowerCase() === sourceHost && !hasStreamishPath && !combined.includes("serv=")) score -= 45;
    if (pathname.startsWith("/matches/") || pathname.startsWith("/home_")) score -= 65;
    if (isYallashotKoooraDirect && (search.includes("token=") || search.includes("session_id="))) score -= 140;
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
        "user-agent": DEFAULT_RESOLVER_USER_AGENT,
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

async function probeSegmentUrl(segmentUrl: string, timeoutMs: number, headers?: Record<string, string>) {
  const controller = new AbortController();
  const timeoutId = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const head = await fetch(segmentUrl, {
      method: "HEAD",
      cache: "no-store",
      redirect: "follow",
      signal: controller.signal,
      headers: {
        "user-agent": DEFAULT_RESOLVER_USER_AGENT,
        ...(headers || {}),
      },
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
        "user-agent": DEFAULT_RESOLVER_USER_AGENT,
        ...(headers || {}),
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
  referrerUrl?: string;
}): Promise<ProbeResult> {
  const fetchHeaders: Record<string, string> = {};
  const safeReferer = normalizeHttpUrl(input.referrerUrl || "");
  if (safeReferer) fetchHeaders.referer = safeReferer;
  const origin = safeOrigin(safeReferer);
  if (origin) fetchHeaders.origin = origin;

  const fetched = await fetchWithTimeout(input.candidateUrl, input.timeoutMs, fetchHeaders);
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
    const extraCandidates = shouldExtractCandidatesFromBody(fetched.contentType, fetched.body)
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

  let finalSegmentUrl = segmentUrl;
  let finalPlaylistStatus = fetched.status;
  let finalContentType = fetched.contentType;
  if (looksLikeHlsManifestUrl(segmentUrl)) {
    const childFetched = await fetchWithTimeout(segmentUrl, input.timeoutMs, fetchHeaders);
    if (!childFetched.ok) {
      return {
        ok: false,
        reason: `variant-http-${childFetched.status || 0}`,
        evidence: {
          playlistUrl: childFetched.finalUrl || segmentUrl,
          segmentUrl: null,
          playlistStatus: childFetched.status || 0,
          segmentStatus: 0,
          contentType: childFetched.contentType,
        },
        extraCandidates: [],
      };
    }
    const childManifestLike = isLikelyManifestResponse(
      childFetched.contentType,
      childFetched.body,
      childFetched.finalUrl || segmentUrl
    );
    if (!childManifestLike) {
      return {
        ok: false,
        reason: "variant-non-manifest",
        evidence: {
          playlistUrl: childFetched.finalUrl || segmentUrl,
          segmentUrl: null,
          playlistStatus: childFetched.status || 0,
          segmentStatus: 0,
          contentType: childFetched.contentType,
        },
        extraCandidates: [],
      };
    }
    const childSegment = parseLastSegmentUrl(childFetched.finalUrl || segmentUrl, childFetched.body);
    if (!childSegment) {
      return {
        ok: false,
        reason: "variant-empty",
        evidence: {
          playlistUrl: childFetched.finalUrl || segmentUrl,
          segmentUrl: null,
          playlistStatus: childFetched.status || 0,
          segmentStatus: 0,
          contentType: childFetched.contentType,
        },
        extraCandidates: [],
      };
    }
    finalSegmentUrl = childSegment;
    finalPlaylistStatus = childFetched.status || fetched.status;
    finalContentType = childFetched.contentType || fetched.contentType;
  }

  const segmentProbe = await probeSegmentUrl(finalSegmentUrl, input.segmentTimeoutMs, fetchHeaders);
  if (!segmentProbe.ok) {
    return {
      ok: false,
      reason: `segment-http-${segmentProbe.status || 0}`,
      evidence: {
        playlistUrl: fetched.finalUrl || input.candidateUrl,
        segmentUrl: finalSegmentUrl,
        playlistStatus: finalPlaylistStatus,
        segmentStatus: segmentProbe.status || 0,
        contentType: finalContentType,
      },
      extraCandidates: [],
    };
  }

  return {
    ok: true,
    reason: "manifest+segment-ok",
    evidence: {
      playlistUrl: fetched.finalUrl || input.candidateUrl,
      segmentUrl: finalSegmentUrl,
      playlistStatus: finalPlaylistStatus,
      segmentStatus: segmentProbe.status,
      contentType: finalContentType,
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

function rankCandidates(candidates: string[], sourceUrl: string, maxCandidates: number, referrerUrl: string) {
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
      referrerUrl: normalizeHttpUrl(referrerUrl) || candidateUrl,
    }))
    .filter((item) => Number.isFinite(item.score) && item.score > Number.NEGATIVE_INFINITY)
    .sort((a, b) => b.score - a.score)
    .slice(0, maxCandidates);
}

function extractEmbedProxyReferrer(rawUrl: string) {
  if (!isValidHttpUrl(rawUrl)) return "";
  try {
    const u = new URL(rawUrl);
    const pathname = String(u.pathname || "").toLowerCase();
    if (!pathname.includes("/api/embed-proxy")) return "";
    const refRaw = safeDecodeURIComponent(String(u.searchParams.get("ref") || "").trim());
    if (isValidHttpUrl(refRaw)) return refRaw;
    const targetRaw = safeDecodeURIComponent(String(u.searchParams.get("url") || "").trim());
    if (isValidHttpUrl(targetRaw)) return targetRaw;
    return "";
  } catch {
    return "";
  }
}

function buildProbeReferrerPool(candidateUrl: string, sourceReferrer: string) {
  const out: string[] = [];
  const seen = new Set<string>();
  for (const raw of [
    extractEmbedProxyReferrer(candidateUrl),
    candidateUrl,
    extractEmbedProxyReferrer(sourceReferrer),
    sourceReferrer,
  ]) {
    const value = normalizeHttpUrl(raw);
    if (!value) continue;
    const key = canonicalizeUrl(value) || value.toLowerCase();
    if (!key || seen.has(key)) continue;
    seen.add(key);
    out.push(value);
  }
  return out;
}

function pickBetterProbeFailure(current: ProbeResult | null, next: ProbeResult) {
  if (!current) return next;
  const currentStatus = Number(current.evidence?.playlistStatus || 0);
  const nextStatus = Number(next.evidence?.playlistStatus || 0);
  if (current.reason === "non-manifest" && next.reason !== "non-manifest") return next;
  if (nextStatus > currentStatus) return next;
  if (!current.evidence?.segmentStatus && !!next.evidence?.segmentStatus) return next;
  return current;
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
    8,
    Math.min(
      96,
      Number.parseInt(String(input.maxCandidates || process.env.REPACK_RESOLVE_MAX_CANDIDATES || DEFAULT_MAX_CANDIDATES), 10) ||
        DEFAULT_MAX_CANDIDATES
    )
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
      referrerUrl: sourceUrl,
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
      referrerUrl: sourceFetch.finalUrl || sourceUrl,
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

  const albaLandingCandidates = candidateSeed.filter((candidate) => isLikelyAlbaLandingUrl(candidate)).slice(0, 5);
  for (const albaLandingUrl of albaLandingCandidates) {
    const albaFetched = await fetchWithTimeout(albaLandingUrl, Math.min(timeoutMs, 2600), {
      referer: sourceFetch.finalUrl || sourceUrl,
    });
    if (!albaFetched.ok || !isLikelyHtmlResponse(albaFetched.contentType, albaFetched.body)) continue;
    const albaReferrer = albaFetched.finalUrl || albaLandingUrl;
    for (const derived of extractCandidatesFromText(albaFetched.body, albaReferrer)) {
      pushCandidateUnique(candidateSeed, seen, derived);
      if (!requestOrigin || !isValidHttpUrl(derived)) continue;
      const proxied = buildInternalEmbedProxyUrl({
        sourceUrl: derived,
        requestOrigin,
        referrerUrl: albaReferrer,
      });
      if (proxied) pushCandidateUnique(candidateSeed, seen, proxied);
    }
  }

  for (const candidate of [...candidateSeed]) {
    if (!isValidHttpUrl(candidate) || !requestOrigin) continue;
    try {
      const candidateUrl = new URL(candidate);
      const host = candidateUrl.hostname.toLowerCase();
      const pathname = String(candidateUrl.pathname || "").toLowerCase();
      const isYallashotKooora =
        (host.endsWith(".yallashot.us") || host === "yallashot.us") && pathname.includes("/kooora/");
      if (!isYallashotKooora) continue;
      const proxyWrapped = buildInternalEmbedProxyUrl({
        sourceUrl: candidate,
        requestOrigin,
        referrerUrl: sourceFetch.finalUrl || sourceUrl,
      });
      if (proxyWrapped) pushCandidateUnique(candidateSeed, seen, proxyWrapped);
    } catch {}
  }

  const internalProxy = buildInternalEmbedProxyUrl({
    sourceUrl,
    requestOrigin,
    referrerUrl: input.referrerUrl || sourceUrl,
  });
  if (internalProxy) pushCandidateUnique(candidateSeed, seen, internalProxy);

  const rankedSeed = rankCandidates(candidateSeed, sourceUrl, maxCandidates, sourceFetch.finalUrl || sourceUrl);
  if (!rankedSeed.length) {
    return emptyResolution("no-ingest-candidate", {
      stage: "candidate-probe",
      candidatesFound: 0,
      candidatesProbed: 0,
      rejectReason: "no-ingest-candidate",
      resolverState: "no-candidate",
    });
  }

  const pending: RankedCandidate[] = [...rankedSeed];
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
    const referrerPool = buildProbeReferrerPool(item.candidateUrl, item.referrerUrl || sourceFetch.finalUrl || sourceUrl);
    const aggregatedExtraCandidates: string[] = [];
    let finalProbe: ProbeResult | null = null;

    for (const referrerUrl of referrerPool) {
      const probe = await probeCandidate({
        candidateUrl: item.candidateUrl,
        timeoutMs,
        segmentTimeoutMs,
        referrerUrl,
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
      finalProbe = pickBetterProbeFailure(finalProbe, probe);
      if (probe.extraCandidates.length) aggregatedExtraCandidates.push(...probe.extraCandidates);
    }

    if (!finalProbe) continue;
    lastProbeReason = finalProbe.reason || "probe-failed";
    lastEvidence = finalProbe.evidence;
    if (!aggregatedExtraCandidates.length) continue;

    const extraPool: string[] = [];
    for (const extra of aggregatedExtraCandidates) {
      const normalized = normalizeCandidate(extra, item.candidateUrl);
      if (!normalized) continue;
      const extraKey = canonicalizeUrl(normalized) || normalized.toLowerCase();
      if (!extraKey || seenProbeKeys.has(extraKey) || seen.has(extraKey)) continue;
      seen.add(extraKey);
      extraPool.push(normalized);
      if (extraPool.length >= MAX_DYNAMIC_CANDIDATES) break;
    }
    if (!extraPool.length) continue;
    const rankedExtra = rankCandidates(
      extraPool,
      sourceUrl,
      Math.max(2, maxCandidates - candidatesProbed),
      finalProbe.evidence?.playlistUrl || item.referrerUrl || item.candidateUrl
    );
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
