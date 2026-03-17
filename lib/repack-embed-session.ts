import { isValidHttpUrl, type SlotServerId } from "./server-source-policy";
import {
  buildPlayerv2Candidates,
  expandLivehdTvServVariants,
  extractCandidatesFromText,
  fetchBeinAjaxResolvedCandidates,
  isLikelyAlbaLandingUrl,
  looksLikePlayerv2Html,
  looksLikePlayerv2PageUrl,
} from "./repack-ingest-resolver";

const DEFAULT_USER_AGENT =
  "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/145.0.0.0 Safari/537.36";
const LIVEKORA_FAMILY_BASE_HOSTS = [
  "sportsurges.cc",
  "sportsurges.online",
  "livekora.vip",
  "koooralive.click",
  "kooraxx.com",
] as const;

const ENABLE_LIVE_EMBED_SESSION =
  String(process.env.REPACK_LIVE_EMBED_SESSION_ENABLED || "1").trim() !== "0";
const SESSION_IDLE_TTL_MS = Math.max(
  20_000,
  Number.parseInt(String(process.env.REPACK_LIVE_EMBED_SESSION_IDLE_TTL_MS || "45000"), 10) || 45_000
);
const SESSION_STALE_MS = Math.max(
  4_000,
  Number.parseInt(String(process.env.REPACK_LIVE_EMBED_SESSION_STALE_MS || "18000"), 10) || 18_000
);
const SESSION_PREEMPTIVE_REFRESH_MS = Math.max(
  4_000,
  Math.min(
    SESSION_STALE_MS - 2_000,
    Number.parseInt(String(process.env.REPACK_LIVE_EMBED_SESSION_PREEMPTIVE_REFRESH_MS || "12000"), 10) || 12_000
  )
);
const SESSION_STALE_RETURN_MAX_AGE_MS = Math.max(
  SESSION_STALE_MS + 6_000,
  Number.parseInt(String(process.env.REPACK_LIVE_EMBED_SESSION_STALE_RETURN_MAX_AGE_MS || "42000"), 10) || 42_000
);
const SESSION_WAIT_MS = Math.max(
  2_000,
  Number.parseInt(String(process.env.REPACK_LIVE_EMBED_SESSION_WAIT_MS || "7000"), 10) || 7_000
);
const SESSION_RETRY_WAIT_MS = Math.max(
  1_000,
  Number.parseInt(String(process.env.REPACK_LIVE_EMBED_SESSION_RETRY_WAIT_MS || "2500"), 10) || 2_500
);
const SESSION_NETWORK_IDLE_WAIT_MS = Math.max(
  500,
  Number.parseInt(String(process.env.REPACK_LIVE_EMBED_SESSION_NETWORK_IDLE_WAIT_MS || "1500"), 10) || 1_500
);
const SESSION_RELOAD_COOLDOWN_MS = Math.max(
  2_000,
  Number.parseInt(String(process.env.REPACK_LIVE_EMBED_SESSION_RELOAD_COOLDOWN_MS || "9000"), 10) || 9_000
);
const SESSION_PAGE_FETCH_TIMEOUT_MS = Math.max(
  3_000,
  Number.parseInt(String(process.env.REPACK_LIVE_EMBED_SESSION_PAGE_FETCH_TIMEOUT_MS || "9000"), 10) || 9_000
);
const SESSION_MAX_CRAWL_PAGES = Math.max(
  4,
  Number.parseInt(String(process.env.REPACK_LIVE_EMBED_SESSION_MAX_CRAWL_PAGES || "12"), 10) || 12
);
const SESSION_MAX_CRAWL_DEPTH = Math.max(
  1,
  Number.parseInt(String(process.env.REPACK_LIVE_EMBED_SESSION_MAX_CRAWL_DEPTH || "3"), 10) || 3
);
const SESSION_MAX_COUNT = Math.max(
  2,
  Number.parseInt(String(process.env.REPACK_LIVE_EMBED_SESSION_MAX_COUNT || "4"), 10) || 4
);
const SESSION_MAX_CANDIDATES = Math.max(
  4,
  Number.parseInt(String(process.env.REPACK_LIVE_EMBED_SESSION_MAX_CANDIDATES || "24"), 10) || 24
);
const SESSION_MAINTENANCE_INTERVAL_MS = Math.max(
  1_500,
  Number.parseInt(String(process.env.REPACK_LIVE_EMBED_SESSION_MAINTENANCE_INTERVAL_MS || "4000"), 10) || 4_000
);
const SESSION_NAVIGATION_CONCURRENCY = Math.max(
  1,
  Number.parseInt(String(process.env.REPACK_LIVE_EMBED_SESSION_NAVIGATION_CONCURRENCY || "1"), 10) || 1
);
const PLAYERV2_RUNTIME_CANDIDATE_MAX_AGE_MS = Math.max(
  4_000,
  Number.parseInt(String(process.env.REPACK_PLAYERV2_RUNTIME_CANDIDATE_MAX_AGE_MS || "12000"), 10) || 12_000
);

type SessionCandidate = {
  fetchUrl?: string;
  targetUrl: string;
  referrerUrl: string;
  manifestBody?: string;
  manifestBaseUrl?: string;
  score: number;
  via: "network-manifest" | "network-request" | "dom";
  seenAt: number;
};

type SessionSnapshotResult = {
  ok: boolean;
  playbackUrl: string;
  error: string;
  candidates: SessionCandidate[];
};

type SessionTextResult = {
  ok: boolean;
  status: number;
  contentType: string;
  body: string;
  finalUrl: string;
  error: string;
};

type SessionAssetResult = {
  ok: boolean;
  status: number;
  contentType: string;
  bodyBase64: string;
  error: string;
};

type SessionRuntimeState = {
  key: string;
  state: "starting" | "running" | "closed";
  lastError: string;
  playbackUrl: string;
  lastTouchedAt: number;
  lastActivityAt: number;
  candidateCount: number;
  freshCandidateCount: number;
  freshManifestCount: number;
  runtimePath: string;
  runtimeTabIndex: number | null;
  runtimeSourceIndex: number | null;
  runtimeSourceCount: number;
  runtimeActiveSource: string;
  runtimeSources: string[];
  runtimeUpdatedAt: number;
  runtimeRefreshing: boolean;
  runtimeNetworkRetryCount: number;
  runtimeStallRecoverCount: number;
  runtimeLastProgressAt: number;
  runtimeLastRecoverAt: number;
  runtimeWatchdogState: string;
  lastRefreshReason: string;
  lastRefreshAt: number;
  lastRotateReason: string;
  lastRotateAt: number;
  lastRuntimeEvent: string;
  lastRuntimeEventReason: string;
  lastRuntimeEventAt: number;
  activeManifestUrl: string;
  activeManifestFetchUrl: string;
  activeManifestReferrerUrl: string;
  activeManifestUpdatedAt: number;
  activeMediaSequence: number | null;
  activeTargetDurationSec: number;
  candidates: SessionCandidate[];
};

type PageSeed = {
  pageUrl: string;
  referrerUrl: string;
  depth: number;
};

type PlaywrightBrowser = {
  newContext: (input: unknown) => Promise<PlaywrightContext>;
  close?: () => Promise<void>;
};

type PlaywrightContext = {
  addInitScript?: (script: () => void) => Promise<void>;
  newPage: () => Promise<PlaywrightPage>;
  close: () => Promise<void>;
};

type PlaywrightPage = {
  addInitScript?: (script: () => void) => Promise<void>;
  on: (event: string, handler: (arg: unknown) => void) => void;
  evaluate: <T, Arg = unknown>(pageFunction: string | ((arg: Arg) => T | Promise<T>), arg?: Arg) => Promise<T>;
  goto: (url: string, options: unknown) => Promise<unknown>;
  waitForLoadState?: (state: string, options?: { timeout?: number }) => Promise<void>;
  waitForTimeout: (ms: number) => Promise<void>;
  close: () => Promise<void>;
  isClosed?: () => boolean;
};

let browserPromise: Promise<unknown> | null = null;
let browserInstance: PlaywrightBrowser | null = null;
let browserClosingPromise: Promise<void> | null = null;
let browserCleanupRegistered = false;
let sessionCleanupTimer: ReturnType<typeof setInterval> | null = null;
const sessions = new Map<string, LiveEmbedSession>();
let navigationSlotsInUse = 0;
const navigationSlotWaiters: Array<() => void> = [];

function normalizeHttpUrl(raw: unknown) {
  const value = String(raw || "").trim();
  if (!value || !isValidHttpUrl(value)) return "";
  return value;
}

function dedupeUrls(values: string[]) {
  const out: string[] = [];
  const seen = new Set<string>();
  for (const value of values || []) {
    const normalized = normalizeHttpUrl(value);
    if (!normalized) continue;
    const key = canonicalizeUrl(normalized) || normalized.toLowerCase();
    if (!key || seen.has(key)) continue;
    seen.add(key);
    out.push(normalized);
  }
  return out;
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
    return decodeURIComponent(String(value || ""));
  } catch {
    return String(value || "");
  }
}

function safeOrigin(rawUrl: string) {
  try {
    return new URL(rawUrl).origin;
  } catch {
    return "";
  }
}

function sameOrigin(leftUrl: string, rightUrl: string) {
  if (!isValidHttpUrl(leftUrl) || !isValidHttpUrl(rightUrl)) return false;
  try {
    return new URL(leftUrl).origin === new URL(rightUrl).origin;
  } catch {
    return false;
  }
}

function hostMatchesAnySuffix(hostname: string, suffixes: string[]) {
  const host = String(hostname || "").trim().toLowerCase().replace(/\.$/, "");
  if (!host) return false;
  return suffixes.some((suffix) => host === suffix || host.endsWith(`.${suffix}`));
}

function isSiiirBrowserSensitivePage(rawUrl: string) {
  if (!isValidHttpUrl(rawUrl)) return false;
  try {
    const parsed = new URL(rawUrl);
    const host = parsed.hostname.toLowerCase();
    const pathname = String(parsed.pathname || "").toLowerCase();
    if (!(host === "yallashot.us" || host.endsWith(".yallashot.us"))) return false;
    return pathname.includes("/playerv2.php") || pathname.includes("/hard/");
  } catch {
    return false;
  }
}

function isDirectCrawlPreferred(rawUrl: string) {
  if (!isValidHttpUrl(rawUrl)) return false;
  try {
    const parsed = new URL(rawUrl);
    const host = parsed.hostname.toLowerCase();
    return hostMatchesAnySuffix(host, [...LIVEKORA_FAMILY_BASE_HOSTS]) || isSiiirBrowserSensitivePage(rawUrl);
  } catch {
    return false;
  }
}

function pickPreferredDirectPlaybackUrl(rawUrl: string) {
  if (!isValidHttpUrl(rawUrl)) return rawUrl;
  try {
    const parsed = new URL(rawUrl);
    const host = parsed.hostname.toLowerCase();
    const path = String(parsed.pathname || "").toLowerCase();
    if (!path.includes("/albaplayer/") && !path.includes("/alba.php")) return parsed.toString();
    if (hostMatchesAnySuffix(host, [...LIVEKORA_FAMILY_BASE_HOSTS])) {
      const pathParts = String(parsed.pathname || "")
        .split("/")
        .map((item) => item.trim())
        .filter(Boolean);
      const slug = String(pathParts[0] === "albaplayer" ? pathParts[1] || "" : pathParts[0] || "").trim();
      if (slug) {
        parsed.pathname = `/${slug}/`;
        parsed.search = "";
        return parsed.toString();
      }
    }
    const fallbackServ = path.includes("/ad-sport-2/") ? "5" : "2";
    if (String(parsed.searchParams.get("serv") || "").trim() === fallbackServ) return parsed.toString();
    parsed.searchParams.set("serv", fallbackServ);
    return parsed.toString();
  } catch {
    return rawUrl;
  }
}

function buildSlugVariants(rawSlug: string) {
  const slug = String(rawSlug || "").trim().replace(/^\/+|\/+$/g, "");
  if (!slug) return [] as string[];
  const normalized = slug.toLowerCase();
  const withoutLeadingOne = normalized.startsWith("1") ? normalized.slice(1) : normalized;
  const dashed = withoutLeadingOne.replace(/([a-z]+)(\d+)/i, "$1-$2");
  return Array.from(new Set([normalized, withoutLeadingOne, dashed, `1${withoutLeadingOne}`].filter(Boolean)));
}

function expandLivekoraSportsurgesVariants(rawUrl: string) {
  if (!isValidHttpUrl(rawUrl)) return [] as string[];
  try {
    const parsed = new URL(rawUrl);
    const host = parsed.hostname.toLowerCase();
    if (!hostMatchesAnySuffix(host, [...LIVEKORA_FAMILY_BASE_HOSTS])) {
      return [] as string[];
    }

    const pathParts = String(parsed.pathname || "")
      .split("/")
      .map((item) => item.trim())
      .filter(Boolean);
    const pageSlug = pathParts[0] === "albaplayer" ? pathParts[1] || "" : pathParts[0] || "";
    const slugVariants = buildSlugVariants(pageSlug);
    const scheme = parsed.protocol === "http:" ? "http" : "https";
    const hostParts = host.split(".").filter(Boolean);
    const firstLabel = hostParts.length > 2 ? hostParts[0] || "" : "";
    const originVariants = new Set<string>([parsed.origin]);
    for (const familyHost of LIVEKORA_FAMILY_BASE_HOSTS) {
      originVariants.add(`${scheme}://${familyHost}`);
      if (familyHost.startsWith("sportsurges.") && firstLabel && /^\d+$/.test(firstLabel)) {
        originVariants.add(`${scheme}://${firstLabel}.${familyHost}`);
      }
    }
    const out = new Set<string>();

    for (const origin of originVariants) {
      for (const slug of slugVariants) {
        out.add(`${origin}/${slug}/`);
        out.add(`${origin}/albaplayer/${slug}/`);
        for (const serv of ["2", "5", "0", "1", "3", "4"]) {
          out.add(`${origin}/albaplayer/${slug}/?serv=${serv}`);
        }
      }
    }

    return Array.from(out).filter((item) => isValidHttpUrl(item));
  } catch {
    return [] as string[];
  }
}

