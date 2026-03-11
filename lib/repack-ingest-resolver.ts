import { isValidHttpUrl, type SlotServerId } from "./server-source-policy";
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
    referrerUrl?: string | null;
  } | null;
};

type ResolveRepackIngestInput = {
  sourceUrl: string;
  requestOrigin: string;
  slotServerId?: SlotServerId;
  preferProxyIngest?: boolean;
  referrerUrl?: string | null;
  timeoutMs?: number;
  maxCandidates?: number;
  allowCandidate?: (input: { candidateUrl: string; referrerUrl: string }) => boolean;
};

type FetchResult = {
  ok: boolean;
  status: number;
  finalUrl: string;
  contentType: string;
  body: string;
};

type SourcePageVariant = {
  pageUrl: string;
  via: "raw" | "proxy";
  referrerUrl: string;
  fetch: FetchResult;
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

type Playerv2Config = {
  paths: string[];
  domains: string[];
  randomCandidates: string[];
};

const DEFAULT_TIMEOUT_MS = 5200;
const DEFAULT_SEGMENT_TIMEOUT_MS = 2200;
const DEFAULT_MAX_CANDIDATES = 32;
const MAX_DYNAMIC_CANDIDATES = 64;
const MAX_ALBA_EXPAND_PAGES = 12;
const MAX_ALBA_EXPAND_DEPTH = 2;
const DEFAULT_RESOLVER_USER_AGENT =
  "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/141.0.0.0 Safari/537.36";
const PLAYERV2_FALLBACK_DOMAINS = [
  "https://1rxolmirvosixpyfy.yallashot.us/",
  "https://jqyjghfms1mu8zc.yallashot.us/",
];
const PLAYERV2_ALLOW_SESSION_ID_ONLY =
  String(process.env.REPACK_PLAYERV2_ALLOW_SESSION_ID_ONLY || "0").trim() === "1";

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

function normalizeHtmlForScan(html: string) {
  return String(html || "")
    .replace(/&amp;/gi, "&")
    .replace(/\\u0026/gi, "&")
    .replace(/\\u002f/gi, "/")
    .replace(/\\\//g, "/");
}

function ensureTrailingSlash(raw?: string | null) {
  const value = String(raw || "").trim();
  if (!value || !isValidHttpUrl(value)) return "";
  return value.endsWith("/") ? value : `${value}/`;
}

function normalizePlayerv2Path(raw?: string | null) {
  let value = String(raw || "").trim();
  if (!value) return "";
  if (isValidHttpUrl(value)) {
    try {
      const u = new URL(value);
      value = `${u.pathname}${u.search}`.replace(/^\/+/, "");
    } catch {
      return "";
    }
  }
  value = value.replace(/^\/+/, "").split("?")[0].split("#")[0];
  if (value.endsWith(".m3u8")) value = value.slice(0, -5);
  if (!value) return "";
  if (!value.startsWith("kooora/")) value = `kooora/${value}`;
  return value.replace(/\/{2,}/g, "/");
}

function buildPlayerv2NonceCandidates() {
  const alphabet = "abcdefghijklmnopqrstuvwxyzABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789";
  const pick = (length: number) => {
    let out = "";
    for (let idx = 0; idx < length; idx += 1) out += alphabet[Math.floor(Math.random() * alphabet.length)] || "x";
    return out;
  };
  const base36 = (length: number) => {
    let out = "";
    while (out.length < length) out += Math.random().toString(36).slice(2);
    return out.slice(0, length);
  };
  return Array.from(new Set([base36(6), pick(6), pick(8)])).filter(Boolean);
}

function buildPlayerv2FingerprintCandidates() {
  const alphabet = "abcdefghijklmnopqrstuvwxyzABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789";
  const pick = (length: number) => {
    let out = "";
    for (let idx = 0; idx < length; idx += 1) out += alphabet[Math.floor(Math.random() * alphabet.length)] || "x";
    return out;
  };
  return Array.from(new Set([pick(6), pick(8), pick(10), "abc123"])).filter(Boolean);
}

function decodeBase64ToText(raw: string) {
  let value = String(raw || "").trim();
  if (!value) return "";
  value = value.replace(/\s+/g, "").replace(/-/g, "+").replace(/_/g, "/");
  if (!/^[A-Za-z0-9+/=]+$/.test(value)) return "";
  if (value.length % 4) value = `${value}${"=".repeat(4 - (value.length % 4))}`;
  try {
    return Buffer.from(value, "base64").toString("utf8").trim();
  } catch {
    return "";
  }
}

function isBeinLiveMatchPageUrl(rawUrl: string) {
  if (!isValidHttpUrl(rawUrl)) return false;
  try {
    const u = new URL(rawUrl);
    const host = u.hostname.toLowerCase();
    const pathname = String(u.pathname || "").toLowerCase();
    return (host === "bein-live.com" || host.endsWith(".bein-live.com")) && pathname.includes("/matches/");
  } catch {
    return false;
  }
}

function isLivehdTvPageUrl(rawUrl: string) {
  if (!isValidHttpUrl(rawUrl)) return false;
  try {
    const u = new URL(rawUrl);
    const host = u.hostname.toLowerCase();
    const pathname = String(u.pathname || "").toLowerCase();
    return (host === "livehd77.pro" || host.endsWith(".livehd77.pro")) && /^\/tv\/[^/?#]+\/?$/.test(pathname);
  } catch {
    return false;
  }
}

function expandLivehdTvServVariants(rawUrl: string) {
  if (!isLivehdTvPageUrl(rawUrl)) return [] as string[];
  try {
    const u = new URL(rawUrl);
    const out: string[] = [];
    for (const serv of ["0", "1"]) {
      const next = new URL(u.toString());
      next.searchParams.set("serv", serv);
      out.push(next.toString());
    }
    return Array.from(new Set(out));
  } catch {
    return [] as string[];
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
    if (/^\/(?:author|category|tag)\//i.test(pathname)) return true;
    if (/\/page\/\d+\/?$/i.test(pathname) && !/\/(?:tv|live|stream|player|playlist|manifest|hls|albaplayer|playerv2)\//i.test(pathname)) {
      return true;
    }
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
  if (!/^[A-Za-z0-9+/_=-]+$/.test(token)) return "";
  let normalized = token.replace(/-/g, "+").replace(/_/g, "/");
  if (normalized.length % 4) normalized = `${normalized}${"=".repeat(4 - (normalized.length % 4))}`;
  try {
    const decoded = Buffer.from(normalized, "base64").toString("utf8").trim();
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

  const albaControlRe = /AlbaPlayerControl\s*\(\s*['"]([A-Za-z0-9+/_=-]{20,})['"]\s*,/gi;
  for (const match of text.matchAll(albaControlRe)) {
    pushDecoded(String(match[1] || ""));
  }

  const atobRe = /atob\(\s*['"]([A-Za-z0-9+/_=-]{20,})['"]\s*\)/gi;
  for (const match of text.matchAll(atobRe)) {
    pushDecoded(String(match[1] || ""));
  }

  const longBase64Re = /['"]([A-Za-z0-9+/_=-]{40,})['"]/g;
  for (const match of text.matchAll(longBase64Re)) {
    pushDecoded(String(match[1] || ""));
    if (out.size >= 24) break;
  }

  return Array.from(out);
}

function reverseText(value: string) {
  return Array.from(String(value || "")).reverse().join("");
}

function extractRepairedAlbaHeartbeatCandidates(rawUrl: string) {
  const out = new Set<string>();
  if (!isValidHttpUrl(rawUrl)) return [] as string[];
  try {
    const u = new URL(rawUrl);
    const combined = `${String(u.pathname || "")}${String(u.search || "")}`.toLowerCase();
    if (!combined.includes("rellortnoc-taebtraeh") && !combined.includes("=nekot")) return [] as string[];

    const tokenRaw =
      (String(u.pathname || "").match(/\/albaplayer\/[^/?#]+\/([a-z0-9]{12,})=nekot(?:[/?#]|$)/i) || [])[1] || "";
    if (!tokenRaw) return [] as string[];

    const token = reverseText(tokenRaw);
    if (!/^[a-z0-9]{12,}$/i.test(token)) return [] as string[];

    const heartbeatPaths = [
      "/wp-content/plugins/AlbaPlayer/assets/js/heartbeat-controller.php",
      "/wp-content/plugins/albaplayer/assets/js/heartbeat-controller.php",
    ];
    for (const heartbeatPath of heartbeatPaths) {
      const repaired = `${u.origin}${heartbeatPath}?token=${encodeURIComponent(token)}`;
      if (isValidHttpUrl(repaired)) out.add(repaired);
    }
  } catch {}
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

    // Some Alba pages emit reversed heartbeat URLs; repair them so resolver can
    // probe the real token endpoint instead of a guaranteed 404 target.
    for (const repaired of extractRepairedAlbaHeartbeatCandidates(candidate)) {
      out.add(repaired);
    }

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
  const hlsPathRe = /\/hls\/[a-z0-9_-]+\/(?:master\.m3u8|index\.m3u8|live\/index\.m3u8)/gi;
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

function buildPlayerv2ChannelFallbackCandidates(sourceUrl: string) {
  try {
    const u = new URL(sourceUrl);
    const pathname = String(u.pathname || "").toLowerCase();
    if (!pathname.includes("/playerv2.php")) return [] as string[];
    const matchRaw = String(u.searchParams.get("match") || "").trim();
    const num = Number.parseInt((matchRaw.match(/\d+/) || [])[0] || "", 10);
    if (!Number.isFinite(num) || num <= 0) return [] as string[];
    const channel = `ch${num}`;
    const hosts = [
      "aaa.yallaliveshoot.online",
      "aaa.yallaliveshoot.info",
      "aaa.yallashoooootlive.online",
      "aaa.yallashoooootlive.info",
      "aaa.kora-live-live.info",
    ];
    return hosts.map((host) => `https://${host}/hls/${channel}/live/index.m3u8`);
  } catch {
    return [] as string[];
  }
}

function normalizeDomainPrefix(rawDomain: string, baseUrl: string) {
  const value = String(rawDomain || "").trim().replace(/\\\//g, "/");
  if (!value) return "";
  const normalized = normalizeCandidate(value, baseUrl);
  if (!normalized) return "";
  return normalized.replace(/\/+$/, "");
}

function extractPlayerv2ConfigFromHtml(html: string, pageUrl: string): Playerv2Config {
  const text = normalizeHtmlForScan(html);
  const paths = new Set<string>();
  const domains = new Set<string>();
  const randomCandidates = new Set<string>();

  const bootstrap = extractPlayerv2Bootstrap(text);
  if (bootstrap) {
    for (const path of bootstrap.paths) paths.add(path);
    for (const domain of bootstrap.activeDomains) {
      const normalized = ensureTrailingSlash(domain);
      if (normalized) domains.add(normalized);
    }
    for (const candidate of bootstrap.randomCandidates) {
      const normalized = normalizeCandidate(candidate, pageUrl);
      if (normalized) randomCandidates.add(normalized);
    }
  }

  for (const match of text.matchAll(/data-(?:mobile-)?path=["']([^"']+)["']/gi)) {
    const value = String(match[1] || "").trim();
    if (value) paths.add(value);
  }

  const linkRe =
    /<a\b[^>]*(?:class=["'][^"']*(?:tablinks|servers_list)[^"']*["'][^>]*)?(?:href=["']([^"']+)["'])?[^>]*(?:data-(?:mobile-)?path=["']([^"']+)["'])?[^>]*>/gi;
  for (const match of text.matchAll(linkRe)) {
    const hrefValue = String(match[1] || "").trim();
    const dataPathValue = String(match[2] || "").trim();
    if (dataPathValue) paths.add(dataPathValue);
    if (!hrefValue || /^javascript:/i.test(hrefValue)) continue;
    const normalizedHref = normalizeCandidate(hrefValue, pageUrl);
    if (!normalizedHref) continue;
    try {
      const hrefUrl = new URL(normalizedHref);
      const pathCandidate = normalizePlayerv2Path(`${hrefUrl.pathname}${hrefUrl.search}`);
      if (pathCandidate) paths.add(pathCandidate);
      randomCandidates.add(hrefUrl.toString());
      const origin = ensureTrailingSlash(hrefUrl.origin);
      if (origin) domains.add(origin);
    } catch {}
  }

  let pageHost = "";
  try {
    const u = new URL(pageUrl);
    pageHost = String(u.hostname || "").toLowerCase();
    const origin = ensureTrailingSlash(u.origin);
    if (origin) domains.add(origin);
  } catch {}

  if (pageHost.endsWith("yallashot.us")) {
    for (const fallback of PLAYERV2_FALLBACK_DOMAINS) {
      const normalized = ensureTrailingSlash(fallback);
      if (normalized) domains.add(normalized);
    }
  }

  for (const candidate of randomCandidates) {
    try {
      const u = new URL(candidate);
      const origin = ensureTrailingSlash(u.origin);
      if (origin) domains.add(origin);
      const pathCandidate = normalizePlayerv2Path(`${u.pathname}${u.search}`);
      if (pathCandidate) paths.add(pathCandidate);
    } catch {}
  }

  return {
    paths: Array.from(paths).map((item) => normalizePlayerv2Path(item)).filter(Boolean),
    domains: Array.from(domains),
    randomCandidates: Array.from(randomCandidates),
  };
}

function extractEmbedProxyTargetUrl(rawUrl: string) {
  if (!isValidHttpUrl(rawUrl)) return "";
  try {
    const u = new URL(rawUrl);
    const pathname = String(u.pathname || "").toLowerCase();
    if (!pathname.includes("/api/embed-proxy")) return "";
    const targetRaw = safeDecodeURIComponent(String(u.searchParams.get("url") || "").trim());
    return normalizeHttpUrl(targetRaw);
  } catch {
    return "";
  }
}

function looksLikePlayerv2PageUrl(rawUrl: string) {
  if (!isValidHttpUrl(rawUrl)) return false;
  try {
    const u = new URL(rawUrl);
    return String(u.pathname || "").toLowerCase().includes("/playerv2.php");
  } catch {
    return false;
  }
}

function looksLikePlayerv2Html(html: string) {
  const text = normalizeHtmlForScan(html).toLowerCase();
  return (
    text.includes("window.tabsconfig") ||
    text.includes("playerv2.php?action=generate_token") ||
    text.includes("data-mobile-path=") ||
    text.includes("data-path=") ||
    text.includes("albaplayer_name")
  );
}

function resolvePlayerv2ContextUrl(rawUrl: string, referrerUrl?: string) {
  for (const value of [
    normalizeHttpUrl(rawUrl),
    extractEmbedProxyTargetUrl(rawUrl),
    extractEmbedProxyReferrer(rawUrl),
    normalizeHttpUrl(referrerUrl || ""),
  ]) {
    if (looksLikePlayerv2PageUrl(value)) return value;
  }
  return "";
}

async function requestPlayerv2TokenViaProxy(input: {
  playerv2Url: string;
  pathValue: string;
  timeoutMs: number;
  requestOrigin: string;
}) {
  const endpoint = (() => {
    try {
      return new URL("/playerv2.php?action=generate_token", input.playerv2Url).toString();
    } catch {
      return "";
    }
  })();
  if (!endpoint) return null as { token: string; sessionId: string } | null;

  const proxyEndpoint = buildInternalEmbedProxyUrl({
    sourceUrl: endpoint,
    requestOrigin: input.requestOrigin,
    referrerUrl: input.playerv2Url,
  });
  if (!proxyEndpoint) return null as { token: string; sessionId: string } | null;

  const payloads = [
    ...buildPlayerv2FingerprintCandidates().map((fp) => new URLSearchParams({ path: input.pathValue, fp }).toString()),
    new URLSearchParams({ path: input.pathValue }).toString(),
  ];

  for (const payload of payloads) {
    const controller = new AbortController();
    const timeoutId = setTimeout(() => controller.abort(), Math.max(800, input.timeoutMs));
    try {
      const response = await fetch(proxyEndpoint, {
        method: "POST",
        cache: "no-store",
        redirect: "follow",
        signal: controller.signal,
        headers: {
          "content-type": "application/x-www-form-urlencoded; charset=UTF-8",
          "x-requested-with": "XMLHttpRequest",
          "user-agent": DEFAULT_RESOLVER_USER_AGENT,
        },
        body: payload,
      });
      const text = await response.text();
      let json: unknown = null;
      try {
        json = text ? JSON.parse(text) : null;
      } catch {}
      const parsed = json as { token?: string | number; session_id?: string | number } | null;
      const token = parsed?.token != null ? String(parsed.token).trim() : "";
      const sessionId = parsed?.session_id != null ? String(parsed.session_id).trim() : "";
      if (token && sessionId) return { token, sessionId };
    } catch {
    } finally {
      clearTimeout(timeoutId);
    }
  }

  return null as { token: string; sessionId: string } | null;
}

function extractBeinAjaxContext(html: string, sourceUrl: string) {
  const text = normalizeHtmlForScan(html);
  const matchId =
    (text.match(/\balba-ajax-servers-container\b[^>]*data-match-id=['"](\d+)['"]/i)?.[1] ||
      text.match(/\bmatch_id['"]?\s*[:=]\s*['"]?(\d+)['"]?/i)?.[1] ||
      "").trim();
  const ajaxUrlRaw =
    (text.match(/\bAlbaAjax\s*=\s*\{\s*["']ajax_url["']\s*:\s*["']([^"']+)["']/i)?.[1] || "").trim();
  const ajaxUrl = normalizeCandidate(ajaxUrlRaw, sourceUrl) || (() => {
    try {
      return new URL("/wp-admin/admin-ajax.php", sourceUrl).toString();
    } catch {
      return "";
    }
  })();
  return {
    matchId,
    ajaxUrl,
  };
}

function extractBeinAjaxCandidates(html: string, sourceUrl: string) {
  const text = normalizeHtmlForScan(html);
  const out = new Set<string>();
  const pushResolved = (raw: unknown) => {
    const candidate = normalizeCandidate(raw, sourceUrl);
    if (candidate) out.add(candidate);
  };
  const pushMaybeBase64 = (raw: unknown) => {
    const decoded = decodeBase64ToText(String(raw || "").trim());
    if (decoded) pushResolved(decoded);
  };

  for (const match of text.matchAll(/\bdata-vload=['"]([^"']+)['"]/gi)) pushMaybeBase64(match[1]);
  for (const match of text.matchAll(/\bdata-id=['"]([^"']+)['"]/gi)) pushMaybeBase64(match[1]);
  for (const match of text.matchAll(/\b(?:data-initial|data-url|src|data-src|href)=['"]([^"']+)['"]/gi)) pushResolved(match[1]);
  for (const candidate of extractCandidatesFromText(text, sourceUrl)) pushResolved(candidate);

  return Array.from(out);
}

async function fetchBeinAjaxResolvedCandidates(sourceUrl: string, sourceHtml: string, timeoutMs: number) {
  if (!isBeinLiveMatchPageUrl(sourceUrl)) return [] as string[];
  const ctx = extractBeinAjaxContext(sourceHtml, sourceUrl);
  if (!ctx.matchId || !ctx.ajaxUrl) return [] as string[];

  const controller = new AbortController();
  const timeoutId = setTimeout(() => controller.abort(), Math.max(1200, timeoutMs));
  try {
    const response = await fetch(ctx.ajaxUrl, {
      method: "POST",
      cache: "no-store",
      redirect: "follow",
      signal: controller.signal,
      headers: {
        accept: "text/html,application/xhtml+xml,*/*",
        "content-type": "application/x-www-form-urlencoded; charset=UTF-8",
        "user-agent": DEFAULT_RESOLVER_USER_AGENT,
        referer: sourceUrl,
        origin: safeOrigin(sourceUrl),
        "x-requested-with": "XMLHttpRequest",
      },
      body: new URLSearchParams({
        action: "load_match_servers",
        match_id: ctx.matchId,
      }).toString(),
    });
    if (!response.ok) return [] as string[];
    const html = await response.text();
    return extractBeinAjaxCandidates(html, sourceUrl);
  } catch {
    return [] as string[];
  } finally {
    clearTimeout(timeoutId);
  }
}

function extractPlayerv2Bootstrap(html: string) {
  const text = String(html || "");
  const match = text.match(/window\.tabsConfig\s*=\s*(\{[\s\S]*?\})\s*;/i);
  if (!match?.[1]) return null as { paths: string[]; activeDomains: string[]; randomCandidates: string[] } | null;
  try {
    const raw = String(match[1] || "").replace(/\\\//g, "/");
    const parsed = JSON.parse(raw) as {
      tabs?: Array<{ path?: string; mobile_path?: string }>;
      activeDomains?: string[];
      random_links?: string[];
      random_pools?: Record<string, string[]>;
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
    const randomCandidates = new Set<string>();
    const randomLinks = Array.isArray(parsed?.random_links) ? parsed.random_links : [];
    for (const item of randomLinks) {
      const value = String(item || "").trim();
      if (value) randomCandidates.add(value);
    }
    const randomPools = parsed?.random_pools && typeof parsed.random_pools === "object" ? parsed.random_pools : {};
    for (const entries of Object.values(randomPools)) {
      if (!Array.isArray(entries)) continue;
      for (const item of entries) {
        const value = String(item || "").trim();
        if (value) randomCandidates.add(value);
      }
    }
    if (!paths.size) return null;
    return {
      paths: Array.from(paths),
      activeDomains,
      randomCandidates: Array.from(randomCandidates),
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

async function buildPlayerv2Candidates(sourceUrl: string, html: string, timeoutMs: number, requestOrigin: string) {
  const config = extractPlayerv2ConfigFromHtml(html, sourceUrl);
  if (!config.paths.length || !config.domains.length) {
    const fallbackOnly = buildPlayerv2ChannelFallbackCandidates(sourceUrl).filter((candidate) => isValidHttpUrl(candidate));
    const seeded = [...fallbackOnly, ...config.randomCandidates.filter((candidate) => isValidHttpUrl(candidate))];
    return Array.from(new Set(seeded));
  }

  const out: string[] = [];
  const pushCandidate = (raw: string) => {
    if (!isValidHttpUrl(raw)) return;
    out.push(raw);
  };

  for (const fallbackCandidate of buildPlayerv2ChannelFallbackCandidates(sourceUrl)) {
    pushCandidate(fallbackCandidate);
  }
  for (const seededCandidate of config.randomCandidates) {
    pushCandidate(seededCandidate);
    if (requestOrigin) {
      const proxied = buildInternalEmbedProxyUrl({
        sourceUrl: seededCandidate,
        requestOrigin,
        referrerUrl: sourceUrl,
      });
      if (proxied) pushCandidate(proxied);
    }
  }

  const maxPaths = Math.min(4, config.paths.length);
  for (const rawPath of config.paths.slice(0, maxPaths)) {
    const pathValue = normalizePlayerv2Path(rawPath);
    if (!pathValue) continue;

    const tokenViaProxy = requestOrigin
      ? await requestPlayerv2TokenViaProxy({
          playerv2Url: sourceUrl,
          pathValue,
          timeoutMs: Math.max(1200, timeoutMs),
          requestOrigin,
        })
      : null;
    const token =
      tokenViaProxy ||
      (await requestPlayerv2Token({
        tokenEndpoint: (() => {
          try {
            const source = new URL(sourceUrl);
            return new URL("/playerv2.php?action=generate_token", `${source.protocol}//${source.host}`).toString();
          } catch {
            return "";
          }
        })(),
        pathValue,
        timeoutMs: Math.max(1200, timeoutMs),
        sourceUrl,
      }));
    if (!token) continue;

    const ts = String(Math.floor(Date.now() / 1000));
    const nonces = buildPlayerv2NonceCandidates();
    const basePath = pathValue.replace(/\.m3u8$/i, "");
    const pathVariants = Array.from(new Set([basePath, `${basePath}.m3u8`]));

    for (const domain of config.domains.slice(0, 4).map((item) => normalizeDomainPrefix(item, sourceUrl)).filter(Boolean)) {
      for (const variantPath of pathVariants) {
        let absolute = "";
        try {
          absolute = new URL(variantPath.replace(/^\/+/, ""), ensureTrailingSlash(domain) || domain).toString();
        } catch {
          continue;
        }
        for (const nonce of nonces) {
          const queryVariants = [
            // Keep sid as the primary auth key for yallashot/playerv2.
            new URLSearchParams({ ts, nonce, token: token.token, sid: token.sessionId, session_id: token.sessionId }).toString(),
            new URLSearchParams({ ts, nonce, token: token.token, sid: token.sessionId }).toString(),
          ];
          if (PLAYERV2_ALLOW_SESSION_ID_ONLY) {
            queryVariants.push(new URLSearchParams({ ts, nonce, token: token.token, session_id: token.sessionId }).toString());
          }
          for (const query of queryVariants) {
            const directUrl = `${absolute}?${query}`;
            pushCandidate(directUrl);
            if (requestOrigin) {
              const proxied = buildInternalEmbedProxyUrl({
                sourceUrl: directUrl,
                requestOrigin,
                referrerUrl: sourceUrl,
              });
              if (proxied) pushCandidate(proxied);
            }
          }
        }
      }
    }
  }

  const deduped = new Set<string>();
  const result: string[] = [];
  for (const candidate of out) {
    const key = canonicalizeUrl(candidate) || candidate.toLowerCase();
    if (!key || deduped.has(key)) continue;
    deduped.add(key);
    result.push(candidate);
  }
  return result;
}

async function fetchEmbeddedPlayerv2ResolvedCandidates(input: {
  pageUrl: string;
  pageHtml: string;
  timeoutMs: number;
  requestOrigin: string;
}) {
  const out = new Set<string>();
  const seedCandidates = extractCandidatesFromText(input.pageHtml, input.pageUrl);
  const playerv2Pages = Array.from(
    new Set(
      seedCandidates
        .map((candidate) => normalizeHttpUrl(candidate))
        .filter((candidate) => looksLikePlayerv2PageUrl(candidate) || looksLikePlayerv2PageUrl(extractEmbedProxyTargetUrl(candidate)))
    )
  ).slice(0, 4);

  for (const rawPageUrl of playerv2Pages) {
    const playerv2PageUrl = extractEmbedProxyTargetUrl(rawPageUrl) || rawPageUrl;
    if (!looksLikePlayerv2PageUrl(playerv2PageUrl)) continue;
    const fetched = await fetchWithTimeout(playerv2PageUrl, Math.min(input.timeoutMs, 2600), {
      referer: input.pageUrl,
      origin: safeOrigin(input.pageUrl),
    });
    if (!fetched.ok || !shouldExtractCandidatesFromBody(fetched.contentType, fetched.body)) continue;
    const candidates = await buildPlayerv2Candidates(
      playerv2PageUrl,
      fetched.body,
      Math.min(input.timeoutMs, 2400),
      input.requestOrigin
    );
    for (const candidate of candidates) out.add(candidate);
  }

  return Array.from(out);
}

async function fetchSourcePageVariants(input: {
  sourceUrl: string;
  sourceFetch: FetchResult;
  requestOrigin: string;
  referrerUrl?: string | null;
  timeoutMs: number;
  slotServerId?: SlotServerId;
}) {
  const out: SourcePageVariant[] = [];
  const seen = new Set<string>();
  const baseReferrer = normalizeHttpUrl(input.referrerUrl || input.sourceUrl) || input.sourceUrl;

  const pushVariant = (pageUrl: string, via: SourcePageVariant["via"], referrerUrl: string, fetch: FetchResult) => {
    const safePageUrl = normalizeHttpUrl(pageUrl);
    const safeReferrer = normalizeHttpUrl(referrerUrl) || baseReferrer;
    if (!safePageUrl) return;
    const key = `${via}:${canonicalizeUrl(safePageUrl) || safePageUrl.toLowerCase()}`;
    if (!key || seen.has(key)) return;
    seen.add(key);
    out.push({
      pageUrl: safePageUrl,
      via,
      referrerUrl: safeReferrer,
      fetch,
    });
  };

  pushVariant(input.sourceUrl, "raw", baseReferrer, input.sourceFetch);

  const queueFetch = async (pageUrl: string, via: SourcePageVariant["via"], referrerUrl: string) => {
    const safePageUrl = normalizeHttpUrl(pageUrl);
    const safeReferrer = normalizeHttpUrl(referrerUrl) || baseReferrer;
    if (!safePageUrl) return;
    const key = `${via}:${canonicalizeUrl(safePageUrl) || safePageUrl.toLowerCase()}`;
    if (!key || seen.has(key)) return;
    const fetched = await fetchWithTimeout(safePageUrl, Math.min(input.timeoutMs, 3000), {
      referer: safeReferrer,
      origin: safeOrigin(safeReferrer),
    });
    pushVariant(safePageUrl, via, safeReferrer, fetched);
  };

  if (isValidHttpUrl(input.requestOrigin)) {
    const proxiedSourcePage = buildInternalEmbedProxyUrl({
      sourceUrl: input.sourceUrl,
      requestOrigin: input.requestOrigin,
      referrerUrl: baseReferrer,
      backendMode: true,
    });
    if (proxiedSourcePage) {
      await queueFetch(proxiedSourcePage, "proxy", baseReferrer);
    }

    const shouldAddPlaybackProxyVariant =
      input.slotServerId === 2 ||
      looksLikePlayerv2PageUrl(input.sourceUrl) ||
      looksLikePlayerv2PageUrl(input.sourceFetch.finalUrl || input.sourceUrl) ||
      looksLikePlayerv2Html(input.sourceFetch.body);
    if (shouldAddPlaybackProxyVariant) {
      const proxiedPlaybackPage = buildInternalEmbedProxyUrl({
        sourceUrl: input.sourceUrl,
        requestOrigin: input.requestOrigin,
        referrerUrl: baseReferrer,
        backendMode: false,
        stableMode: true,
      });
      if (proxiedPlaybackPage) {
        await queueFetch(proxiedPlaybackPage, "proxy", baseReferrer);
      }
    }
  }

  if (input.slotServerId === 3) {
    const livehdVariants = Array.from(
      new Set([
        ...expandLivehdTvServVariants(input.sourceUrl),
        ...expandLivehdTvServVariants(input.sourceFetch.finalUrl || input.sourceUrl),
      ])
    ).slice(0, 4);
    for (const variantUrl of livehdVariants) {
      await queueFetch(variantUrl, "raw", baseReferrer);
      if (isValidHttpUrl(input.requestOrigin)) {
        const proxiedVariant = buildInternalEmbedProxyUrl({
          sourceUrl: variantUrl,
          requestOrigin: input.requestOrigin,
          referrerUrl: baseReferrer,
          backendMode: true,
        });
        if (proxiedVariant) await queueFetch(proxiedVariant, "proxy", baseReferrer);
      }
    }
  }

  return out;
}

function buildInternalEmbedProxyUrl(input: {
  sourceUrl: string;
  requestOrigin: string;
  referrerUrl?: string | null;
  backendMode?: boolean;
  stableMode?: boolean;
}) {
  if (!isValidHttpUrl(input.requestOrigin)) return "";
  const params = new URLSearchParams();
  params.set("url", input.sourceUrl);
  params.set("depth", "0");
  if (input.backendMode !== false) params.set("backend", "1");
  if (input.stableMode === true) params.set("stable", "1");
  const ref = normalizeHttpUrl(input.referrerUrl || input.sourceUrl);
  if (ref) params.set("ref", ref);
  return `${String(input.requestOrigin || "").replace(/\/+$/, "")}/api/embed-proxy?${params.toString()}`;
}

function shouldPreferProxyResolvedIngest(input: {
  sourceUrl: string;
  candidateUrl: string;
  referrerUrl?: string | null;
  requestOrigin?: string | null;
}) {
  if (!isValidHttpUrl(String(input.requestOrigin || "").trim())) return false;
  if (!isValidHttpUrl(input.candidateUrl) || !isValidHttpUrl(input.sourceUrl)) return false;
  try {
    const source = new URL(input.sourceUrl);
    const candidate = new URL(input.candidateUrl);
    const referrer = isValidHttpUrl(String(input.referrerUrl || "").trim())
      ? new URL(String(input.referrerUrl || "").trim())
      : null;
    const sourceHost = source.hostname.toLowerCase();
    const candidateHost = candidate.hostname.toLowerCase();
    const referrerHost = referrer?.hostname?.toLowerCase() || "";

    if (sourceHost !== candidateHost) return true;
    if (referrerHost && referrerHost !== candidateHost) return true;
    if (isBeinLiveMatchPageUrl(input.sourceUrl)) return true;
    if (looksLikePlayerv2PageUrl(input.sourceUrl)) return true;
    if (isLikelyAlbaLandingUrl(input.sourceUrl)) return true;
    if (/\/tv\/[^/?#]+\/?$/i.test(String(source.pathname || ""))) return true;
    return false;
  } catch {
    return false;
  }
}

function shouldWrapCandidateForInternalProxy(candidateUrl: string, sourceUrl: string) {
  if (!isValidHttpUrl(candidateUrl)) return false;
  try {
    const candidate = new URL(candidateUrl);
    const source = new URL(sourceUrl);
    const pathname = String(candidate.pathname || "").toLowerCase();
    if (pathname.includes("/api/embed-proxy")) return false;
    if (candidate.hostname.toLowerCase() !== source.hostname.toLowerCase()) return true;
    if (looksLikeHlsManifestUrl(candidateUrl)) return true;
    return (
      pathname.includes("/albaplayer/") ||
      pathname.includes("/playerv2.php") ||
      pathname.includes("/embed") ||
      pathname.includes("/player") ||
      pathname.includes("/hls/") ||
      pathname.includes("/live/") ||
      pathname.includes("/manifest/") ||
      pathname.includes("/stream/")
    );
  } catch {
    return false;
  }
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

function finalizeSuccessfulResolution(input: {
  sourceUrl: string;
  selectedCandidateUrl: string;
  stage: ResolverStage;
  candidatesFound: number;
  candidatesProbed: number;
  probe: ProbeResult;
  requestOrigin: string;
  sourceReferrerUrl: string;
  preferProxyIngest?: boolean;
}) {
  const selectedCandidateUrl = String(input.selectedCandidateUrl || "").trim();
  const selectedIsProxy = isEmbedProxyCandidateUrl(selectedCandidateUrl);
  const effectiveIngestUrl = selectedIsProxy
    ? selectedCandidateUrl
    : isValidHttpUrl(String(input.probe.evidence?.playlistUrl || "").trim())
      ? String(input.probe.evidence?.playlistUrl || "").trim()
      : selectedCandidateUrl;
  const stableReferrer = normalizeHttpUrl(input.sourceReferrerUrl || input.sourceUrl) || input.sourceUrl;
  const effectiveIsProxy = selectedIsProxy || isEmbedProxyCandidateUrl(effectiveIngestUrl);
  const finalIngestUrl = effectiveIngestUrl;
  const finalMode = effectiveIsProxy ? "backend_proxy_ingest" : classifyMode(finalIngestUrl);
  return {
    mode: finalMode,
    ingestUrl: finalIngestUrl,
    reason: finalMode === "backend_proxy_ingest" ? "resolved-proxy-candidate" : "resolved-direct-candidate",
    resolver: {
      stage: input.stage,
      candidatesFound: input.candidatesFound,
      candidatesProbed: input.candidatesProbed,
      selectedCandidate: finalIngestUrl,
      selectedKind: finalMode,
      rejectReason: "",
      resolverState: "ok" as const,
    },
    probeEvidence: input.probe.evidence ? { ...input.probe.evidence, referrerUrl: stableReferrer } : null,
  } satisfies RepackIngestResolution;
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
        if (looksLikeHlsManifestUrl(target)) score += 180;
        try {
          const tu = new URL(target);
          const tPath = String(tu.pathname || "").toLowerCase();
          const tHost = tu.hostname.toLowerCase();
          if ((tHost.endsWith(".yallashot.us") || tHost === "yallashot.us") && tPath.includes("/kooora/")) {
            score += 420;
          }
          if ((tHost === "showchop.net" || tHost.endsWith(".showchop.net")) && tPath.includes("/embed/")) score += 180;
          if (tu.port === "8443" && tPath.includes(".m3u8")) score += 240;
          if (tHost.endsWith(".58103793.net") || tHost.endsWith(".77911050.net")) score += 180;
          if (tPath.includes("/albaplayer/") && !looksLikeHlsManifestUrl(target)) score -= 220;
        } catch {}
      }
      if (search.includes("depth=2") || search.includes("depth=3") || search.includes("depth=4")) score -= 45;
      if (search.includes("stable=1")) score += 22;
    }
    if (pathname.includes("/hls/") || pathname.includes("/live/") || pathname.includes("/manifest/")) score += 80;
    if (pathname.includes("/albaplayer/")) score += 160;
    if (pathname.includes("/player/")) score += 60;
    if (pathname.includes("/go.php")) score += 48;
    if (pathname.includes("/chtv/")) score += 52;
    if (pathname.startsWith("/tv/")) score += 72;
    if (search.includes("serv=0")) score += 220;
    if (search.includes("serv=1")) score -= 60;
    if (search.includes("serv=")) score += 26;
    if (search.includes("stream=")) score += 34;
    if (search.includes("token=") || search.includes("session") || search.includes("playlist")) score += 45;
    if (search.includes("sid=")) score += 65;
    if (u.port === "8443" && combined.includes(".m3u8")) score += 210;
    if (u.hostname.toLowerCase().endsWith(".58103793.net") || u.hostname.toLowerCase().endsWith(".77911050.net")) score += 170;
    if (u.hostname.toLowerCase().includes("baranewssumsel.online")) score += 210;
    if (u.hostname.toLowerCase().endsWith("amazonaws.com") && combined.includes("/hls/") && combined.includes(".m3u8")) score += 320;
    if (pathname.includes("heartbeat-controller.php")) score -= 280;
    if ((u.hostname.toLowerCase() === "showchop.net" || u.hostname.toLowerCase().endsWith(".showchop.net")) && pathname.includes("/embed/")) {
      score += 140;
    }
    if (u.hostname.toLowerCase() === sourceHost) score += 28;
    if (u.hostname.toLowerCase().endsWith(`.${sourceHost}`)) score += 18;
    if (u.hostname.toLowerCase() === sourceHost && !hasStreamishPath && !combined.includes("serv=")) score -= 45;
    if (pathname.startsWith("/matches/") || pathname.startsWith("/home_")) score -= 65;
    if (isYallashotKoooraDirect) {
      const hasSid = search.includes("sid=");
      const hasSessionId = search.includes("session_id=");
      if (hasSid) score += 160;
      if (hasSessionId && !hasSid) score -= 420;
      if (hasSessionId && hasSid) score += 50;
      if (search.includes("token=") && !hasSid) score -= 260;
      if (pathname.endsWith(".m3u8")) score -= 140;
    }
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
    if (![401, 403, 405, 406].includes(head.status)) return { ok: false, status: head.status };

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

function shouldRetryProtectedCandidateViaProxy(reason: string) {
  return /^(?:playlist|segment|variant)-http-(?:0|401|403|406|429|5\d{2})$/i.test(String(reason || "").trim());
}

function canSoftAcceptProtectedSegmentProbe(input: {
  candidateUrl: string;
  reason: string;
  evidence?: ProbeResult["evidence"] | null;
  mode: RepackIngestMode;
}) {
  if (input.mode !== "backend_proxy_ingest") return false;
  if (!/^segment-http-(?:401|403)$/i.test(String(input.reason || "").trim())) return false;
  const playlistStatus = Number.parseInt(String(input.evidence?.playlistStatus || 0), 10) || 0;
  if (playlistStatus < 200 || playlistStatus >= 300) return false;
  const targetUrl = extractEmbedProxyTargetUrl(input.candidateUrl) || input.candidateUrl;
  if (!isValidHttpUrl(targetUrl)) return false;
  try {
    const u = new URL(targetUrl);
    const host = u.hostname.toLowerCase();
    const pathname = String(u.pathname || "").toLowerCase();
    if ((host.endsWith(".yallashot.us") || host === "yallashot.us") && pathname.includes("/kooora/")) return false;
    if (pathname.includes("/albaplayer/")) return true;
    if (host.includes("yallashoot") || host.includes("yallalive")) return true;
  } catch {}
  return false;
}

async function probeCandidate(input: {
  candidateUrl: string;
  timeoutMs: number;
  segmentTimeoutMs: number;
  referrerUrl?: string;
  requestOrigin?: string;
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
    const playerv2ContextUrl = resolvePlayerv2ContextUrl(
      fetched.finalUrl || input.candidateUrl,
      input.referrerUrl || input.candidateUrl
    );
    if (input.requestOrigin && playerv2ContextUrl && looksLikePlayerv2Html(fetched.body)) {
      const playerv2Candidates = await buildPlayerv2Candidates(
        playerv2ContextUrl,
        fetched.body,
        Math.min(input.timeoutMs, 2600),
        input.requestOrigin
      );
      extraCandidates.unshift(...playerv2Candidates);
    }
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
  let finalPlaylistUrl = fetched.finalUrl || input.candidateUrl;
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
    finalPlaylistUrl = childFetched.finalUrl || segmentUrl;
    finalPlaylistStatus = childFetched.status || fetched.status;
    finalContentType = childFetched.contentType || fetched.contentType;
  }

  const segmentProbe = await probeSegmentUrl(finalSegmentUrl, input.segmentTimeoutMs, fetchHeaders);
  if (!segmentProbe.ok) {
    return {
      ok: false,
      reason: `segment-http-${segmentProbe.status || 0}`,
      evidence: {
        playlistUrl: finalPlaylistUrl,
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
      playlistUrl: finalPlaylistUrl,
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

function isCandidateAllowedByPolicy(
  allowCandidate: ResolveRepackIngestInput["allowCandidate"],
  candidateUrl: string,
  referrerUrl: string
) {
  if (typeof allowCandidate !== "function") return true;
  try {
    return allowCandidate({
      candidateUrl,
      referrerUrl,
    });
  } catch {
    return false;
  }
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

function isEmbedProxyCandidateUrl(rawUrl: string) {
  if (!isValidHttpUrl(rawUrl)) return false;
  try {
    const pathname = String(new URL(rawUrl).pathname || "").toLowerCase();
    return pathname.includes("/api/embed-proxy");
  } catch {
    return false;
  }
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
  const preferProxyIngest = input.preferProxyIngest !== false;
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
    const allowedDirectSource = isCandidateAllowedByPolicy(input.allowCandidate, sourceUrl, sourceUrl);
    const directProbe = await probeCandidate({
      candidateUrl: sourceUrl,
      timeoutMs,
      segmentTimeoutMs,
      referrerUrl: sourceUrl,
      requestOrigin: input.requestOrigin,
    });
    if (directProbe.ok && allowedDirectSource) {
      return finalizeSuccessfulResolution({
        sourceUrl,
        selectedCandidateUrl: sourceUrl,
        stage: "source-direct",
        candidatesFound: 1,
        candidatesProbed: 1,
        probe: directProbe,
        requestOrigin: input.requestOrigin,
        sourceReferrerUrl: sourceUrl,
        preferProxyIngest,
      });
    }
  }

  if (sourceFetch.ok && isLikelyManifestResponse(sourceFetch.contentType, sourceFetch.body, sourceFetch.finalUrl || sourceUrl)) {
    const servedUrl = sourceFetch.finalUrl || sourceUrl;
    const allowedServedSource = isCandidateAllowedByPolicy(input.allowCandidate, servedUrl, servedUrl);
    const servedProbe = await probeCandidate({
      candidateUrl: servedUrl,
      timeoutMs,
      segmentTimeoutMs,
      referrerUrl: servedUrl,
      requestOrigin: input.requestOrigin,
    });
    if (servedProbe.ok && allowedServedSource) {
      return finalizeSuccessfulResolution({
        sourceUrl,
        selectedCandidateUrl: servedUrl,
        stage: "source-fetch",
        candidatesFound: 1,
        candidatesProbed: 1,
        probe: servedProbe,
        requestOrigin: input.requestOrigin,
        sourceReferrerUrl: sourceFetch.finalUrl || sourceUrl,
        preferProxyIngest,
      });
    }
  }

  const requestOrigin = normalizeHttpUrl(input.requestOrigin);
  const candidateSeed: string[] = [];
  const seen = new Set<string>();
  const sourceVariants = await fetchSourcePageVariants({
    sourceUrl,
    sourceFetch,
    requestOrigin,
    referrerUrl: input.referrerUrl || sourceUrl,
    timeoutMs,
    slotServerId: input.slotServerId,
  });

  pushCandidateUnique(candidateSeed, seen, sourceUrl);
  pushCandidateUnique(candidateSeed, seen, sourceFetch.finalUrl || sourceUrl);
  for (const variant of sourceVariants) {
    const sourceBaseUrl = variant.fetch.finalUrl || variant.pageUrl || sourceUrl;
    if (variant.fetch.ok && isLikelyManifestResponse(variant.fetch.contentType, variant.fetch.body, sourceBaseUrl)) {
      pushCandidateUnique(candidateSeed, seen, sourceBaseUrl);
    }

    const shouldUseHtmlExtraction = shouldExtractCandidatesFromBody(variant.fetch.contentType, variant.fetch.body);
    const extractedCandidates = shouldUseHtmlExtraction ? extractCandidatesFromText(variant.fetch.body, sourceBaseUrl) : [];
    for (const candidate of extractedCandidates) {
      pushCandidateUnique(candidateSeed, seen, candidate);
      if (requestOrigin && shouldWrapCandidateForInternalProxy(candidate, sourceBaseUrl)) {
        const proxied = buildInternalEmbedProxyUrl({
          sourceUrl: candidate,
          requestOrigin,
          referrerUrl: variant.referrerUrl || sourceBaseUrl,
        });
        if (proxied) pushCandidateUnique(candidateSeed, seen, proxied);
      }
    }

    if (input.slotServerId === 1 || isBeinLiveMatchPageUrl(sourceBaseUrl)) {
      const beinAjaxCandidates = await fetchBeinAjaxResolvedCandidates(
        sourceBaseUrl,
        variant.fetch.body,
        Math.min(timeoutMs, 3200)
      );
      for (const candidate of beinAjaxCandidates) {
        pushCandidateUnique(candidateSeed, seen, candidate);
        if (requestOrigin && shouldWrapCandidateForInternalProxy(candidate, sourceBaseUrl)) {
          const proxied = buildInternalEmbedProxyUrl({
            sourceUrl: candidate,
            requestOrigin,
            referrerUrl: variant.referrerUrl || sourceBaseUrl,
          });
          if (proxied) pushCandidateUnique(candidateSeed, seen, proxied);
        }
      }
    }

    const shouldUsePlayerv2Flow =
      input.slotServerId === 2 || looksLikePlayerv2PageUrl(sourceBaseUrl) || looksLikePlayerv2Html(variant.fetch.body);
    if (shouldUsePlayerv2Flow) {
      const playerv2Candidates = await buildPlayerv2Candidates(
        sourceBaseUrl,
        variant.fetch.body,
        Math.min(timeoutMs, 2600),
        requestOrigin
      );
      for (const candidate of playerv2Candidates) {
        pushCandidateUnique(candidateSeed, seen, candidate);
      }

      if (requestOrigin) {
        const embeddedPlayerv2Candidates = await fetchEmbeddedPlayerv2ResolvedCandidates({
          pageUrl: sourceBaseUrl,
          pageHtml: variant.fetch.body,
          timeoutMs: Math.min(timeoutMs, 2800),
          requestOrigin,
        });
        for (const candidate of embeddedPlayerv2Candidates) {
          pushCandidateUnique(candidateSeed, seen, candidate);
        }
      }
    }
  }
  for (const nested of extractCandidatesFromQueryParams(sourceUrl)) {
    const normalized = normalizeCandidate(nested, sourceUrl);
    if (normalized) pushCandidateUnique(candidateSeed, seen, normalized);
  }

  type AlbaQueueItem = { url: string; depth: number; referrerUrl: string };
  const albaQueue: AlbaQueueItem[] = [];
  const albaQueued = new Set<string>();
  const albaVisited = new Set<string>();
  const enqueueAlbaLanding = (rawUrl: string, depth: number, referrerUrl: string) => {
    const normalized = normalizeHttpUrl(rawUrl);
    if (!normalized) return;
    const target = extractEmbedProxyTargetUrl(normalized) || normalized;
    if (!isLikelyAlbaLandingUrl(target)) return;
    const key = canonicalizeUrl(target) || target.toLowerCase();
    if (!key || albaQueued.has(key) || albaVisited.has(key)) return;
    albaQueued.add(key);
    albaQueue.push({
      url: target,
      depth,
      referrerUrl: normalizeHttpUrl(referrerUrl || sourceFetch.finalUrl || sourceUrl) || sourceFetch.finalUrl || sourceUrl,
    });
  };

  for (const candidate of candidateSeed) {
    enqueueAlbaLanding(candidate, 0, sourceFetch.finalUrl || sourceUrl);
    if (albaQueue.length >= MAX_ALBA_EXPAND_PAGES) break;
  }

  while (albaQueue.length && albaVisited.size < MAX_ALBA_EXPAND_PAGES) {
    const next = albaQueue.shift();
    if (!next) continue;
    const key = canonicalizeUrl(next.url) || next.url.toLowerCase();
    if (!key || albaVisited.has(key)) continue;
    albaVisited.add(key);

    const albaFetched = await fetchWithTimeout(next.url, Math.min(timeoutMs, 2600), {
      referer: normalizeHttpUrl(next.referrerUrl || sourceFetch.finalUrl || sourceUrl) || sourceFetch.finalUrl || sourceUrl,
    });
    if (!albaFetched.ok || !isLikelyHtmlResponse(albaFetched.contentType, albaFetched.body)) continue;
    const albaReferrer = normalizeHttpUrl(albaFetched.finalUrl || next.url) || next.url;
    const proxyReferrer =
      normalizeHttpUrl(albaReferrer) ||
      normalizeHttpUrl(sourceFetch.finalUrl || sourceUrl) ||
      normalizeHttpUrl(sourceUrl);

    for (const derived of extractCandidatesFromText(albaFetched.body, albaReferrer)) {
      pushCandidateUnique(candidateSeed, seen, derived);
      if (requestOrigin && isValidHttpUrl(derived)) {
        const proxied = buildInternalEmbedProxyUrl({
          sourceUrl: derived,
          requestOrigin,
          referrerUrl: proxyReferrer,
        });
        if (proxied) pushCandidateUnique(candidateSeed, seen, proxied);
      }
      if (next.depth < MAX_ALBA_EXPAND_DEPTH) {
        enqueueAlbaLanding(derived, next.depth + 1, albaReferrer);
      }
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

  const rankedSeedPool = rankCandidates(
    candidateSeed,
    sourceUrl,
    Math.min(192, Math.max(maxCandidates, maxCandidates * 4)),
    sourceFetch.finalUrl || sourceUrl
  );
  const policyFilteredSeed = rankedSeedPool
    .filter((item) => isCandidateAllowedByPolicy(input.allowCandidate, item.candidateUrl, item.referrerUrl))
    .slice(0, maxCandidates);
  if (!policyFilteredSeed.length) {
    return emptyResolution("no-ingest-candidate", {
      stage: "candidate-probe",
      candidatesFound: rankedSeedPool.length,
      candidatesProbed: 0,
      rejectReason: "no-ingest-candidate",
      resolverState: "no-candidate",
    });
  }

  const pending: RankedCandidate[] = [...policyFilteredSeed];
  const seenProbeKeys = new Set<string>();
  let candidatesProbed = 0;
  let lastProbeReason = "probe-failed";
  let lastEvidence: RepackIngestResolution["probeEvidence"] = null;
  let softAcceptedResult: RepackIngestResolution | null = null;

  while (pending.length && candidatesProbed < maxCandidates) {
    const item = pending.shift();
    if (!item) continue;
    if (!isCandidateAllowedByPolicy(input.allowCandidate, item.candidateUrl, item.referrerUrl)) continue;
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
        requestOrigin,
      });
      if (probe.ok) {
        return finalizeSuccessfulResolution({
          sourceUrl,
          selectedCandidateUrl: item.candidateUrl,
          stage: "done",
          candidatesFound: rankedSeedPool.length,
          candidatesProbed,
          probe,
          requestOrigin,
          sourceReferrerUrl: item.referrerUrl || referrerUrl || sourceFetch.finalUrl || sourceUrl,
          preferProxyIngest,
        });
      }
      finalProbe = pickBetterProbeFailure(finalProbe, probe);
      if (probe.extraCandidates.length) aggregatedExtraCandidates.push(...probe.extraCandidates);
    }

    if (!finalProbe) continue;
    const stableSourceReferrer =
      normalizeHttpUrl(item.referrerUrl || sourceFetch.finalUrl || sourceUrl) || sourceUrl;
    const extraCandidateReferrer = normalizeHttpUrl(finalProbe.evidence?.playlistUrl || "") || stableSourceReferrer;
    if (canSoftAcceptProtectedSegmentProbe({
      candidateUrl: item.candidateUrl,
      reason: finalProbe.reason,
      evidence: finalProbe.evidence,
      mode: item.mode,
    })) {
      if (!softAcceptedResult) {
        softAcceptedResult = {
          mode: item.mode,
          ingestUrl: item.candidateUrl,
          reason: "resolved-proxy-candidate-soft",
          resolver: {
            stage: "done",
            candidatesFound: rankedSeedPool.length,
            candidatesProbed,
            selectedCandidate: item.candidateUrl,
            selectedKind: item.mode,
            rejectReason: "soft-accepted-protected-segment",
            resolverState: "probe-failed",
          },
          probeEvidence: finalProbe.evidence
            ? { ...finalProbe.evidence, referrerUrl: stableSourceReferrer }
            : null,
        };
      }
    }
    lastProbeReason = finalProbe.reason || "probe-failed";
    lastEvidence = finalProbe.evidence;
    if (
      requestOrigin &&
      item.mode !== "backend_proxy_ingest" &&
      !isEmbedProxyCandidateUrl(item.candidateUrl) &&
      shouldRetryProtectedCandidateViaProxy(lastProbeReason)
    ) {
      const proxiedCandidate = buildInternalEmbedProxyUrl({
        sourceUrl: item.candidateUrl,
        requestOrigin,
        referrerUrl: stableSourceReferrer,
      });
      if (proxiedCandidate) {
        const proxyKey = canonicalizeUrl(proxiedCandidate) || proxiedCandidate.toLowerCase();
        if (proxyKey && !seenProbeKeys.has(proxyKey) && !seen.has(proxyKey)) {
          seen.add(proxyKey);
          pending.unshift({
            candidateUrl: proxiedCandidate,
            score: item.score + 500,
            mode: "backend_proxy_ingest",
            referrerUrl: stableSourceReferrer,
          });
        }
      }
    }
    if (!aggregatedExtraCandidates.length) continue;

    const immediateManifestExtras: RankedCandidate[] = [];
    const extraPool: string[] = [];
    const pushImmediateManifest = (candidateUrl: string, referrerUrl: string) => {
      const key = canonicalizeUrl(candidateUrl) || candidateUrl.toLowerCase();
      if (!key || seenProbeKeys.has(key) || seen.has(key)) return;
      if (!isCandidateAllowedByPolicy(input.allowCandidate, candidateUrl, referrerUrl)) return;
      seen.add(key);
      immediateManifestExtras.push({
        candidateUrl,
        score: Number.MAX_SAFE_INTEGER - immediateManifestExtras.length,
        mode: classifyMode(candidateUrl),
        referrerUrl: normalizeHttpUrl(referrerUrl) || candidateUrl,
      });
    };

    for (const extra of aggregatedExtraCandidates) {
      const normalized = normalizeCandidate(extra, item.candidateUrl);
      if (!normalized) continue;
      if (!isCandidateAllowedByPolicy(input.allowCandidate, normalized, extraCandidateReferrer)) continue;
      const extraKey = canonicalizeUrl(normalized) || normalized.toLowerCase();
      if (!extraKey || seenProbeKeys.has(extraKey) || seen.has(extraKey)) continue;
      if (looksLikeHlsManifestUrl(normalized)) {
        pushImmediateManifest(normalized, extraCandidateReferrer);
        if (requestOrigin && !isEmbedProxyCandidateUrl(normalized)) {
          const proxiedManifest = buildInternalEmbedProxyUrl({
            sourceUrl: normalized,
            requestOrigin,
            referrerUrl: extraCandidateReferrer,
          });
          if (proxiedManifest) {
            pushImmediateManifest(proxiedManifest, extraCandidateReferrer);
          }
        }
        if (immediateManifestExtras.length >= 8) continue;
      }
      seen.add(extraKey);
      extraPool.push(normalized);
      if (extraPool.length >= MAX_DYNAMIC_CANDIDATES) break;
    }
    if (immediateManifestExtras.length) {
      pending.unshift(...immediateManifestExtras);
    }
    if (extraPool.length) {
      const rankedExtra = rankCandidates(
        extraPool,
        sourceUrl,
        Math.max(2, maxCandidates - candidatesProbed),
        extraCandidateReferrer
      );
      pending.push(...rankedExtra);
    }
  }

  if (softAcceptedResult) {
    return softAcceptedResult;
  }

  const resolverState: RepackResolverState = rankedSeedPool.length ? "probe-failed" : "no-candidate";
  return {
    mode: "none",
    ingestUrl: null,
    reason: resolverState === "no-candidate" ? "no-ingest-candidate" : "probe-failed",
    resolver: {
      stage: "done",
      candidatesFound: rankedSeedPool.length,
      candidatesProbed,
      selectedCandidate: null,
      selectedKind: "none",
      rejectReason: lastProbeReason || "probe-failed",
      resolverState,
    },
    probeEvidence: lastEvidence,
  };
}