function looksLikeStaticAssetUrl(rawUrl: string) {
  if (!isValidHttpUrl(rawUrl)) return false;
  try {
    const pathname = String(new URL(rawUrl).pathname || "").toLowerCase();
    return /\.(?:css|js|mjs|png|jpe?g|gif|svg|webp|avif|ico|woff2?|ttf|eot|map|json|xml|txt|pdf)(?:$|[?#])/i.test(
      pathname
    );
  } catch {
    return false;
  }
}

function looksLikeExtractableTextBody(contentType: string, body: string) {
  const ct = String(contentType || "").toLowerCase();
  const text = String(body || "");
  if (!text.trim()) return false;
  if (
    ct.includes("text/html") ||
    ct.includes("application/xhtml+xml") ||
    ct.includes("javascript") ||
    ct.includes("ecmascript") ||
    ct.includes("application/json") ||
    ct.includes("text/plain")
  ) {
    return true;
  }
  return /^\s*(?:<!doctype\s+html|<html|<head|<body|<script|<iframe|<div|\{|\[)/i.test(text);
}

function looksLikeChallengePageHtml(body: string) {
  const text = String(body || "").toLowerCase();
  if (!text.trim()) return false;
  return (
    text.includes("cf-mitigated") ||
    text.includes("just a moment") ||
    text.includes("_cf_chl_opt") ||
    text.includes("challenge-platform") ||
    text.includes("enable javascript and cookies to continue") ||
    text.includes("cf-error-details") ||
    text.includes("error code 522") ||
    text.includes("connection timed out") ||
    text.includes("gateway time-out") ||
    text.includes("host error")
  );
}

function looksLikeNavigableStreamPage(rawUrl: string) {
  if (!isValidHttpUrl(rawUrl)) return false;
  if (looksLikeManifestUrl(rawUrl) || looksLikeStaticAssetUrl(rawUrl)) return false;
  if (isLikelyAlbaLandingUrl(rawUrl) || looksLikePlayerv2PageUrl(rawUrl)) return true;
  try {
    const parsed = new URL(rawUrl);
    const pathname = String(parsed.pathname || "").toLowerCase();
    if (/^\/tv\/[^/?#]+\/?$/i.test(pathname)) return true;
    if (pathname.includes("/matches/")) return true;
    if (pathname.includes("/albaplayer/")) return true;
    if (pathname.includes("/playerv2.php")) return true;
    if (pathname.includes("heartbeat-controller.php")) return true;
    if (pathname.includes("/embed") || pathname.includes("/player") || pathname.includes("/iframe")) return true;
    if (pathname.includes("admin-ajax.php") || pathname.includes("ajax.php")) return true;
    if (pathname.endsWith(".html") || pathname.endsWith(".php")) return true;
    if (parsed.searchParams.has("serv") || parsed.searchParams.has("server")) return true;
    const host = parsed.hostname.toLowerCase();
    return (
      host.endsWith(".livehd77.pro") ||
      host === "livehd77.pro" ||
      host.endsWith(".bein-live.com") ||
      host === "bein-live.com" ||
      host.endsWith(".sportsurges.cc") ||
      host === "sportsurges.cc" ||
      host.endsWith(".sportsurges.online") ||
      host === "sportsurges.online" ||
      host.endsWith(".yallashoot2026.com") ||
      host === "yallashoot2026.com" ||
      host.endsWith(".yallashot.us") ||
      host === "yallashot.us"
    );
  } catch {
    return false;
  }
}

function isBeinLiveMatchPageUrl(rawUrl: string) {
  if (!isValidHttpUrl(rawUrl)) return false;
  try {
    const parsed = new URL(rawUrl);
    const host = parsed.hostname.toLowerCase();
    const pathname = String(parsed.pathname || "").toLowerCase();
    return (host === "bein-live.com" || host.endsWith(".bein-live.com")) && pathname.includes("/matches/");
  } catch {
    return false;
  }
}

function shouldNavigateSeedInBrowser(rawUrl: string) {
  return (
    isLikelyAlbaLandingUrl(rawUrl) ||
    looksLikePlayerv2PageUrl(rawUrl) ||
    isBeinLiveMatchPageUrl(rawUrl) ||
    isSiiirBrowserSensitivePage(rawUrl)
  );
}

function looksLikeManifestUrl(rawUrl: string) {
  if (!isValidHttpUrl(rawUrl)) return false;
  try {
    const u = new URL(rawUrl);
    const pathname = String(u.pathname || "").toLowerCase();
    const search = String(u.search || "").toLowerCase();
    const combined = `${pathname}${search}`;
    if (/\.(?:ts|m4s|m4a|mp4|aac|mp3|vtt)(?:$|[?#])/i.test(pathname)) return false;
    if (combined.includes(".mpd")) return false;
    if (combined.includes(".m3u8")) return true;
    if (
      pathname.includes("/hls/") ||
      pathname.includes("/live/") ||
      pathname.includes("/playlist/") ||
      pathname.includes("/manifest/") ||
      pathname.includes("/stream/") ||
      pathname.includes("/kooora/")
    ) {
      return true;
    }
    return (
      search.includes("token=") ||
      search.includes("session") ||
      search.includes("stream=") ||
      search.includes("playlist") ||
      search.includes("m3u8") ||
      search.includes("sid=")
    );
  } catch {
    return false;
  }
}

function resolveManifestUrl(raw: string, baseUrl: string) {
  const value = String(raw || "").trim();
  if (!value) return "";
  try {
    const absolute = new URL(value, baseUrl).toString();
    return isValidHttpUrl(absolute) ? absolute : "";
  } catch {
    return "";
  }
}

function hasMediaSegments(manifestText: string, baseUrl: string) {
  let previousExtInf = false;
  for (const line of String(manifestText || "").split(/\r?\n/)) {
    const trimmed = String(line || "").trim();
    if (!trimmed) continue;
    if (trimmed.startsWith("#EXTINF")) {
      previousExtInf = true;
      continue;
    }
    if (trimmed.startsWith("#")) {
      if (!trimmed.startsWith("#EXT-X-STREAM-INF")) previousExtInf = false;
      continue;
    }
    const absolute = resolveManifestUrl(trimmed, baseUrl);
    if (!absolute) continue;
    if (previousExtInf) return true;
    previousExtInf = false;
  }
  return false;
}

function parseMediaSequence(manifestText: string) {
  const match = String(manifestText || "").match(/#EXT-X-MEDIA-SEQUENCE:(\d+)/i);
  if (!match || !match[1]) return null;
  const value = Number.parseInt(match[1], 10);
  return Number.isFinite(value) ? value : null;
}

function parseTargetDurationSec(manifestText: string) {
  for (const line of String(manifestText || "").split(/\r?\n/)) {
    const trimmed = String(line || "").trim();
    const match = trimmed.match(/^#EXT-X-TARGETDURATION:(\d+(?:\.\d+)?)/i);
    if (!match || !match[1]) continue;
    const value = Number.parseFloat(match[1]);
    if (Number.isFinite(value) && value > 0) return value;
  }
  return 0;
}

function pickVariantManifestUrls(manifestText: string, baseUrl: string, maxItems = 6) {
  let pendingBandwidth = -1;
  const variants: Array<{ url: string; bandwidth: number; order: number }> = [];
  let order = 0;

  for (const line of String(manifestText || "").split(/\r?\n/)) {
    const trimmed = String(line || "").trim();
    if (!trimmed) continue;
    if (trimmed.startsWith("#EXT-X-STREAM-INF")) {
      const match = trimmed.match(/BANDWIDTH=(\d+)/i);
      pendingBandwidth = match?.[1] ? Number.parseInt(match[1], 10) : -1;
      continue;
    }
    if (trimmed.startsWith("#")) continue;

    const absolute = resolveManifestUrl(trimmed, baseUrl);
    if (!absolute || !looksLikeManifestUrl(absolute)) {
      pendingBandwidth = -1;
      continue;
    }
    variants.push({
      url: absolute,
      bandwidth: Number.isFinite(pendingBandwidth) ? pendingBandwidth : -1,
      order,
    });
    order += 1;
    pendingBandwidth = -1;
  }

  return variants
    .sort((left, right) => {
      if (right.bandwidth !== left.bandwidth) return right.bandwidth - left.bandwidth;
      return left.order - right.order;
    })
    .slice(0, Math.max(1, maxItems))
    .map((item) => item.url);
}

function looksLikeManifestResponse(contentType: string, body: string, finalUrl: string) {
  const ct = String(contentType || "").toLowerCase();
  const text = String(body || "");
  if (/^\s*#extm3u/m.test(text)) return true;
  if (ct.includes("application/vnd.apple.mpegurl") || ct.includes("application/x-mpegurl")) return true;
  return looksLikeManifestUrl(finalUrl);
}

function hasHlsManifestBody(contentType: string, body: string) {
  const ct = String(contentType || "").toLowerCase();
  const text = String(body || "");
  if (/^\s*#extm3u/m.test(text)) return true;
  return (
    !!text.trim() && (ct.includes("application/vnd.apple.mpegurl") || ct.includes("application/x-mpegurl"))
  );
}

function buildPlaybackProxyUrl(input: {
  sourceUrl: string;
  requestOrigin: string;
  referrerUrl?: string | null;
}) {
  if (!isValidHttpUrl(input.sourceUrl) || !isValidHttpUrl(input.requestOrigin)) return "";
  const params = new URLSearchParams();
  params.set("url", input.sourceUrl);
  params.set("depth", "0");
  params.set("stable", "1");
  const ref = normalizeHttpUrl(input.referrerUrl || input.sourceUrl);
  if (ref) params.set("ref", ref);
  return `${String(input.requestOrigin || "").replace(/\/+$/, "")}/api/embed-proxy?${params.toString()}`;
}

function buildSessionRelayFetchUrl(input: {
  requestOrigin: string;
  targetUrl: string;
  referrerUrl?: string | null;
}) {
  const targetUrl = normalizeHttpUrl(input.targetUrl);
  const requestOrigin = normalizeHttpUrl(input.requestOrigin);
  if (!targetUrl || !requestOrigin) return "";
  if (sameOrigin(targetUrl, requestOrigin)) return targetUrl;
  return buildPlaybackProxyUrl({
    sourceUrl: unwrapProxyTarget(targetUrl) || targetUrl,
    requestOrigin,
    referrerUrl: input.referrerUrl,
  });
}

function unwrapProxyTarget(rawUrl: string) {
  let current = String(rawUrl || "").trim();
  for (let depth = 0; depth < 4; depth += 1) {
    if (!isValidHttpUrl(current)) return "";
    try {
      const parsed = new URL(current);
      if (!String(parsed.pathname || "").toLowerCase().includes("/api/embed-proxy")) return parsed.toString();
      let target = String(parsed.searchParams.get("url") || "").trim();
      for (let decodeDepth = 0; decodeDepth < 3; decodeDepth += 1) {
        const decoded = safeDecodeURIComponent(target).trim();
        if (decoded === target) break;
        target = decoded;
      }
      if (!isValidHttpUrl(target)) return "";
      current = target;
    } catch {
      return "";
    }
  }
  return normalizeHttpUrl(current);
}

function extractProxyReferrer(rawUrl: string) {
  if (!isValidHttpUrl(rawUrl)) return "";
  try {
    const parsed = new URL(rawUrl);
    if (!String(parsed.pathname || "").toLowerCase().includes("/api/embed-proxy")) return "";
    const ref = safeDecodeURIComponent(String(parsed.searchParams.get("ref") || "").trim());
    return normalizeHttpUrl(ref);
  } catch {
    return "";
  }
}

function scoreCandidate(input: {
  slotServerId?: SlotServerId;
  targetUrl: string;
  referrerUrl: string;
  body?: string;
  via: SessionCandidate["via"];
}) {
  let score = 0;
  const targetUrl = String(input.targetUrl || "").trim();
  const referrerUrl = String(input.referrerUrl || "").trim();
  const body = String(input.body || "");

  if (input.via === "network-manifest") score += 1500;
  else if (input.via === "network-request") score += 700;
  else score += 300;

  if (looksLikeManifestResponse("application/vnd.apple.mpegurl", body, targetUrl)) score += 600;
  if (hasMediaSegments(body, targetUrl)) score += 550;
  if (targetUrl.includes("/kooora/")) score += 420;
  if (targetUrl.includes(".m3u8")) score += 200;
  if (targetUrl.includes("/hls/") || targetUrl.includes("/live/") || targetUrl.includes("/manifest/")) score += 120;
  if (referrerUrl && referrerUrl !== targetUrl) score += 40;

  try {
    const u = new URL(targetUrl);
    const host = u.hostname.toLowerCase();
    const search = String(u.search || "").toLowerCase();
    if (host.endsWith(".yallashot.us") || host === "yallashot.us") score += 220;
    if (host.endsWith(".bein-live.com") || host === "bein-live.com") score += 160;
    if (host.endsWith(".livehd77.pro") || host === "livehd77.pro") score += 140;
    if (host.endsWith(".pandalive.live") || host === "pandalive.live") score += 120;
    if (host.endsWith(".gomatch-live.com") || host === "gomatch-live.com") score += 100;
    if (search.includes("sid=")) score += 80;
    if (search.includes("token=")) score += 60;
    if (search.includes("serv=1")) score += 40;
    if (search.includes("serv=0")) score += 30;
  } catch {}

  if (input.slotServerId === 2 && targetUrl.includes("/kooora/")) score += 260;
  if (input.slotServerId === 1 && targetUrl.includes("/matches/")) score += 110;
  if (input.slotServerId === 3 && (targetUrl.includes("/albaplayer/") || targetUrl.includes("serv="))) score += 90;
  if (input.slotServerId === 4 && targetUrl.includes("livekora")) score += 90;
  return score;
}

function getCandidateRetentionMs(slotServerId?: SlotServerId) {
  if (slotServerId === 2) return PLAYERV2_RUNTIME_CANDIDATE_MAX_AGE_MS;
  return SESSION_STALE_RETURN_MAX_AGE_MS;
}

async function loadBrowser() {
  if (!browserCleanupRegistered) {
    browserCleanupRegistered = true;
    const closeSilently = () => {
      if (sessionCleanupTimer) {
        clearInterval(sessionCleanupTimer);
        sessionCleanupTimer = null;
      }
      void closeBrowser();
    };
    process.once("SIGTERM", closeSilently);
    process.once("SIGINT", closeSilently);
    process.once("beforeExit", closeSilently);
  }
  ensureSessionCleanupTimer();
  if (browserClosingPromise) {
    await browserClosingPromise.catch(() => {});
  }
  if (browserInstance) {
    return browserPromise || Promise.resolve(browserInstance);
  }
  if (!browserPromise) {
    browserPromise = (async () => {
      const { chromium } = (await import("playwright")) as { chromium: { launch: (input: unknown) => Promise<unknown> } };
      const browser = (await chromium.launch({
        headless: true,
        args: ["--disable-dev-shm-usage", "--disable-blink-features=AutomationControlled", "--no-sandbox"],
      })) as PlaywrightBrowser;
      browserInstance = browser;
      return browser;
    })().catch((error) => {
      browserInstance = null;
      browserPromise = null;
      throw error;
    });
  }
  return browserPromise;
}

async function closeBrowser() {
  if (browserClosingPromise) return browserClosingPromise;
  const browser = browserInstance;
  browserInstance = null;
  browserPromise = null;
  if (!browser) {
    return Promise.resolve();
  }
  browserClosingPromise = (async () => {
    try {
      await browser.close?.().catch(() => {});
    } finally {
      browserClosingPromise = null;
    }
  })();
  return browserClosingPromise;
}

async function sleep(ms: number) {
  await new Promise((resolve) => setTimeout(resolve, ms));
}

async function withNavigationSlot<T>(task: () => Promise<T>) {
  if (navigationSlotsInUse >= SESSION_NAVIGATION_CONCURRENCY) {
    await new Promise<void>((resolve) => {
      navigationSlotWaiters.push(resolve);
    });
  }
  navigationSlotsInUse += 1;
  try {
    return await task();
  } finally {
    navigationSlotsInUse = Math.max(0, navigationSlotsInUse - 1);
    const next = navigationSlotWaiters.shift();
    if (next) next();
  }
}

function ensureSessionCleanupTimer() {
  if (sessionCleanupTimer) return;
  const intervalMs = Math.max(5_000, Math.min(15_000, Math.floor(SESSION_IDLE_TTL_MS / 3)));
  sessionCleanupTimer = setInterval(() => {
    cleanupIdleSessions();
  }, intervalMs);
}

function enforceSessionCapacity(targetSize = SESSION_MAX_COUNT) {
  if (sessions.size <= targetSize) return;
  const overflow = [...sessions.values()]
    .filter((session) => session.state === "closed" || session.isIdle())
    .sort((left, right) => left.lastTouchedAt - right.lastTouchedAt)
    .slice(0, Math.max(0, sessions.size - targetSize));
  for (const session of overflow) {
    sessions.delete(session.key);
    void session.close();
  }
}

async function fetchTextDocument(input: { url: string; referrerUrl?: string; timeoutMs?: number }) {
  const controller = new AbortController();
  const timeoutId = setTimeout(
    () => controller.abort(),
    Math.max(
      2_000,
      Number.parseInt(String(input.timeoutMs || SESSION_PAGE_FETCH_TIMEOUT_MS), 10) || SESSION_PAGE_FETCH_TIMEOUT_MS
    )
  );
  try {
    const response = await fetch(input.url, {
      method: "GET",
      cache: "no-store",
      redirect: "follow",
      signal: controller.signal,
      headers: {
        accept: "text/html,application/xhtml+xml,application/javascript,text/javascript,application/json,text/plain,*/*",
        "user-agent": DEFAULT_USER_AGENT,
        ...(isValidHttpUrl(String(input.referrerUrl || "").trim())
          ? {
              referer: String(input.referrerUrl || "").trim(),
              origin: safeOrigin(String(input.referrerUrl || "").trim()),
            }
          : {}),
      },
    });
    const body = await response.text();
    const finalUrl = normalizeHttpUrl(response.url || input.url) || normalizeHttpUrl(input.url);
    const contentType = String(response.headers.get("content-type") || "").toLowerCase();
    const targetUrl =
      normalizeHttpUrl(String(response.headers.get("x-embed-proxy-target") || "").trim()) ||
      unwrapProxyTarget(finalUrl) ||
      finalUrl;
    return {
      ok: response.ok,
      status: response.status,
      body,
      finalUrl,
      targetUrl,
      contentType,
    };
  } catch (error) {
    return {
      ok: false,
      status: 0,
      body: "",
      finalUrl: normalizeHttpUrl(input.url),
      targetUrl: unwrapProxyTarget(normalizeHttpUrl(input.url)) || normalizeHttpUrl(input.url),
      contentType: "",
      error: error instanceof Error ? error.message : String(error || "fetch-failed"),
    };
  } finally {
    clearTimeout(timeoutId);
  }
}

async function fetchBinaryDocument(input: { url: string; referrerUrl?: string; timeoutMs?: number }) {
  const controller = new AbortController();
  const timeoutId = setTimeout(
    () => controller.abort(),
    Math.max(
      2_000,
      Number.parseInt(String(input.timeoutMs || SESSION_PAGE_FETCH_TIMEOUT_MS), 10) || SESSION_PAGE_FETCH_TIMEOUT_MS
    )
  );
  try {
    const response = await fetch(input.url, {
      method: "GET",
      cache: "no-store",
      redirect: "follow",
      signal: controller.signal,
      headers: {
        accept: "*/*",
        "user-agent": DEFAULT_USER_AGENT,
        ...(isValidHttpUrl(String(input.referrerUrl || "").trim())
          ? {
              referer: String(input.referrerUrl || "").trim(),
              origin: safeOrigin(String(input.referrerUrl || "").trim()),
            }
          : {}),
      },
    });
    const bytes = Buffer.from(await response.arrayBuffer());
    const finalUrl = normalizeHttpUrl(response.url || input.url) || normalizeHttpUrl(input.url);
    const contentType = String(response.headers.get("content-type") || "").toLowerCase();
    const targetUrl =
      normalizeHttpUrl(String(response.headers.get("x-embed-proxy-target") || "").trim()) ||
      unwrapProxyTarget(finalUrl) ||
      finalUrl;
    return {
      ok: response.ok,
      status: response.status,
      bodyBase64: bytes.toString("base64"),
      finalUrl,
      targetUrl,
      contentType,
    };
  } catch (error) {
    return {
      ok: false,
      status: 0,
      bodyBase64: "",
      finalUrl: normalizeHttpUrl(input.url),
      targetUrl: unwrapProxyTarget(normalizeHttpUrl(input.url)) || normalizeHttpUrl(input.url),
      contentType: "",
      error: error instanceof Error ? error.message : String(error || "fetch-failed"),
    };
  } finally {
    clearTimeout(timeoutId);
  }
}

function createExtractorInitScript() {
  return () => {
    try {
      const nav = navigator as Navigator & {
        webdriver?: boolean;
        userAgentData?: unknown;
        maxTouchPoints?: number;
        hardwareConcurrency?: number;
        deviceMemory?: number;
        vendor?: string;
      };
      try {
        Object.defineProperty(nav, "webdriver", {
          configurable: true,
          get: () => false,
        });
      } catch {}
      try {
        Object.defineProperty(nav, "languages", {
          configurable: true,
          get: () => ["ar-EG", "ar", "en-US", "en"],
        });
      } catch {}
      try {
        Object.defineProperty(nav, "platform", {
          configurable: true,
          get: () => "Win32",
        });
      } catch {}
      try {
        Object.defineProperty(nav, "vendor", {
          configurable: true,
          get: () => "Google Inc.",
        });
      } catch {}
      try {
        Object.defineProperty(nav, "maxTouchPoints", {
          configurable: true,
          get: () => 0,
        });
      } catch {}
      try {
        Object.defineProperty(nav, "hardwareConcurrency", {
          configurable: true,
          get: () => 8,
        });
      } catch {}
      try {
        Object.defineProperty(nav, "deviceMemory", {
          configurable: true,
          get: () => 8,
        });
      } catch {}
      try {
        Object.defineProperty(nav, "plugins", {
          configurable: true,
          get: () => [
            { name: "Chrome PDF Plugin" },
            { name: "Chrome PDF Viewer" },
            { name: "Native Client" },
          ],
        });
      } catch {}
      try {
        Object.defineProperty(nav, "userAgentData", {
          configurable: true,
          get: () => ({
            brands: [
              { brand: "Google Chrome", version: "145" },
              { brand: "Chromium", version: "145" },
              { brand: "Not=A?Brand", version: "24" },
            ],
            mobile: false,
            platform: "Windows",
            getHighEntropyValues: async () => ({
              architecture: "x86",
              bitness: "64",
              mobile: false,
              model: "",
              platform: "Windows",
              platformVersion: "10.0.0",
              uaFullVersion: "145.0.0.0",
              wow64: false,
            }),
            toJSON: () => ({
              brands: [
                { brand: "Google Chrome", version: "145" },
                { brand: "Chromium", version: "145" },
                { brand: "Not=A?Brand", version: "24" },
              ],
              mobile: false,
              platform: "Windows",
            }),
          }),
        });
      } catch {}
    } catch {}

    try {
      const runtime = {};
      (
        window as Window & {
          chrome?: {
            runtime?: Record<string, never>;
            app?: Record<string, unknown>;
            csi?: () => Record<string, unknown>;
            loadTimes?: () => Record<string, unknown>;
          };
        }
      ).chrome = {
        runtime,
        app: {
          isInstalled: false,
          InstallState: {
            DISABLED: "disabled",
            INSTALLED: "installed",
            NOT_INSTALLED: "not_installed",
          },
          RunningState: {
            CANNOT_RUN: "cannot_run",
            READY_TO_RUN: "ready_to_run",
            RUNNING: "running",
          },
        },
        csi: () => ({}),
        loadTimes: () => ({
          requestTime: Date.now() / 1000,
          startLoadTime: Date.now() / 1000,
          commitLoadTime: Date.now() / 1000,
          finishDocumentLoadTime: Date.now() / 1000,
          finishLoadTime: Date.now() / 1000,
          firstPaintTime: Date.now() / 1000,
        }),
      };
    } catch {}

    try {
      const originalQuery = window.navigator.permissions?.query?.bind(window.navigator.permissions);
      if (typeof originalQuery === "function") {
        window.navigator.permissions.query = ((parameters: PermissionDescriptor) => {
          if (parameters?.name === "notifications") {
            return Promise.resolve({
              state: Notification.permission,
              onchange: null,
            } as PermissionStatus);
          }
          return originalQuery(parameters);
        }) as typeof window.navigator.permissions.query;
      }
    } catch {}

    const store = new Set<string>();
    const push = (value: unknown) => {
      const raw = String(value || "").trim();
      if (!raw) return;
      store.add(raw);
    };

    (window as unknown as { __tfExtractorPush?: (value: unknown) => void }).__tfExtractorPush = push;
    (
      window as unknown as {
        __tfExtractorDrain?: () => { urls: string[]; dom: string[] };
      }
    ).__tfExtractorDrain = () => {
      const domUrls = Array.from(
        document.querySelectorAll<HTMLAnchorElement | HTMLIFrameElement | HTMLVideoElement | HTMLSourceElement>(
          "a[href], iframe[src], video[src], source[src]"
        )
      )
        .map((node) => ("href" in node ? node.href : "src" in node ? node.src : ""))
        .filter(Boolean);

      try {
        for (const entry of performance.getEntriesByType("resource") as Array<{ name?: string }>) {
          if (entry?.name) store.add(String(entry.name));
        }
      } catch {}

      for (const item of domUrls) store.add(item);
      return { urls: Array.from(store), dom: domUrls };
    };

    const patchFetch = () => {
      try {
        if (typeof window.fetch !== "function" || (window.fetch as { __tfExtractorPatched?: boolean }).__tfExtractorPatched)
          return;
        const nativeFetch = window.fetch.bind(window);
        const wrappedFetch = (input: RequestInfo | URL, init?: RequestInit) => {
          try {
            if (typeof input === "string" || input instanceof URL) push(String(input));
            else if (typeof Request !== "undefined" && input instanceof Request) push(input.url);
          } catch {}
          return nativeFetch(input, init);
        };
        (wrappedFetch as { __tfExtractorPatched?: boolean }).__tfExtractorPatched = true;
        window.fetch = wrappedFetch;
      } catch {}
    };

    const patchXhr = () => {
      try {
        if (!window.XMLHttpRequest || !window.XMLHttpRequest.prototype) return;
        const proto = window.XMLHttpRequest.prototype as XMLHttpRequest & {
          __tfExtractorPatched?: boolean;
        };
        if (proto.__tfExtractorPatched) return;
        const nativeOpen = proto.open;
        proto.open = function (
          method: string,
          url: string | URL,
          async?: boolean,
          username?: string | null,
          password?: string | null
        ) {
          try {
            push(String(url || ""));
          } catch {}
          return nativeOpen.call(this, method, url, async ?? true, username, password);
        };
        proto.__tfExtractorPatched = true;
      } catch {}
    };

    const patchMediaSrc = () => {
      try {
        const proto = HTMLMediaElement?.prototype as (HTMLMediaElement & { __tfExtractorSrcPatched?: boolean }) | undefined;
        if (!proto || proto.__tfExtractorSrcPatched) return;
        const descriptor = Object.getOwnPropertyDescriptor(proto, "src");
        if (!descriptor || typeof descriptor.set !== "function") return;
        Object.defineProperty(proto, "src", {
          configurable: true,
          enumerable: descriptor.enumerable,
          get: descriptor.get,
          set(value) {
            push(value);
            return descriptor.set?.call(this, value);
          },
        });
        proto.__tfExtractorSrcPatched = true;
      } catch {}
    };

    const patchHls = () => {
      try {
        const root = window as unknown as {
          Hls?: { prototype?: { loadSource?: (url: string) => void }; __tfExtractorPatched?: boolean };
        };
        const HlsCtor = root.Hls;
        if (!HlsCtor || !HlsCtor.prototype || HlsCtor.__tfExtractorPatched) return;
        const originalLoadSource = HlsCtor.prototype.loadSource;
        if (typeof originalLoadSource !== "function") return;
        HlsCtor.prototype.loadSource = function (urlLike: string) {
          push(urlLike);
          return originalLoadSource.call(this, urlLike);
        };
        HlsCtor.__tfExtractorPatched = true;
      } catch {}
    };

    patchFetch();
    patchXhr();
    patchMediaSrc();
    patchHls();
    window.setInterval(patchHls, 250);
  };
}

class LiveEmbedSession {
  key: string;
  sourceUrl: string;
  requestOrigin: string;
  slotServerId?: SlotServerId;
  playbackUrl: string;
  fallbackReferrer: string;
  lastTouchedAt = Date.now();
  lastActivityAt = 0;
  lastReloadAt = 0;
  lastError = "";
  state: "starting" | "running" | "closed" = "starting";
  browserContext: PlaywrightContext | null = null;
  page: PlaywrightPage | null = null;
  startPromise: Promise<void> | null = null;
  reloadPromise: Promise<void> | null = null;
  maintenancePromise: Promise<void> | null = null;
  maintenanceTimer: ReturnType<typeof setInterval> | null = null;
  candidates = new Map<string, SessionCandidate>();
  pageSeeds = new Map<string, PageSeed>();
  pageQueue: PageSeed[] = [];
  pendingTasks = new Set<Promise<void>>();
  runtimePath = "";
  runtimeTabIndex: number | null = null;
  runtimeSourceIndex: number | null = null;
  runtimeSourceCount = 0;
  runtimeActiveSource = "";
  runtimeSources: string[] = [];
  runtimeUpdatedAt = 0;
  runtimeRefreshing = false;
  runtimeNetworkRetryCount = 0;
  runtimeStallRecoverCount = 0;
  runtimeLastProgressAt = 0;
  runtimeLastRecoverAt = 0;
  runtimeWatchdogState = "";
  lastRefreshReason = "";
  lastRefreshAt = 0;
  lastRotateReason = "";
  lastRotateAt = 0;
  lastRuntimeEvent = "";
  lastRuntimeEventReason = "";
  lastRuntimeEventAt = 0;
  activeManifestUrl = "";
  activeManifestFetchUrl = "";
  activeManifestReferrerUrl = "";
  activeManifestUpdatedAt = 0;
  activeMediaSequence: number | null = null;
  activeTargetDurationSec = 0;

  constructor(input: { sourceUrl: string; requestOrigin: string; slotServerId?: SlotServerId }) {
    this.sourceUrl = normalizeHttpUrl(input.sourceUrl);
    this.requestOrigin = normalizeHttpUrl(input.requestOrigin);
    this.slotServerId = input.slotServerId;
    this.playbackUrl = isDirectCrawlPreferred(this.sourceUrl)
      ? pickPreferredDirectPlaybackUrl(this.sourceUrl)
      : buildPlaybackProxyUrl({
          sourceUrl: this.sourceUrl,
          requestOrigin: this.requestOrigin,
          referrerUrl: this.sourceUrl,
        });
    this.fallbackReferrer = this.sourceUrl;
    this.key = `${canonicalizeUrl(this.sourceUrl)}|${canonicalizeUrl(this.requestOrigin)}|${String(this.slotServerId || "")}`;
  }

  touch() {
    this.lastTouchedAt = Date.now();
  }

  isIdle(now = Date.now()) {
    return now - this.lastTouchedAt > SESSION_IDLE_TTL_MS;
  }

  isEvictable(now = Date.now()) {
    return this.state === "closed" || this.isIdle(now);
  }

  newestCandidateAgeMs(now = Date.now()) {
    let newestAgeMs: number | null = null;
    for (const candidate of this.candidates.values()) {
      const ageMs = Math.max(0, now - candidate.seenAt);
      newestAgeMs = newestAgeMs === null ? ageMs : Math.min(newestAgeMs, ageMs);
    }
    return newestAgeMs;
  }

  hasFreshCandidate(now = Date.now()) {
    return Array.from(this.candidates.values()).some((candidate) => now - candidate.seenAt <= SESSION_STALE_MS);
  }

  pruneStaleCandidates(now = Date.now()) {
    const maxAgeMs = getCandidateRetentionMs(this.slotServerId);
    for (const [key, candidate] of this.candidates.entries()) {
      if (Math.max(0, now - candidate.seenAt) <= maxAgeMs) continue;
      this.candidates.delete(key);
    }
  }

  snapshotCandidates() {
    this.pruneStaleCandidates();
    const now = Date.now();
    return [...this.candidates.values()]
      .sort((left, right) => {
        if (this.slotServerId === 2) {
          const leftIsFresh = now - left.seenAt <= SESSION_STALE_MS;
          const rightIsFresh = now - right.seenAt <= SESSION_STALE_MS;
          if (rightIsFresh !== leftIsFresh) return rightIsFresh ? 1 : -1;
          if (right.seenAt !== left.seenAt) return right.seenAt - left.seenAt;
        }
        if (!!right.manifestBody !== !!left.manifestBody) return right.manifestBody ? 1 : -1;
        if (right.score !== left.score) return right.score - left.score;
        return right.seenAt - left.seenAt;
      })
      .slice(0, SESSION_MAX_CANDIDATES);
  }

  snapshotCandidatesWithManifestBody(maxAgeMs: number, now = Date.now()) {
    return this.snapshotCandidates().filter((candidate) => {
      if (!candidate.manifestBody) return false;
      return Math.max(0, now - candidate.seenAt) <= maxAgeMs;
    });
  }

  rememberRuntimeSources(input: {
    path?: string;
    tabIndex?: number | null;
    sourceIndex?: number | null;
    sourceCount?: number | null;
    activeSource?: string;
    sources?: string[];
    refreshingToken?: boolean;
    networkRetryCount?: number | null;
    stallRecoverCount?: number | null;
    lastProgressAt?: number | null;
    lastRecoverAt?: number | null;
    watchdogState?: string;
    lastRefreshReason?: string;
    lastRefreshAt?: number | null;
    lastRotateReason?: string;
    lastRotateAt?: number | null;
    lastRuntimeEvent?: string;
    lastRuntimeEventReason?: string;
    lastRuntimeEventAt?: number | null;
  }) {
    const runtimePath = String(input.path || "").trim();
    const runtimeTabIndex = Number.isFinite(Number(input.tabIndex)) ? Number(input.tabIndex) : null;
    const runtimeSourceIndex = Number.isFinite(Number(input.sourceIndex)) ? Number(input.sourceIndex) : null;
    const runtimeSourceCount = Math.max(0, Number.parseInt(String(input.sourceCount ?? 0), 10) || 0);
    const runtimeActiveSource = normalizeHttpUrl(input.activeSource || "");
    const runtimeSources = dedupeUrls([
      ...(Array.isArray(input.sources) ? input.sources : []),
      runtimeActiveSource,
    ]);
    const runtimeRefreshing = !!input.refreshingToken;
    const runtimeNetworkRetryCount = Math.max(0, Number.parseInt(String(input.networkRetryCount ?? 0), 10) || 0);
    const runtimeStallRecoverCount = Math.max(0, Number.parseInt(String(input.stallRecoverCount ?? 0), 10) || 0);
    const runtimeLastProgressAt = Number.isFinite(Number(input.lastProgressAt)) ? Number(input.lastProgressAt) : 0;
    const runtimeLastRecoverAt = Number.isFinite(Number(input.lastRecoverAt)) ? Number(input.lastRecoverAt) : 0;
    const runtimeWatchdogState = String(input.watchdogState || "").trim();
    const lastRefreshReason = String(input.lastRefreshReason || "").trim();
    const lastRefreshAt = Number.isFinite(Number(input.lastRefreshAt)) ? Number(input.lastRefreshAt) : 0;
    const lastRotateReason = String(input.lastRotateReason || "").trim();
    const lastRotateAt = Number.isFinite(Number(input.lastRotateAt)) ? Number(input.lastRotateAt) : 0;
    const lastRuntimeEvent = String(input.lastRuntimeEvent || "").trim();
    const lastRuntimeEventReason = String(input.lastRuntimeEventReason || "").trim();
    const lastRuntimeEventAt = Number.isFinite(Number(input.lastRuntimeEventAt)) ? Number(input.lastRuntimeEventAt) : 0;
    if (
      !runtimePath &&
      runtimeTabIndex === null &&
      runtimeSourceIndex === null &&
      runtimeSourceCount <= 0 &&
      !runtimeActiveSource &&
      !runtimeSources.length &&
      !runtimeRefreshing &&
      runtimeNetworkRetryCount <= 0 &&
      runtimeStallRecoverCount <= 0 &&
      !runtimeLastProgressAt &&
      !runtimeLastRecoverAt &&
      !runtimeWatchdogState &&
      !lastRefreshReason &&
      !lastRefreshAt &&
      !lastRotateReason &&
      !lastRotateAt &&
      !lastRuntimeEvent &&
      !lastRuntimeEventReason &&
      !lastRuntimeEventAt
    ) {
      return;
    }
    if (runtimePath) this.runtimePath = runtimePath;
    if (runtimeTabIndex !== null) this.runtimeTabIndex = runtimeTabIndex;
    if (runtimeSourceIndex !== null) this.runtimeSourceIndex = runtimeSourceIndex;
    if (runtimeSourceCount > 0 || runtimeSources.length) this.runtimeSourceCount = Math.max(runtimeSourceCount, runtimeSources.length);
    if (runtimeActiveSource) this.runtimeActiveSource = runtimeActiveSource;
    if (runtimeSources.length) this.runtimeSources = runtimeSources;
    this.runtimeRefreshing = runtimeRefreshing;
    this.runtimeNetworkRetryCount = runtimeNetworkRetryCount;
    this.runtimeStallRecoverCount = runtimeStallRecoverCount;
    if (runtimeLastProgressAt > 0) this.runtimeLastProgressAt = runtimeLastProgressAt;
    if (runtimeLastRecoverAt > 0) this.runtimeLastRecoverAt = runtimeLastRecoverAt;
    if (runtimeWatchdogState) this.runtimeWatchdogState = runtimeWatchdogState;
    if (lastRefreshReason) this.lastRefreshReason = lastRefreshReason;
    if (lastRefreshAt > 0) this.lastRefreshAt = lastRefreshAt;
    if (lastRotateReason) this.lastRotateReason = lastRotateReason;
    if (lastRotateAt > 0) this.lastRotateAt = lastRotateAt;
    if (lastRuntimeEvent) this.lastRuntimeEvent = lastRuntimeEvent;
    if (lastRuntimeEventReason) this.lastRuntimeEventReason = lastRuntimeEventReason;
    if (lastRuntimeEventAt > 0) this.lastRuntimeEventAt = lastRuntimeEventAt;
    this.runtimeUpdatedAt = Date.now();
  }

  rememberActiveManifest(input: {
    targetUrl: string;
    fetchUrl?: string;
    referrerUrl?: string | null;
    manifestBody: string;
  }) {
    const targetUrl = normalizeHttpUrl(input.targetUrl);
    const fetchUrl = normalizeHttpUrl(input.fetchUrl || targetUrl) || targetUrl;
    const referrerUrl = normalizeHttpUrl(input.referrerUrl || this.fallbackReferrer || this.sourceUrl) || this.sourceUrl;
    const manifestBody = String(input.manifestBody || "").trim();
    if (!targetUrl || !manifestBody || !hasMediaSegments(manifestBody, targetUrl)) return;
    this.activeManifestUrl = targetUrl;
    this.activeManifestFetchUrl = fetchUrl;
    this.activeManifestReferrerUrl = referrerUrl;
    this.activeManifestUpdatedAt = Date.now();
    this.activeMediaSequence = parseMediaSequence(manifestBody);
    this.activeTargetDurationSec = parseTargetDurationSec(manifestBody);
    if (!this.runtimeActiveSource) this.runtimeActiveSource = targetUrl;
  }

  getRuntimeState(now = Date.now()): SessionRuntimeState {
    this.pruneStaleCandidates(now);
    const candidates = this.snapshotCandidates();
    const freshManifestCandidates = this.snapshotCandidatesWithManifestBody(SESSION_STALE_MS, now);
    const freshCandidateCount = candidates.filter((candidate) => now - candidate.seenAt <= SESSION_STALE_MS).length;
    return {
      key: this.key,
      state: this.state,
      lastError: this.lastError,
      playbackUrl: this.playbackUrl,
      lastTouchedAt: this.lastTouchedAt,
      lastActivityAt: this.lastActivityAt,
      candidateCount: candidates.length,
      freshCandidateCount,
      freshManifestCount: freshManifestCandidates.length,
      runtimePath: this.runtimePath,
      runtimeTabIndex: this.runtimeTabIndex,
      runtimeSourceIndex: this.runtimeSourceIndex,
      runtimeSourceCount: this.runtimeSourceCount,
      runtimeActiveSource: this.runtimeActiveSource,
      runtimeSources: this.runtimeSources.slice(),
      runtimeUpdatedAt: this.runtimeUpdatedAt,
      runtimeRefreshing: this.runtimeRefreshing,
      runtimeNetworkRetryCount: this.runtimeNetworkRetryCount,
      runtimeStallRecoverCount: this.runtimeStallRecoverCount,
      runtimeLastProgressAt: this.runtimeLastProgressAt,
      runtimeLastRecoverAt: this.runtimeLastRecoverAt,
      runtimeWatchdogState: this.runtimeWatchdogState,
      lastRefreshReason: this.lastRefreshReason,
      lastRefreshAt: this.lastRefreshAt,
      lastRotateReason: this.lastRotateReason,
      lastRotateAt: this.lastRotateAt,
      lastRuntimeEvent: this.lastRuntimeEvent,
      lastRuntimeEventReason: this.lastRuntimeEventReason,
      lastRuntimeEventAt: this.lastRuntimeEventAt,
      activeManifestUrl: this.activeManifestUrl,
      activeManifestFetchUrl: this.activeManifestFetchUrl,
      activeManifestReferrerUrl: this.activeManifestReferrerUrl,
      activeManifestUpdatedAt: this.activeManifestUpdatedAt,
      activeMediaSequence: this.activeMediaSequence,
      activeTargetDurationSec: this.activeTargetDurationSec,
      candidates,
    };
  }

  rememberCandidate(input: {
    fetchUrl?: string;
    targetUrl: string;
    referrerUrl?: string | null;
    manifestBody?: string;
    manifestBaseUrl?: string;
    via: SessionCandidate["via"];
  }) {
    const targetUrl = normalizeHttpUrl(input.targetUrl);
    if (!targetUrl || !looksLikeManifestUrl(targetUrl)) return;
    const fetchUrl = normalizeHttpUrl(input.fetchUrl || targetUrl) || targetUrl;
    const referrerUrl = normalizeHttpUrl(input.referrerUrl || this.fallbackReferrer) || this.fallbackReferrer;
    const key = canonicalizeUrl(targetUrl) || targetUrl.toLowerCase();
    if (!key) return;
    const now = Date.now();
    const manifestBody = String(input.manifestBody || "").trim() || undefined;
    const manifestBaseUrl = normalizeHttpUrl(input.manifestBaseUrl || targetUrl) || targetUrl;
    const next: SessionCandidate = {
      fetchUrl,
      targetUrl,
      referrerUrl,
      manifestBody,
      manifestBaseUrl: manifestBody ? manifestBaseUrl : undefined,
      score: scoreCandidate({
        slotServerId: this.slotServerId,
        targetUrl,
        referrerUrl,
        body: manifestBody,
        via: input.via,
      }),
      via: input.via,
      seenAt: now,
    };
    const prev = this.candidates.get(key);
    if (!prev || next.score >= prev.score) {
      this.candidates.set(key, {
        ...next,
        fetchUrl,
        manifestBody: manifestBody || prev?.manifestBody,
        manifestBaseUrl: manifestBody ? manifestBaseUrl : prev?.manifestBaseUrl,
      });
    } else if (!prev.manifestBody && manifestBody) {
      this.candidates.set(key, {
        ...prev,
        fetchUrl,
        manifestBody,
        manifestBaseUrl,
        seenAt: now,
      });
    } else {
      this.candidates.set(key, {
        ...prev,
        fetchUrl,
        seenAt: now,
      });
    }

    this.lastActivityAt = now;
    this.lastError = "";
    if (manifestBody && hasMediaSegments(manifestBody, manifestBaseUrl || targetUrl)) {
      this.rememberActiveManifest({
        targetUrl,
        fetchUrl,
        referrerUrl,
        manifestBody,
      });
    }
  }

  enqueuePageSeed(rawUrl: string, referrerUrl: string, depth: number) {
    const normalizedRawUrl = normalizeHttpUrl(rawUrl);
    if (!normalizedRawUrl) return;
    const pageUrl = unwrapProxyTarget(normalizedRawUrl) || normalizedRawUrl;
    if (!looksLikeNavigableStreamPage(pageUrl)) return;
    const safeReferrer = normalizeHttpUrl(extractProxyReferrer(normalizedRawUrl) || referrerUrl || this.sourceUrl) || this.sourceUrl;
    const key = canonicalizeUrl(pageUrl) || pageUrl.toLowerCase();
    if (!key) return;
    const next: PageSeed = {
      pageUrl,
      referrerUrl: safeReferrer,
      depth,
    };
    const previous = this.pageSeeds.get(key);
    if (previous && previous.depth <= depth) return;
    this.pageSeeds.set(key, next);
    this.pageQueue.push(next);
  }

  registerUrl(input: {
    rawUrl: string;
    referrerUrl: string;
    via: SessionCandidate["via"];
    body?: string;
    depth?: number;
  }) {
    const rawUrl = normalizeHttpUrl(input.rawUrl);
    if (!rawUrl) return;
    const targetUrl = unwrapProxyTarget(rawUrl) || rawUrl;
    const referrerUrl = normalizeHttpUrl(extractProxyReferrer(rawUrl) || input.referrerUrl || this.sourceUrl) || this.sourceUrl;
    if (looksLikeManifestUrl(targetUrl)) {
      this.rememberCandidate({
        fetchUrl: rawUrl,
        targetUrl,
        referrerUrl,
        manifestBody: input.body,
        manifestBaseUrl: targetUrl,
        via: input.via,
      });
      return;
    }
    this.enqueuePageSeed(targetUrl, referrerUrl, Math.max(0, Number(input.depth || 0)));
  }

  async registerExtractedText(input: {
    text: string;
    pageUrl: string;
    sourceUrl: string;
    referrerUrl: string;
    depth: number;
  }) {
    const pageUrl = normalizeHttpUrl(input.pageUrl);
    const sourcePageUrl = normalizeHttpUrl(input.sourceUrl) || pageUrl;
    const referrerUrl = normalizeHttpUrl(input.referrerUrl || sourcePageUrl) || this.sourceUrl;
    if (!pageUrl || !sourcePageUrl || !String(input.text || "").trim()) return;

    for (const candidateUrl of extractCandidatesFromText(input.text, pageUrl)) {
      this.registerUrl({
        rawUrl: candidateUrl,
        referrerUrl,
        via: "dom",
        depth: input.depth + 1,
      });
    }

    const beinCandidates = await fetchBeinAjaxResolvedCandidates(
      sourcePageUrl,
      input.text,
      Math.min(SESSION_PAGE_FETCH_TIMEOUT_MS, 12_000)
    );
    for (const candidateUrl of beinCandidates) {
      this.registerUrl({
        rawUrl: candidateUrl,
        referrerUrl: sourcePageUrl,
        via: "dom",
        depth: input.depth + 1,
      });
    }

    if (looksLikePlayerv2PageUrl(sourcePageUrl) || looksLikePlayerv2Html(input.text)) {
      const playerv2Candidates = await buildPlayerv2Candidates(
        sourcePageUrl,
        input.text,
        Math.min(SESSION_PAGE_FETCH_TIMEOUT_MS, 12_000),
        this.requestOrigin
      );
      for (const candidateUrl of playerv2Candidates) {
        this.registerUrl({
          rawUrl: candidateUrl,
          referrerUrl: sourcePageUrl,
          via: "dom",
          depth: input.depth + 1,
        });
      }
    }
  }

  async crawlQueuedPages(timeoutMs: number) {
    let crawledPages = 0;
    const visited = new Set<string>();
    const deadlineAt = Date.now() + Math.max(8_000, Math.min(28_000, timeoutMs));
    while (this.pageQueue.length && crawledPages < SESSION_MAX_CRAWL_PAGES) {
      const remainingMs = deadlineAt - Date.now();
      if (remainingMs <= 0) break;
      const next = this.pageQueue.shift();
      if (!next) continue;
      if (next.depth > SESSION_MAX_CRAWL_DEPTH) continue;
      const key = canonicalizeUrl(next.pageUrl) || next.pageUrl.toLowerCase();
      if (!key || visited.has(key)) continue;
      visited.add(key);
      crawledPages += 1;

      if (shouldNavigateSeedInBrowser(next.pageUrl) && this.page && !this.page.isClosed?.()) {
        const navigated = await this.navigateSeedInBrowser(next, Math.max(4_000, remainingMs));
        if (navigated) continue;
      }

      const pageFetchUrl = isDirectCrawlPreferred(next.pageUrl)
        ? pickPreferredDirectPlaybackUrl(next.pageUrl)
        : buildPlaybackProxyUrl({
            sourceUrl: next.pageUrl,
            requestOrigin: this.requestOrigin,
            referrerUrl: next.referrerUrl,
          });
      if (!pageFetchUrl) continue;

      const fetched = await fetchTextDocument({
        url: pageFetchUrl,
        referrerUrl: next.referrerUrl,
        timeoutMs: Math.max(2_500, Math.min(SESSION_PAGE_FETCH_TIMEOUT_MS, remainingMs)),
      });
      if (!fetched.ok || !fetched.body) continue;

      const pageUrl = fetched.finalUrl || pageFetchUrl;
      const sourcePageUrl = fetched.targetUrl || next.pageUrl;
      if (looksLikeManifestResponse(fetched.contentType, fetched.body, sourcePageUrl)) {
        if (hasMediaSegments(fetched.body, sourcePageUrl)) {
          this.rememberCandidate({
            fetchUrl: pageUrl,
            targetUrl: sourcePageUrl,
            referrerUrl: next.referrerUrl,
            manifestBody: fetched.body,
            manifestBaseUrl: sourcePageUrl,
            via: "dom",
          });
          continue;
        }
        for (const variantUrl of pickVariantManifestUrls(fetched.body, sourcePageUrl)) {
          this.registerUrl({
            rawUrl: variantUrl,
            referrerUrl: sourcePageUrl,
            via: "dom",
            depth: next.depth + 1,
          });
        }
        continue;
      }

      if (looksLikeExtractableTextBody(fetched.contentType, fetched.body)) {
        await this.registerExtractedText({
          text: fetched.body,
          pageUrl,
          sourceUrl: sourcePageUrl,
          referrerUrl: sourcePageUrl,
          depth: next.depth,
        });
      }
    }
  }

  async navigateSeedInBrowser(seed: PageSeed, timeoutMs: number) {
    const page = this.page;
    if (!page || page.isClosed?.()) return false;
    const deadlineAt = Date.now() + Math.max(6_000, Math.min(18_000, timeoutMs));
    const playbackUrl = isDirectCrawlPreferred(seed.pageUrl)
      ? pickPreferredDirectPlaybackUrl(seed.pageUrl)
      : buildPlaybackProxyUrl({
          sourceUrl: seed.pageUrl,
          requestOrigin: this.requestOrigin,
          referrerUrl: seed.referrerUrl,
        });
    if (!playbackUrl) return false;

    try {
      const initialBudgetMs = Math.max(4_000, deadlineAt - Date.now());
      await page.goto(playbackUrl, {
        waitUntil: "domcontentloaded",
        timeout: Math.max(4_000, Math.min(20_000, initialBudgetMs)),
      });
      if (typeof page.waitForLoadState === "function") {
        const networkIdleBudgetMs = Math.max(1_000, deadlineAt - Date.now());
        await page.waitForLoadState("networkidle", {
          timeout: Math.min(networkIdleBudgetMs, 5_000, SESSION_NETWORK_IDLE_WAIT_MS),
        }).catch(() => {});
      }
      const settleBudgetMs = Math.max(0, deadlineAt - Date.now());
      if (settleBudgetMs > 0) {
        await page.waitForTimeout(Math.max(750, Math.min(3_500, SESSION_WAIT_MS, settleBudgetMs)));
      }
      const challengeWaitBudgetMs = Math.max(
        0,
        Math.min(this.slotServerId === 4 ? 8_000 : 12_000, timeoutMs, deadlineAt - Date.now())
      );
      await this.waitOutChallengeIfNeeded(challengeWaitBudgetMs).catch(() => false);
      await this.drainDomCandidates();
      if (this.pendingTasks.size && deadlineAt - Date.now() > 0) {
        await Promise.race([
          Promise.allSettled(Array.from(this.pendingTasks)),
          sleep(Math.max(250, Math.min(2_500, deadlineAt - Date.now()))),
        ]).catch(() => {});
      }
      const html = await page
        .evaluate(() => {
          try {
            return document.documentElement?.outerHTML || document.body?.outerHTML || "";
          } catch {
            return "";
          }
        })
        .catch(() => "");
      if (String(html || "").trim()) {
        await this.registerExtractedText({
          text: String(html || ""),
          pageUrl: playbackUrl,
          sourceUrl: seed.pageUrl,
          referrerUrl: seed.referrerUrl,
          depth: seed.depth,
        });
      }
      return true;
    } catch (error) {
      this.lastError = error instanceof Error ? error.message : String(error || "seed-browser-navigation-failed");
      return false;
    }
  }

  async drainDomCandidates() {
    const page = this.page;
    if (!page || page.isClosed?.()) return;
    const drained = await page.evaluate(() => {
      const drain = (
        window as unknown as {
          __tfExtractorDrain?: () => { urls: string[]; dom: string[] };
        }
      ).__tfExtractorDrain;
      const runtime = (
        window as unknown as {
          __tfRepackYalla?: {
            getState?: () => {
              path?: string;
              tabIndex?: number;
              sourceIdx?: number;
              sourceCount?: number;
              activeSource?: string;
              sources?: string[];
              refreshingToken?: boolean;
              networkRetryCount?: number;
              stallRecoverCount?: number;
              lastProgressAt?: number;
              lastRecoverAt?: number;
              watchdogState?: string;
              lastRefreshReason?: string;
              lastRefreshAt?: number;
              lastRotateReason?: string;
              lastRotateAt?: number;
              lastRuntimeEvent?: string;
              lastRuntimeEventReason?: string;
              lastRuntimeEventAt?: number;
            };
          };
        }
      ).__tfRepackYalla;
      const runtimeState = typeof runtime?.getState === "function" ? runtime.getState() : null;
      return {
        ...(typeof drain === "function" ? drain() : { urls: [], dom: [] }),
        runtimeSources: Array.isArray(runtimeState?.sources) ? runtimeState.sources : [],
        tabIndex: Number.isFinite(Number(runtimeState?.tabIndex)) ? Number(runtimeState?.tabIndex) : null,
        sourceIndex: Number.isFinite(Number(runtimeState?.sourceIdx)) ? Number(runtimeState?.sourceIdx) : null,
        sourceCount: Number.isFinite(Number(runtimeState?.sourceCount)) ? Number(runtimeState?.sourceCount) : 0,
        activeSource: String(runtimeState?.activeSource || ""),
        runtimePath: String(runtimeState?.path || ""),
        refreshingToken: !!runtimeState?.refreshingToken,
        networkRetryCount: Number.isFinite(Number(runtimeState?.networkRetryCount))
          ? Number(runtimeState?.networkRetryCount)
          : 0,
        stallRecoverCount: Number.isFinite(Number(runtimeState?.stallRecoverCount))
          ? Number(runtimeState?.stallRecoverCount)
          : 0,
        lastProgressAt: Number.isFinite(Number(runtimeState?.lastProgressAt)) ? Number(runtimeState?.lastProgressAt) : 0,
        lastRecoverAt: Number.isFinite(Number(runtimeState?.lastRecoverAt)) ? Number(runtimeState?.lastRecoverAt) : 0,
        watchdogState: String(runtimeState?.watchdogState || ""),
        lastRefreshReason: String(runtimeState?.lastRefreshReason || ""),
        lastRefreshAt: Number.isFinite(Number(runtimeState?.lastRefreshAt)) ? Number(runtimeState?.lastRefreshAt) : 0,
        lastRotateReason: String(runtimeState?.lastRotateReason || ""),
        lastRotateAt: Number.isFinite(Number(runtimeState?.lastRotateAt)) ? Number(runtimeState?.lastRotateAt) : 0,
        lastRuntimeEvent: String(runtimeState?.lastRuntimeEvent || ""),
        lastRuntimeEventReason: String(runtimeState?.lastRuntimeEventReason || ""),
        lastRuntimeEventAt: Number.isFinite(Number(runtimeState?.lastRuntimeEventAt))
          ? Number(runtimeState?.lastRuntimeEventAt)
          : 0,
      };
    });

    this.rememberRuntimeSources({
      path: String(drained?.runtimePath || ""),
      tabIndex: Number.isFinite(Number(drained?.tabIndex)) ? Number(drained?.tabIndex) : null,
      sourceIndex: Number.isFinite(Number(drained?.sourceIndex)) ? Number(drained?.sourceIndex) : null,
      sourceCount: Number.isFinite(Number(drained?.sourceCount)) ? Number(drained?.sourceCount) : 0,
      activeSource: String(drained?.activeSource || ""),
      sources: Array.isArray(drained?.runtimeSources) ? drained.runtimeSources : [],
      refreshingToken: !!drained?.refreshingToken,
      networkRetryCount: Number.isFinite(Number(drained?.networkRetryCount)) ? Number(drained?.networkRetryCount) : 0,
      stallRecoverCount: Number.isFinite(Number(drained?.stallRecoverCount)) ? Number(drained?.stallRecoverCount) : 0,
      lastProgressAt: Number.isFinite(Number(drained?.lastProgressAt)) ? Number(drained?.lastProgressAt) : 0,
      lastRecoverAt: Number.isFinite(Number(drained?.lastRecoverAt)) ? Number(drained?.lastRecoverAt) : 0,
      watchdogState: String(drained?.watchdogState || ""),
      lastRefreshReason: String(drained?.lastRefreshReason || ""),
      lastRefreshAt: Number.isFinite(Number(drained?.lastRefreshAt)) ? Number(drained?.lastRefreshAt) : 0,
      lastRotateReason: String(drained?.lastRotateReason || ""),
      lastRotateAt: Number.isFinite(Number(drained?.lastRotateAt)) ? Number(drained?.lastRotateAt) : 0,
      lastRuntimeEvent: String(drained?.lastRuntimeEvent || ""),
      lastRuntimeEventReason: String(drained?.lastRuntimeEventReason || ""),
      lastRuntimeEventAt: Number.isFinite(Number(drained?.lastRuntimeEventAt)) ? Number(drained?.lastRuntimeEventAt) : 0,
    });

    for (const rawValue of [
      ...(drained?.urls || []),
      ...(drained?.dom || []),
      ...(drained?.runtimeSources || []),
      drained?.activeSource || "",
    ]) {
      const rawUrl = normalizeHttpUrl(String(rawValue || "").trim());
      if (!rawUrl) continue;
      this.registerUrl({
        rawUrl,
        referrerUrl: extractProxyReferrer(rawUrl) || this.sourceUrl,
        via: "dom",
        depth: 1,
      });
    }
  }

  async readPageSnapshot() {
    const page = this.page;
    if (!page || page.isClosed?.()) {
      return {
        url: "",
        title: "",
        html: "",
      };
    }
    return page
      .evaluate(() => {
        try {
          return {
            url: String(location.href || ""),
            title: String(document.title || ""),
            html: String(document.documentElement?.outerHTML || document.body?.outerHTML || ""),
          };
        } catch {
          return {
            url: "",
            title: "",
            html: "",
          };
        }
      })
      .catch(() => ({
        url: "",
        title: "",
        html: "",
      }));
  }

  async waitOutChallengeIfNeeded(timeoutMs: number) {
    const page = this.page;
    if (!page || page.isClosed?.()) return false;
    const snapshot = await this.readPageSnapshot();
    if (
      !looksLikeChallengePageHtml(snapshot.html) &&
      !/just a moment/i.test(String(snapshot.title || ""))
    ) {
      return false;
    }
    const extraWaitMs = Math.max(6_000, Math.min(18_000, timeoutMs));
    await page.waitForTimeout(extraWaitMs).catch(() => {});
    if (typeof page.waitForLoadState === "function") {
      await page.waitForLoadState("networkidle", {
        timeout: Math.min(extraWaitMs, 10_000),
      }).catch(() => {});
    }
    await this.drainDomCandidates();
    if (this.pendingTasks.size) {
      await Promise.allSettled(Array.from(this.pendingTasks));
    }
    const after = await this.readPageSnapshot();
    return !looksLikeChallengePageHtml(after.html) && !/just a moment/i.test(String(after.title || ""));
  }

  async refreshEmbedRuntime(reason: string) {
    const page = this.page;
    if (!page || page.isClosed?.()) return false;
    const refreshed = await page
      .evaluate((refreshReason) => {
        const runtime = (
          window as unknown as {
            __tfRepackYalla?: {
              refreshCurrent?: (reason?: string) => boolean;
            };
          }
        ).__tfRepackYalla;
        return typeof runtime?.refreshCurrent === "function" ? runtime.refreshCurrent(refreshReason) : false;
      }, reason)
      .catch(() => false);
    if (!refreshed) return false;
    this.lastRefreshReason = String(reason || "runtime_refresh");
    this.lastRefreshAt = Date.now();
    await page.waitForTimeout(Math.max(1_250, Math.min(4_000, SESSION_RETRY_WAIT_MS)));
    await this.drainDomCandidates();
    if (this.pendingTasks.size) {
      await Promise.allSettled(Array.from(this.pendingTasks));
    }
    await this.hydrateCandidateBodiesInPage();
    return true;
  }

  async rotateEmbedRuntime(reason: string) {
    const page = this.page;
    if (!page || page.isClosed?.()) return false;
    const rotated = await page
      .evaluate((rotateReason) => {
        const runtime = (
          window as unknown as {
            __tfRepackYalla?: {
              rotateCurrent?: (reason?: string) => boolean;
            };
          }
        ).__tfRepackYalla;
        return typeof runtime?.rotateCurrent === "function" ? runtime.rotateCurrent(rotateReason) : false;
      }, reason)
      .catch(() => false);
    if (!rotated) return false;
    this.lastRotateReason = String(reason || "runtime_rotate");
    this.lastRotateAt = Date.now();
    await page.waitForTimeout(Math.max(1_250, Math.min(4_000, SESSION_RETRY_WAIT_MS)));
    await this.drainDomCandidates();
    if (this.pendingTasks.size) {
      await Promise.allSettled(Array.from(this.pendingTasks));
    }
    await this.hydrateCandidateBodiesInPage();
    return true;
  }

  async hydrateCandidateBodiesInPage() {
    const page = this.page;
    if (!page || page.isClosed?.()) return;
    const pendingTargets = this.snapshotCandidates()
      .filter((candidate) => !candidate.manifestBody)
      .map((candidate) => ({
        fetchUrl: candidate.fetchUrl || candidate.targetUrl,
        targetUrl: candidate.targetUrl,
        referrerUrl: candidate.referrerUrl || this.fallbackReferrer,
      }))
      .filter((candidate) => isValidHttpUrl(candidate.fetchUrl) && isValidHttpUrl(candidate.targetUrl))
      .slice(0, 8);
    if (!pendingTargets.length) return;

    try {
      const fetched = await page.evaluate(
        async ({ pendingTargets, timeoutMs }) => {
          const out: Array<{
            fetchUrl: string;
            targetUrl: string;
            referrerUrl: string;
            finalUrl: string;
            status: number;
            body: string;
            contentType: string;
          }> = [];
          for (const pendingTarget of pendingTargets) {
            try {
              const controller = new AbortController();
              const timeoutId = window.setTimeout(() => controller.abort(), timeoutMs);
              const response = await fetch(pendingTarget.fetchUrl, {
                method: "GET",
                cache: "no-store",
                credentials: "include",
                signal: controller.signal,
              }).finally(() => window.clearTimeout(timeoutId));
              const body = await response.text().catch(() => "");
              out.push({
                fetchUrl: pendingTarget.fetchUrl,
                targetUrl: pendingTarget.targetUrl,
                referrerUrl: pendingTarget.referrerUrl,
                finalUrl: String(response.url || pendingTarget.fetchUrl),
                status: Number(response.status || 0),
                body,
                contentType: String(response.headers.get("content-type") || ""),
              });
            } catch {
              out.push({
                fetchUrl: pendingTarget.fetchUrl,
                targetUrl: pendingTarget.targetUrl,
                referrerUrl: pendingTarget.referrerUrl,
                finalUrl: pendingTarget.fetchUrl,
                status: 0,
                body: "",
                contentType: "",
              });
            }
          }
          return out;
        },
        {
          pendingTargets,
          timeoutMs: Math.max(2_000, Math.min(15_000, SESSION_PAGE_FETCH_TIMEOUT_MS)),
        }
      );

      for (const item of Array.isArray(fetched) ? fetched : []) {
        const targetUrl = normalizeHttpUrl(String(item?.targetUrl || "").trim());
        const fetchUrl = normalizeHttpUrl(String(item?.fetchUrl || targetUrl).trim()) || targetUrl;
        const referrerUrl =
          normalizeHttpUrl(String(item?.referrerUrl || this.fallbackReferrer || this.sourceUrl).trim()) ||
          this.fallbackReferrer ||
          this.sourceUrl;
        if (!targetUrl || !fetchUrl) continue;

        let finalUrl = normalizeHttpUrl(String(item?.finalUrl || targetUrl).trim()) || targetUrl;
        let body = String(item?.body || "").trim();
        let status = Number(item?.status || 0);
        let contentType = String(item?.contentType || "").trim();
        let ok = status >= 200 && status < 300 && hasHlsManifestBody(contentType, body);

        if (!ok) {
          const directFetchUrl =
            !sameOrigin(fetchUrl, this.requestOrigin)
              ? fetchUrl
              : !sameOrigin(targetUrl, this.requestOrigin)
                ? targetUrl
                : "";
          if (directFetchUrl) {
            const direct = await fetchTextDocument({
              url: directFetchUrl,
              referrerUrl,
              timeoutMs: Math.max(2_000, Math.min(15_000, SESSION_PAGE_FETCH_TIMEOUT_MS)),
            });
            const directFinalUrl =
              normalizeHttpUrl(direct.targetUrl || "") ||
              unwrapProxyTarget(direct.finalUrl || "") ||
              targetUrl;
            if (direct.ok && String(direct.body || "").trim() && hasHlsManifestBody(direct.contentType, direct.body)) {
              finalUrl = directFinalUrl;
              body = String(direct.body || "").trim();
              status = Number(direct.status || 200);
              contentType = String(direct.contentType || "").trim();
              ok = true;
            }
          }
        }

        if (!ok) continue;
        this.rememberCandidate({
          fetchUrl,
          targetUrl,
          referrerUrl,
          manifestBody: body,
          manifestBaseUrl: finalUrl,
          via: "network-manifest",
        });
      }
    } catch (error) {
      this.lastError = error instanceof Error ? error.message : String(error || "candidate-body-hydration-failed");
    }
  }

  async attachPageHandlers(page: PlaywrightPage) {
    page.on("request", (requestArg: unknown) => {
      try {
        const request = requestArg as {
          url: () => string;
          headers?: () => Record<string, string>;
        };
        const requestUrl = normalizeHttpUrl(request.url());
        if (!requestUrl) return;
        const targetUrl = unwrapProxyTarget(requestUrl) || requestUrl;
        const headers = typeof request.headers === "function" ? request.headers() : {};
        const referrerUrl =
          extractProxyReferrer(requestUrl) ||
          normalizeHttpUrl(String(headers?.referer || headers?.referrer || "").trim()) ||
          this.sourceUrl;
        this.registerUrl({
          rawUrl: requestUrl,
          referrerUrl,
          via: "network-request",
          depth: 1,
        });
      } catch {}
    });

    page.on("response", (responseArg: unknown) => {
      const task = (async () => {
        try {
          const response = responseArg as {
            url: () => string;
            headers?: () => Record<string, string>;
            request?: () => { headers?: () => Record<string, string> };
            text?: () => Promise<string>;
          };
          const responseUrl = normalizeHttpUrl(response.url());
          if (!responseUrl) return;
          const rawHeaders = typeof response.headers === "function" ? response.headers() : {};
          const headers = Object.fromEntries(
            Object.entries(rawHeaders || {}).map(([key, value]) => [String(key || "").toLowerCase(), String(value || "")])
          );
          const contentType = String(headers["content-type"] || "").toLowerCase();
          const targetUrl =
            normalizeHttpUrl(headers["x-embed-proxy-target"] || "") ||
            unwrapProxyTarget(responseUrl) ||
            responseUrl;
          const body = typeof response.text === "function" ? await response.text().catch(() => "") : "";
          const requestHeaders =
            typeof response.request === "function" && typeof response.request()?.headers === "function"
              ? response.request()?.headers?.() || {}
              : {};
          const referrerUrl =
            extractProxyReferrer(responseUrl) ||
            normalizeHttpUrl(String(requestHeaders?.referer || requestHeaders?.referrer || "").trim()) ||
            this.sourceUrl;

          if (hasHlsManifestBody(contentType, body)) {
            if (hasMediaSegments(body, targetUrl)) {
              this.rememberCandidate({
                fetchUrl: responseUrl,
                targetUrl,
                referrerUrl,
                manifestBody: body,
                manifestBaseUrl: targetUrl,
                via: "network-manifest",
              });
              return;
            }

            for (const variantUrl of pickVariantManifestUrls(body, targetUrl)) {
              this.rememberCandidate({
                fetchUrl: responseUrl,
                targetUrl: variantUrl,
                referrerUrl: targetUrl,
                via: "network-manifest",
              });
            }
            return;
          }

          if (looksLikeExtractableTextBody(contentType, body) || looksLikeNavigableStreamPage(targetUrl)) {
            await this.registerExtractedText({
              text: body,
              pageUrl: responseUrl,
              sourceUrl: targetUrl,
              referrerUrl: targetUrl,
              depth: 1,
            });
          }
        } catch {}
      })();
      this.pendingTasks.add(task);
      void task.finally(() => {
        this.pendingTasks.delete(task);
      });
    });
  }

  seedSourceVariants() {
    this.pageSeeds.clear();
    this.pageQueue.length = 0;
    this.enqueuePageSeed(this.sourceUrl, this.sourceUrl, 0);
    for (const livehdVariant of expandLivehdTvServVariants(this.sourceUrl).slice(0, 4)) {
      this.enqueuePageSeed(livehdVariant, this.sourceUrl, 0);
    }
    for (const livekoraVariant of expandLivekoraSportsurgesVariants(this.sourceUrl).slice(0, 16)) {
      this.enqueuePageSeed(livekoraVariant, this.sourceUrl, 0);
    }
  }

  async primePage(timeoutMs: number) {
    await withNavigationSlot(async () => {
      const page = this.page;
      if (!page || page.isClosed?.()) throw new Error("browser-page-closed");
      const deadlineAt = Date.now() + Math.max(8_000, Math.min(24_000, timeoutMs));

      this.seedSourceVariants();
      await page.goto(this.playbackUrl, {
        waitUntil: "domcontentloaded",
        timeout: Math.max(4_000, Math.min(20_000, deadlineAt - Date.now())),
      });
      if (typeof page.waitForLoadState === "function") {
        const networkIdleBudgetMs = Math.max(1_000, deadlineAt - Date.now());
        await page.waitForLoadState("networkidle", {
          timeout: Math.min(networkIdleBudgetMs, 5_000, SESSION_NETWORK_IDLE_WAIT_MS),
        }).catch(() => {});
      }
      const settleBudgetMs = Math.max(0, deadlineAt - Date.now());
      if (settleBudgetMs > 0) {
        await page.waitForTimeout(Math.max(750, Math.min(4_000, SESSION_WAIT_MS, settleBudgetMs)));
      }
      const challengeWaitBudgetMs = Math.max(
        0,
        Math.min(this.slotServerId === 4 ? 8_000 : 12_000, timeoutMs, deadlineAt - Date.now())
      );
      await this.waitOutChallengeIfNeeded(challengeWaitBudgetMs).catch(() => false);
      await this.drainDomCandidates();
      if (!this.candidates.size && deadlineAt - Date.now() > 0) {
        await page.waitForTimeout(Math.max(500, Math.min(2_500, SESSION_RETRY_WAIT_MS, deadlineAt - Date.now())));
        await this.drainDomCandidates();
      }
      if (this.pendingTasks.size && deadlineAt - Date.now() > 0) {
        await Promise.race([
          Promise.allSettled(Array.from(this.pendingTasks)),
          sleep(Math.max(250, Math.min(3_000, deadlineAt - Date.now()))),
        ]).catch(() => {});
      }
      if ((!this.candidates.size || this.pageQueue.length) && deadlineAt - Date.now() > 0) {
        await this.crawlQueuedPages(Math.max(3_000, deadlineAt - Date.now()));
      }
      if (deadlineAt - Date.now() > 0) {
        await this.hydrateCandidateBodiesInPage();
      }
      this.lastReloadAt = Date.now();
    });
  }

  startMaintenanceLoop() {
    if (this.maintenanceTimer) return;
    this.maintenanceTimer = setInterval(() => {
      if (this.state === "closed") return;
      void this.maintain().catch(() => {});
    }, SESSION_MAINTENANCE_INTERVAL_MS);
  }

  async ensureStarted(timeoutMs: number) {
    if (this.startPromise) {
      await this.startPromise;
      return;
    }
    if (this.page && !this.page.isClosed?.() && this.browserContext) {
      this.startMaintenanceLoop();
      return;
    }
    this.startPromise = (async () => {
      if (!ENABLE_LIVE_EMBED_SESSION) throw new Error("live-embed-session-disabled");
      if (!this.sourceUrl || !this.requestOrigin || !this.playbackUrl) {
        throw new Error("invalid-live-embed-session-input");
      }

      let context: PlaywrightContext | null = null;
      let page: PlaywrightPage | null = null;
      let lastContextError: unknown = null;
      for (let attempt = 0; attempt < 2; attempt += 1) {
        try {
          const browser = (await loadBrowser()) as PlaywrightBrowser;
          context = await browser.newContext({
            ignoreHTTPSErrors: true,
            locale: "ar-EG",
            userAgent: DEFAULT_USER_AGENT,
            viewport: { width: 1440, height: 900 },
            extraHTTPHeaders: {
              "accept-language": "ar,en-US;q=0.9,en;q=0.8",
            },
          });
          const extractorInitScript = createExtractorInitScript();
          if (typeof context.addInitScript === "function") {
            await context.addInitScript(extractorInitScript);
          }
          page = await context.newPage();
          if (typeof page.addInitScript === "function") {
            await page.addInitScript(extractorInitScript);
          }
          this.browserContext = context;
          this.page = page;
          await this.attachPageHandlers(page);
          lastContextError = null;
          break;
        } catch (error) {
          lastContextError = error;
          await page?.close().catch(() => {});
          await context?.close().catch(() => {});
          this.page = null;
          this.browserContext = null;
          const message = error instanceof Error ? error.message : String(error || "");
          if (attempt === 0 && /target page, context or browser has been closed/i.test(message)) {
            await closeBrowser().catch(() => {});
            continue;
          }
          throw error;
        }
      }
      if (!page || !context) {
        throw (lastContextError instanceof Error ? lastContextError : new Error("live-embed-browser-context-failed"));
      }

      try {
        await this.primePage(timeoutMs);
        this.state = "running";
        this.lastError = "";
      } catch (error) {
        this.lastError = error instanceof Error ? error.message : String(error || "live-embed-start-failed");
        this.state = "closed";
        await page.close().catch(() => {});
        await context.close().catch(() => {});
        this.page = null;
        this.browserContext = null;
        throw error;
      }
      this.startMaintenanceLoop();
    })().finally(() => {
      this.startPromise = null;
    });
    await this.startPromise;
  }

  async maybeReload(timeoutMs: number) {
    const now = Date.now();
    if (now - this.lastReloadAt < SESSION_RELOAD_COOLDOWN_MS) return;
    if (this.reloadPromise) {
      await this.reloadPromise;
      return;
    }
    this.reloadPromise = (async () => {
      const page = this.page;
      if (!page || page.isClosed?.()) throw new Error("browser-page-closed");
      await this.primePage(timeoutMs);
    })().finally(() => {
      this.reloadPromise = null;
    });
    await this.reloadPromise;
  }

  async maintain() {
    if (this.maintenancePromise) return this.maintenancePromise;
    this.maintenancePromise = (async () => {
      const page = this.page;
      if (!page || page.isClosed?.()) return;
      this.pruneStaleCandidates();
      const now = Date.now();
      const newestAgeMs = this.newestCandidateAgeMs(now);
      const shouldHydrate = this.snapshotCandidates().some((candidate) => !candidate.manifestBody);
      if (shouldHydrate) {
        await this.hydrateCandidateBodiesInPage();
      }
      const shouldReload =
        !this.candidates.size ||
        newestAgeMs === null ||
        newestAgeMs >= SESSION_PREEMPTIVE_REFRESH_MS ||
        !this.hasFreshCandidate(now) ||
        (this.lastActivityAt > 0 && now - this.lastActivityAt >= SESSION_PREEMPTIVE_REFRESH_MS);
      if (this.slotServerId === 2 && (newestAgeMs === null || newestAgeMs >= SESSION_PREEMPTIVE_REFRESH_MS)) {
        await this.refreshEmbedRuntime("session_maintain").catch(() => {});
      }
      if (shouldReload) {
        await this.maybeReload(Math.max(8_000, SESSION_WAIT_MS + SESSION_RETRY_WAIT_MS)).catch(() => {});
      }
    })().finally(() => {
      this.maintenancePromise = null;
    });
    return this.maintenancePromise;
  }

  async snapshot(timeoutMs: number): Promise<SessionSnapshotResult> {
    if (!ENABLE_LIVE_EMBED_SESSION) {
      return { ok: false, playbackUrl: "", error: "live-embed-session-disabled", candidates: [] };
    }
    if (!this.sourceUrl || !this.requestOrigin || !this.playbackUrl) {
      return { ok: false, playbackUrl: "", error: "invalid-live-embed-session-input", candidates: [] };
    }

    try {
      await this.ensureStarted(timeoutMs);
      await this.maintain();
    } catch {
      return { ok: false, playbackUrl: this.playbackUrl, error: this.lastError || "live-embed-session-failed", candidates: [] };
    }

    const deadline = Date.now() + Math.max(2_500, Math.min(25_000, timeoutMs));
    while (Date.now() < deadline) {
      this.touch();
      this.pruneStaleCandidates();
      const now = Date.now();
      const candidates = this.snapshotCandidates();
      const freshManifestCandidates = this.snapshotCandidatesWithManifestBody(SESSION_STALE_MS, now);
      const reusableManifestCandidates = this.snapshotCandidatesWithManifestBody(SESSION_STALE_RETURN_MAX_AGE_MS, now);
      const newestAgeMs = this.newestCandidateAgeMs(now);
      if (freshManifestCandidates.length) {
        return { ok: true, playbackUrl: this.playbackUrl, candidates, error: "" };
      }
      if (
        reusableManifestCandidates.length &&
        candidates.length &&
        newestAgeMs !== null &&
        newestAgeMs <= SESSION_PREEMPTIVE_REFRESH_MS
      ) {
        return { ok: true, playbackUrl: this.playbackUrl, candidates, error: "" };
      }

      const shouldReload =
        !candidates.length ||
        newestAgeMs === null ||
        newestAgeMs >= SESSION_PREEMPTIVE_REFRESH_MS ||
        !this.hasFreshCandidate(now);
      if (!freshManifestCandidates.length && candidates.length) {
        await this.hydrateCandidateBodiesInPage();
      }
      if (this.slotServerId === 2 && (!freshManifestCandidates.length || newestAgeMs === null || newestAgeMs >= SESSION_PREEMPTIVE_REFRESH_MS)) {
        await this.refreshEmbedRuntime("snapshot_refresh").catch(() => {});
      }
      if (shouldReload) {
        await this.maybeReload(timeoutMs).catch(() => {});
      }
      if (this.page && !this.page.isClosed?.()) {
        await this.page.waitForTimeout(350);
      } else {
        await sleep(350);
      }
    }

    const staleCandidates = this.snapshotCandidates();
    const staleManifestCandidates = this.snapshotCandidatesWithManifestBody(SESSION_STALE_RETURN_MAX_AGE_MS);
    const newestAgeMs = this.newestCandidateAgeMs();
    if (staleManifestCandidates.length) {
      return { ok: true, playbackUrl: this.playbackUrl, candidates: staleCandidates, error: "" };
    }
    if (staleCandidates.length && newestAgeMs !== null && newestAgeMs <= SESSION_STALE_RETURN_MAX_AGE_MS) {
      return {
        ok: false,
        playbackUrl: this.playbackUrl,
        candidates: staleCandidates,
        error: this.lastError || "live-embed-manifest-body-missing",
      };
    }
    return { ok: false, playbackUrl: this.playbackUrl, candidates: [], error: this.lastError || "live-embed-empty" };
  }

  async fetchText(
    input: { targetUrl: string; fetchUrl?: string; referrerUrl?: string | null; retryDepth?: number },
    timeoutMs: number
  ): Promise<SessionTextResult> {
    if (!ENABLE_LIVE_EMBED_SESSION) {
      return { ok: false, status: 0, contentType: "", body: "", finalUrl: "", error: "live-embed-session-disabled" };
    }
    const normalizedTargetUrl = normalizeHttpUrl(input.targetUrl);
    if (!normalizedTargetUrl) {
      return { ok: false, status: 0, contentType: "", body: "", finalUrl: "", error: "invalid-live-embed-text-url" };
    }
    const normalizedFetchUrl = normalizeHttpUrl(input.fetchUrl || normalizedTargetUrl) || normalizedTargetUrl;
    const normalizedReferrerUrl =
      normalizeHttpUrl(input.referrerUrl || this.fallbackReferrer || this.sourceUrl) || this.sourceUrl;
    const retryDepth = Math.max(0, Number.parseInt(String(input.retryDepth || 0), 10) || 0);

    try {
      await this.ensureStarted(timeoutMs);
      this.startMaintenanceLoop();
    } catch {
      return {
        ok: false,
        status: 0,
        contentType: "",
        body: "",
        finalUrl: normalizedTargetUrl,
        error: this.lastError || "live-embed-session-failed",
      };
    }

    const page = this.page;
    if (!page || page.isClosed?.()) {
      return {
        ok: false,
        status: 0,
        contentType: "",
        body: "",
        finalUrl: normalizedTargetUrl,
        error: this.lastError || "browser-page-closed",
      };
    }

    try {
      const fetched = await page.evaluate(
        async ({ targetUrl, timeoutMs: browserTimeoutMs }) => {
          try {
            const controller = new AbortController();
            const timeoutId = window.setTimeout(() => controller.abort(), browserTimeoutMs);
            const response = await fetch(targetUrl, {
              method: "GET",
              cache: "no-store",
              credentials: "include",
              signal: controller.signal,
            }).finally(() => window.clearTimeout(timeoutId));
            const body = await response.text().catch(() => "");
            return {
              ok: response.ok,
              status: Number(response.status || 0),
              contentType: String(response.headers.get("content-type") || ""),
              body,
              finalUrl: String(response.url || targetUrl),
              error: response.ok ? "" : `text-http-${Number(response.status || 0)}`,
            };
          } catch (error) {
            return {
              ok: false,
              status: 0,
              contentType: "",
              body: "",
              finalUrl: targetUrl,
              error: error instanceof Error ? error.message : String(error || "live-embed-text-fetch-failed"),
            };
          }
        },
        {
          targetUrl: normalizedFetchUrl,
          timeoutMs: Math.max(4_000, Math.min(30_000, timeoutMs)),
        }
      );

      let finalUrl = normalizeHttpUrl(String(fetched?.finalUrl || normalizedTargetUrl)) || normalizedTargetUrl;
      let body = String(fetched?.body || "");
      let contentType = String(fetched?.contentType || "");
      let ok = !!fetched?.ok;
      let error = String(fetched?.error || "");
      let status = Number(fetched?.status || 0);

      const shouldAttemptDirectServerFetch =
        (!ok || !body.trim() || !hasHlsManifestBody(contentType, body)) &&
        (!sameOrigin(normalizedFetchUrl, this.requestOrigin) || !sameOrigin(normalizedTargetUrl, this.requestOrigin));
      if (shouldAttemptDirectServerFetch) {
        const directFetchUrl = !sameOrigin(normalizedFetchUrl, this.requestOrigin)
          ? normalizedFetchUrl
          : normalizedTargetUrl;
        const direct = await fetchTextDocument({
          url: directFetchUrl,
          referrerUrl: normalizedReferrerUrl,
          timeoutMs,
        });
        const directFinalUrl =
          normalizeHttpUrl(direct.targetUrl || "") ||
          unwrapProxyTarget(direct.finalUrl || "") ||
          normalizedTargetUrl;
        const directLooksLikeManifest = hasHlsManifestBody(direct.contentType, direct.body);
        if (direct.ok && direct.body.trim() && directLooksLikeManifest) {
          ok = true;
          body = direct.body;
          contentType = direct.contentType;
          finalUrl = directFinalUrl;
          error = "";
          status = Number(direct.status || status || 200);
        } else if (!ok) {
          ok = direct.ok;
          body = direct.body;
          contentType = direct.contentType;
          finalUrl = directFinalUrl;
          error = String(direct.error || (direct.ok ? "manifest-not-hls" : `text-http-${direct.status || 0}`));
          status = Number(direct.status || status || 0);
        }
      }

      const shouldRelay = !ok || !body.trim() || !hasHlsManifestBody(contentType, body);
      if (shouldRelay) {
        const relayUrl = buildSessionRelayFetchUrl({
          requestOrigin: this.requestOrigin,
          targetUrl: normalizedFetchUrl,
          referrerUrl: normalizedReferrerUrl,
        });
        if (relayUrl) {
          const relayed = await fetchTextDocument({
            url: relayUrl,
            referrerUrl: normalizedReferrerUrl,
            timeoutMs,
          });
          const relayedFinalUrl =
            normalizeHttpUrl(relayed.targetUrl || "") ||
            unwrapProxyTarget(relayed.finalUrl || "") ||
            normalizedTargetUrl;
          const relayedLooksLikeManifest = hasHlsManifestBody(relayed.contentType, relayed.body);
          if (relayed.ok && relayed.body.trim() && relayedLooksLikeManifest) {
            ok = true;
            body = relayed.body;
            contentType = relayed.contentType;
            finalUrl = relayedFinalUrl;
            error = "";
            status = Number(relayed.status || status || 200);
          } else if (!ok) {
            ok = relayed.ok;
            body = relayed.body;
            contentType = relayed.contentType;
            finalUrl = relayedFinalUrl;
            error = String(relayed.error || (relayed.ok ? "manifest-not-hls" : `text-http-${relayed.status || 0}`));
            status = Number(relayed.status || status || 0);
          }
        }
      }

      const shouldAttemptBrowserNavigation =
        retryDepth < 1 &&
        shouldNavigateSeedInBrowser(normalizedTargetUrl) &&
        (!ok ||
          !body.trim() ||
          looksLikeChallengePageHtml(body) ||
          (isDirectCrawlPreferred(normalizedTargetUrl) && !looksLikeManifestResponse(contentType, body, finalUrl)));
      if (shouldAttemptBrowserNavigation) {
        const navigated = await this.navigateSeedInBrowser(
          {
            pageUrl: normalizedTargetUrl,
            referrerUrl: normalizedReferrerUrl,
            depth: 0,
          },
          Math.max(6_000, Math.min(20_000, timeoutMs))
        ).catch(() => false);
        if (navigated) {
          const snapshot = await this.readPageSnapshot().catch(() => ({ url: "", title: "", html: "" }));
          const snapshotHtml = String(snapshot?.html || "");
          const snapshotUrl = normalizeHttpUrl(String(snapshot?.url || "")) || normalizedTargetUrl;
          if (snapshotHtml.trim()) {
            ok = true;
            status = status > 0 ? status : 200;
            contentType = "text/html; charset=utf-8";
            body = snapshotHtml;
            finalUrl = snapshotUrl;
            error = "";
          }
        }
      }

      if ((!ok || !hasHlsManifestBody(contentType, body)) && this.slotServerId === 2 && retryDepth < 1) {
        const errorText = String(error || "");
        const shouldRetryWithRuntimeRefresh =
          status === 0 ||
          status === 403 ||
          status === 404 ||
          errorText.includes("text-http-403") ||
          errorText.includes("text-http-404");
        if (shouldRetryWithRuntimeRefresh && (await this.refreshEmbedRuntime("manifest_retry"))) {
          const retryCandidate = this.snapshotCandidates().find(
            (candidate) =>
              candidate.fetchUrl &&
              candidate.fetchUrl !== normalizedFetchUrl &&
              Math.max(0, Date.now() - candidate.seenAt) <= SESSION_STALE_MS
          );
          if (retryCandidate?.fetchUrl) {
            return this.fetchText(
              {
                targetUrl: retryCandidate.targetUrl,
                fetchUrl: retryCandidate.fetchUrl,
                referrerUrl: retryCandidate.referrerUrl,
                retryDepth: retryDepth + 1,
              },
              timeoutMs
            );
          }
        }
      }

      if (ok && hasHlsManifestBody(contentType, body)) {
        this.rememberCandidate({
          fetchUrl: normalizedFetchUrl,
          targetUrl: unwrapProxyTarget(finalUrl) || finalUrl,
          referrerUrl: normalizedReferrerUrl,
          manifestBody: body,
          manifestBaseUrl: finalUrl,
          via: "network-manifest",
        });
      }
      this.touch();
      return {
        ok,
        status,
        contentType,
        body,
        finalUrl,
        error,
      };
    } catch (error) {
      return {
        ok: false,
        status: 0,
        contentType: "",
        body: "",
        finalUrl: normalizedTargetUrl,
        error: error instanceof Error ? error.message : String(error || "live-embed-text-fetch-failed"),
      };
    }
  }

  async fetchAsset(
    input: { assetUrl: string; referrerUrl?: string | null },
    timeoutMs: number
  ): Promise<SessionAssetResult> {
    if (!ENABLE_LIVE_EMBED_SESSION) {
      return { ok: false, status: 0, contentType: "", bodyBase64: "", error: "live-embed-session-disabled" };
    }
    const normalizedAssetUrl = normalizeHttpUrl(input.assetUrl);
    if (!normalizedAssetUrl) {
      return { ok: false, status: 0, contentType: "", bodyBase64: "", error: "invalid-live-embed-asset-url" };
    }
    const normalizedReferrerUrl =
      normalizeHttpUrl(input.referrerUrl || this.fallbackReferrer || this.sourceUrl) || this.sourceUrl;

    try {
      await this.ensureStarted(timeoutMs);
      this.startMaintenanceLoop();
    } catch {
      return { ok: false, status: 0, contentType: "", bodyBase64: "", error: this.lastError || "live-embed-session-failed" };
    }

    const page = this.page;
    if (!page || page.isClosed?.()) {
      return { ok: false, status: 0, contentType: "", bodyBase64: "", error: this.lastError || "browser-page-closed" };
    }

    try {
      const relayUrl = buildSessionRelayFetchUrl({
        requestOrigin: this.requestOrigin,
        targetUrl: normalizedAssetUrl,
        referrerUrl: normalizedReferrerUrl,
      });
      if (relayUrl) {
        const relayed = await fetchBinaryDocument({
          url: relayUrl,
          referrerUrl: normalizedReferrerUrl,
          timeoutMs,
        });
        if (relayed.ok && relayed.bodyBase64) {
          this.touch();
          return {
            ok: true,
            status: relayed.status,
            contentType: relayed.contentType,
            bodyBase64: relayed.bodyBase64,
            error: "",
          };
        }
      }

      const fetched = await page.evaluate(
        async ({ assetUrl: targetUrl, timeoutMs: browserTimeoutMs }) => {
          try {
            const controller = new AbortController();
            const timeoutId = window.setTimeout(() => controller.abort(), browserTimeoutMs);
            const response = await fetch(targetUrl, {
              method: "GET",
              cache: "no-store",
              credentials: "include",
              signal: controller.signal,
            }).finally(() => window.clearTimeout(timeoutId));
            const contentType = String(response.headers.get("content-type") || "").trim();
            if (!response.ok) {
              return {
                ok: false,
                status: Number(response.status || 0),
                contentType,
                bodyBase64: "",
                error: `asset-http-${Number(response.status || 0)}`,
              };
            }

            const blob = await response.blob();
            const dataUrl = await new Promise<string>((resolve, reject) => {
              const reader = new FileReader();
              reader.onloadend = () => resolve(String(reader.result || ""));
              reader.onerror = () => reject(new Error("live-embed-asset-file-reader-failed"));
              reader.readAsDataURL(blob);
            });
            const bodyBase64 = String(dataUrl || "").split(",", 2)[1] || "";
            return {
              ok: true,
              status: Number(response.status || 200),
              contentType,
              bodyBase64,
              error: "",
            };
          } catch (error) {
            return {
              ok: false,
              status: 0,
              contentType: "",
              bodyBase64: "",
              error: error instanceof Error ? error.message : String(error || "live-embed-asset-fetch-failed"),
            };
          }
        },
        {
          assetUrl: normalizedAssetUrl,
          timeoutMs: Math.max(4_000, Math.min(30_000, timeoutMs)),
        }
      );
      this.touch();
      return {
        ok: !!fetched?.ok,
        status: Number(fetched?.status || 0),
        contentType: String(fetched?.contentType || ""),
        bodyBase64: String(fetched?.bodyBase64 || ""),
        error: String(fetched?.error || ""),
      };
    } catch (error) {
      return {
        ok: false,
        status: 0,
        contentType: "",
        bodyBase64: "",
        error: error instanceof Error ? error.message : String(error || "live-embed-asset-fetch-failed"),
      };
    }
  }

  async close() {
    const page = this.page;
    const context = this.browserContext;
    if (this.maintenanceTimer) clearInterval(this.maintenanceTimer);
    this.maintenanceTimer = null;
    this.page = null;
    this.browserContext = null;
    this.state = "closed";
    if (page) await page.close().catch(() => {});
    if (context) await context.close().catch(() => {});
  }
}

function cleanupIdleSessions() {
  const now = Date.now();
  for (const [key, session] of sessions.entries()) {
    if (!session.isIdle(now)) continue;
    sessions.delete(key);
    void session.close();
  }

  if (sessions.size <= SESSION_MAX_COUNT) {
    if (!sessions.size) {
      void closeBrowser();
    }
    return;
  }
  const overflow = [...sessions.values()]
    .filter((session) => session.isEvictable(now))
    .sort((left, right) => left.lastTouchedAt - right.lastTouchedAt)
    .slice(0, sessions.size - SESSION_MAX_COUNT);
  for (const session of overflow) {
    sessions.delete(session.key);
    void session.close();
  }
  if (!sessions.size) {
    void closeBrowser();
  }
}

function getSession(input: { sourceUrl: string; requestOrigin: string; slotServerId?: SlotServerId }) {
  cleanupIdleSessions();
  const sourceUrl = normalizeHttpUrl(input.sourceUrl);
  const requestOrigin = normalizeHttpUrl(input.requestOrigin);
  const key = `${canonicalizeUrl(sourceUrl)}|${canonicalizeUrl(requestOrigin)}|${String(input.slotServerId || "")}`;
  let session = sessions.get(key);
  if (!session) {
    enforceSessionCapacity(Math.max(0, SESSION_MAX_COUNT - 1));
    session = new LiveEmbedSession({
      sourceUrl,
      requestOrigin,
      slotServerId: input.slotServerId,
    });
    sessions.set(key, session);
    enforceSessionCapacity(SESSION_MAX_COUNT);
  }
  session.touch();
  return session;
}

export async function extractLiveEmbedSessionSnapshot(input: {
  sourceUrl: string;
  requestOrigin: string;
  slotServerId?: SlotServerId;
  timeoutMs: number;
}) {
  const session = getSession(input);
  return session.snapshot(input.timeoutMs);
}

export async function ensureLiveEmbedSessionRuntime(input: {
  sourceUrl: string;
  requestOrigin: string;
  slotServerId?: SlotServerId;
  timeoutMs: number;
}) {
  const session = getSession(input);
  await session.ensureStarted(input.timeoutMs);
  await session.maintain();
  session.touch();
  return session.getRuntimeState();
}

export async function fetchLiveEmbedText(input: {
  sourceUrl: string;
  requestOrigin: string;
  slotServerId?: SlotServerId;
  targetUrl: string;
  fetchUrl?: string;
  referrerUrl?: string | null;
  timeoutMs: number;
}) {
  const session = getSession(input);
  return session.fetchText(
    {
      targetUrl: input.targetUrl,
      fetchUrl: input.fetchUrl,
      referrerUrl: input.referrerUrl,
    },
    input.timeoutMs
  );
}

export async function fetchLiveEmbedAsset(input: {
  sourceUrl: string;
  requestOrigin: string;
  slotServerId?: SlotServerId;
  assetUrl: string;
  referrerUrl?: string | null;
  timeoutMs: number;
}) {
  const session = getSession(input);
  return session.fetchAsset(
    {
      assetUrl: input.assetUrl,
      referrerUrl: input.referrerUrl,
    },
    input.timeoutMs
  );
}

export async function refreshLiveEmbedRuntime(input: {
  sourceUrl: string;
  requestOrigin: string;
  slotServerId?: SlotServerId;
  timeoutMs: number;
  reason?: string;
}) {
  const session = getSession(input);
  await session.ensureStarted(input.timeoutMs);
  const refreshed = await session.refreshEmbedRuntime(String(input.reason || "runtime_refresh"));
  session.touch();
  return {
    ok: refreshed,
    refreshed,
    state: session.getRuntimeState(),
  };
}

export async function rotateLiveEmbedRuntime(input: {
  sourceUrl: string;
  requestOrigin: string;
  slotServerId?: SlotServerId;
  timeoutMs: number;
  reason?: string;
}) {
  const session = getSession(input);
  await session.ensureStarted(input.timeoutMs);
  const rotated = await session.rotateEmbedRuntime(String(input.reason || "runtime_rotate"));
  session.touch();
  return {
    ok: rotated,
    rotated,
    state: session.getRuntimeState(),
  };
}

export function peekLiveEmbedSessionState(input: {
  sourceUrl: string;
  requestOrigin: string;
  slotServerId?: SlotServerId;
}) {
  cleanupIdleSessions();
  const sourceUrl = normalizeHttpUrl(input.sourceUrl);
  const requestOrigin = normalizeHttpUrl(input.requestOrigin);
  const key = `${canonicalizeUrl(sourceUrl)}|${canonicalizeUrl(requestOrigin)}|${String(input.slotServerId || "")}`;
  const session = sessions.get(key);
  if (!session) return null;
  const now = Date.now();
  session.pruneStaleCandidates(now);
  const candidates = session.snapshotCandidates();
  const freshManifestCandidates = session.snapshotCandidatesWithManifestBody(SESSION_STALE_MS, now);
  const freshCandidateCount = candidates.filter((candidate) => now - candidate.seenAt <= SESSION_STALE_MS).length;
  return {
    key: session.key,
    state: session.state,
    lastError: session.lastError,
    playbackUrl: session.playbackUrl,
    lastTouchedAt: session.lastTouchedAt,
    lastActivityAt: session.lastActivityAt,
    candidateCount: candidates.length,
    freshCandidateCount,
    freshManifestCount: freshManifestCandidates.length,
    runtimePath: session.runtimePath,
    runtimeTabIndex: session.runtimeTabIndex,
    runtimeSourceIndex: session.runtimeSourceIndex,
    runtimeSourceCount: session.runtimeSourceCount,
    runtimeActiveSource: session.runtimeActiveSource,
    runtimeSources: session.runtimeSources.slice(),
    runtimeUpdatedAt: session.runtimeUpdatedAt,
    runtimeRefreshing: session.runtimeRefreshing,
    runtimeNetworkRetryCount: session.runtimeNetworkRetryCount,
    runtimeStallRecoverCount: session.runtimeStallRecoverCount,
    runtimeLastProgressAt: session.runtimeLastProgressAt,
    runtimeLastRecoverAt: session.runtimeLastRecoverAt,
    runtimeWatchdogState: session.runtimeWatchdogState,
    lastRefreshReason: session.lastRefreshReason,
    lastRefreshAt: session.lastRefreshAt,
    lastRotateReason: session.lastRotateReason,
    lastRotateAt: session.lastRotateAt,
    lastRuntimeEvent: session.lastRuntimeEvent,
    lastRuntimeEventReason: session.lastRuntimeEventReason,
    lastRuntimeEventAt: session.lastRuntimeEventAt,
    activeManifestUrl: session.activeManifestUrl,
    activeManifestFetchUrl: session.activeManifestFetchUrl,
    activeManifestReferrerUrl: session.activeManifestReferrerUrl,
    activeManifestUpdatedAt: session.activeManifestUpdatedAt,
    activeMediaSequence: session.activeMediaSequence,
    activeTargetDurationSec: session.activeTargetDurationSec,
  };
}

export type { SessionCandidate as LiveEmbedSessionCandidate, SessionRuntimeState as LiveEmbedSessionRuntimeState };
