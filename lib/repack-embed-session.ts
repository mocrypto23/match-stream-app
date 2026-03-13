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

const ENABLE_LIVE_EMBED_SESSION =
  String(process.env.REPACK_LIVE_EMBED_SESSION_ENABLED || "1").trim() !== "0";
const SESSION_IDLE_TTL_MS = Math.max(
  20_000,
  Number.parseInt(String(process.env.REPACK_LIVE_EMBED_SESSION_IDLE_TTL_MS || "120000"), 10) || 120_000
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
  Number.parseInt(String(process.env.REPACK_LIVE_EMBED_SESSION_MAX_COUNT || "10"), 10) || 10
);
const SESSION_MAX_CANDIDATES = Math.max(
  4,
  Number.parseInt(String(process.env.REPACK_LIVE_EMBED_SESSION_MAX_CANDIDATES || "24"), 10) || 24
);
const SESSION_MAINTENANCE_INTERVAL_MS = Math.max(
  1_500,
  Number.parseInt(String(process.env.REPACK_LIVE_EMBED_SESSION_MAINTENANCE_INTERVAL_MS || "4000"), 10) || 4_000
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

type PageSeed = {
  pageUrl: string;
  referrerUrl: string;
  depth: number;
};

type PlaywrightBrowser = {
  newContext: (input: unknown) => Promise<PlaywrightContext>;
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
const sessions = new Map<string, LiveEmbedSession>();

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

function hostMatchesAnySuffix(hostname: string, suffixes: string[]) {
  const host = String(hostname || "").trim().toLowerCase().replace(/\.$/, "");
  if (!host) return false;
  return suffixes.some((suffix) => host === suffix || host.endsWith(`.${suffix}`));
}

function isDirectCrawlPreferred(rawUrl: string) {
  if (!isValidHttpUrl(rawUrl)) return false;
  try {
    const host = new URL(rawUrl).hostname.toLowerCase();
    return hostMatchesAnySuffix(host, ["sportsurges.cc", "livekora.vip", "koooralive.click", "kooraxx.com"]);
  } catch {
    return false;
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
    if (!hostMatchesAnySuffix(host, ["sportsurges.cc", "livekora.vip", "koooralive.click", "kooraxx.com"])) {
      return [] as string[];
    }

    const pathParts = String(parsed.pathname || "")
      .split("/")
      .map((item) => item.trim())
      .filter(Boolean);
    const pageSlug = pathParts[0] === "albaplayer" ? pathParts[1] || "" : pathParts[0] || "";
    const slugVariants = buildSlugVariants(pageSlug);
    const origin = parsed.origin;
    const out = new Set<string>();

    for (const slug of slugVariants) {
      out.add(`${origin}/${slug}/`);
      out.add(`${origin}/albaplayer/${slug}/`);
      for (const serv of ["0", "1", "2", "3", "4"]) {
        out.add(`${origin}/albaplayer/${slug}/?serv=${serv}`);
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
      host.endsWith(".yallashoot2026.com") ||
      host === "yallashoot2026.com" ||
      host.endsWith(".yallashot.us") ||
      host === "yallashot.us"
    );
  } catch {
    return false;
  }
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

async function loadBrowser() {
  if (!browserPromise) {
    browserPromise = (async () => {
      const { chromium } = (await import("playwright")) as { chromium: { launch: (input: unknown) => Promise<unknown> } };
      return chromium.launch({
        headless: true,
        args: ["--disable-dev-shm-usage", "--disable-blink-features=AutomationControlled", "--no-sandbox"],
      });
    })().catch((error) => {
      browserPromise = null;
      throw error;
    });
  }
  return browserPromise;
}

async function sleep(ms: number) {
  await new Promise((resolve) => setTimeout(resolve, ms));
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

function createExtractorInitScript() {
  return () => {
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

  constructor(input: { sourceUrl: string; requestOrigin: string; slotServerId?: SlotServerId }) {
    this.sourceUrl = normalizeHttpUrl(input.sourceUrl);
    this.requestOrigin = normalizeHttpUrl(input.requestOrigin);
    this.slotServerId = input.slotServerId;
    this.playbackUrl = isDirectCrawlPreferred(this.sourceUrl)
      ? this.sourceUrl
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

  snapshotCandidates() {
    return [...this.candidates.values()]
      .sort((left, right) => {
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
    while (this.pageQueue.length && crawledPages < SESSION_MAX_CRAWL_PAGES) {
      const next = this.pageQueue.shift();
      if (!next) continue;
      if (next.depth > SESSION_MAX_CRAWL_DEPTH) continue;
      const key = canonicalizeUrl(next.pageUrl) || next.pageUrl.toLowerCase();
      if (!key || visited.has(key)) continue;
      visited.add(key);
      crawledPages += 1;

      const pageFetchUrl = isDirectCrawlPreferred(next.pageUrl)
        ? next.pageUrl
        : buildPlaybackProxyUrl({
            sourceUrl: next.pageUrl,
            requestOrigin: this.requestOrigin,
            referrerUrl: next.referrerUrl,
          });
      if (!pageFetchUrl) continue;

      const fetched = await fetchTextDocument({
        url: pageFetchUrl,
        referrerUrl: next.referrerUrl,
        timeoutMs: Math.min(SESSION_PAGE_FETCH_TIMEOUT_MS, timeoutMs),
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

  async drainDomCandidates() {
    const page = this.page;
    if (!page || page.isClosed?.()) return;
    const drained = await page.evaluate(() => {
      const drain = (
        window as unknown as {
          __tfExtractorDrain?: () => { urls: string[]; dom: string[] };
        }
      ).__tfExtractorDrain;
      return typeof drain === "function" ? drain() : { urls: [], dom: [] };
    });

    for (const rawValue of [...(drained?.urls || []), ...(drained?.dom || [])]) {
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

  async hydrateCandidateBodiesInPage() {
    const page = this.page;
    if (!page || page.isClosed?.()) return;
    const pendingTargets = this.snapshotCandidates()
      .filter((candidate) => !candidate.manifestBody)
      .map((candidate) => ({
        fetchUrl: candidate.fetchUrl || candidate.targetUrl,
        targetUrl: candidate.targetUrl,
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
                finalUrl: String(response.url || pendingTarget.fetchUrl),
                status: Number(response.status || 0),
                body,
                contentType: String(response.headers.get("content-type") || ""),
              });
            } catch {
              out.push({
                fetchUrl: pendingTarget.fetchUrl,
                targetUrl: pendingTarget.targetUrl,
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
        const finalUrl = normalizeHttpUrl(String(item?.finalUrl || targetUrl).trim()) || targetUrl;
        const body = String(item?.body || "").trim();
        const status = Number(item?.status || 0);
        const contentType = String(item?.contentType || "").trim();
        if (!targetUrl || status < 200 || status >= 300) continue;
        if (!looksLikeManifestResponse(contentType, body, finalUrl)) continue;
        this.rememberCandidate({
          fetchUrl: String(item?.fetchUrl || finalUrl).trim(),
          targetUrl,
          referrerUrl: this.fallbackReferrer,
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

          if (looksLikeManifestResponse(contentType, body, targetUrl)) {
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
    const page = this.page;
    if (!page || page.isClosed?.()) throw new Error("browser-page-closed");

    this.seedSourceVariants();
    await page.goto(this.playbackUrl, {
      waitUntil: "domcontentloaded",
      timeout: Math.max(7_000, Math.min(35_000, timeoutMs)),
    });
    if (typeof page.waitForLoadState === "function") {
      await page.waitForLoadState("networkidle", {
        timeout: Math.min(5_000, SESSION_NETWORK_IDLE_WAIT_MS),
      }).catch(() => {});
    }
    await page.waitForTimeout(Math.max(2_000, Math.min(12_000, SESSION_WAIT_MS)));
    await this.drainDomCandidates();
    if (!this.candidates.size) {
      await page.waitForTimeout(Math.min(6_000, SESSION_RETRY_WAIT_MS));
      await this.drainDomCandidates();
    }
    if (this.pendingTasks.size) {
      await Promise.allSettled(Array.from(this.pendingTasks));
    }
    if (!this.candidates.size || this.pageQueue.length) {
      await this.crawlQueuedPages(timeoutMs);
    }
    await this.hydrateCandidateBodiesInPage();
    this.lastReloadAt = Date.now();
  }

  startMaintenanceLoop() {
    if (this.maintenanceTimer) return;
    this.maintenanceTimer = setInterval(() => {
      if (this.state === "closed") return;
      void this.maintain().catch(() => {});
    }, SESSION_MAINTENANCE_INTERVAL_MS);
  }

  async ensureStarted(timeoutMs: number) {
    if (this.page && !this.page.isClosed?.() && this.browserContext) {
      this.startMaintenanceLoop();
      return;
    }
    if (this.startPromise) {
      await this.startPromise;
      return;
    }
    this.startPromise = (async () => {
      if (!ENABLE_LIVE_EMBED_SESSION) throw new Error("live-embed-session-disabled");
      if (!this.sourceUrl || !this.requestOrigin || !this.playbackUrl) {
        throw new Error("invalid-live-embed-session-input");
      }

      const browser = (await loadBrowser()) as PlaywrightBrowser;
      const context = await browser.newContext({
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
      const page = await context.newPage();
      if (typeof page.addInitScript === "function") {
        await page.addInitScript(extractorInitScript);
      }
      this.browserContext = context;
      this.page = page;
      await this.attachPageHandlers(page);

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

  async fetchText(targetUrl: string, timeoutMs: number): Promise<SessionTextResult> {
    if (!ENABLE_LIVE_EMBED_SESSION) {
      return { ok: false, status: 0, contentType: "", body: "", finalUrl: "", error: "live-embed-session-disabled" };
    }
    const normalizedTargetUrl = normalizeHttpUrl(targetUrl);
    if (!normalizedTargetUrl) {
      return { ok: false, status: 0, contentType: "", body: "", finalUrl: "", error: "invalid-live-embed-text-url" };
    }

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
          targetUrl: normalizedTargetUrl,
          timeoutMs: Math.max(4_000, Math.min(30_000, timeoutMs)),
        }
      );

      const finalUrl = normalizeHttpUrl(String(fetched?.finalUrl || normalizedTargetUrl)) || normalizedTargetUrl;
      const body = String(fetched?.body || "");
      const contentType = String(fetched?.contentType || "");
      const ok = !!fetched?.ok;
      if (ok && looksLikeManifestResponse(contentType, body, finalUrl)) {
        this.rememberCandidate({
          targetUrl: finalUrl,
          referrerUrl: this.fallbackReferrer,
          manifestBody: body,
          manifestBaseUrl: finalUrl,
          via: "network-manifest",
        });
      }
      this.touch();
      return {
        ok,
        status: Number(fetched?.status || 0),
        contentType,
        body,
        finalUrl,
        error: String(fetched?.error || ""),
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

  async fetchAsset(assetUrl: string, timeoutMs: number): Promise<SessionAssetResult> {
    if (!ENABLE_LIVE_EMBED_SESSION) {
      return { ok: false, status: 0, contentType: "", bodyBase64: "", error: "live-embed-session-disabled" };
    }
    const normalizedAssetUrl = normalizeHttpUrl(assetUrl);
    if (!normalizedAssetUrl) {
      return { ok: false, status: 0, contentType: "", bodyBase64: "", error: "invalid-live-embed-asset-url" };
    }

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

  if (sessions.size <= SESSION_MAX_COUNT) return;
  const overflow = [...sessions.values()]
    .sort((left, right) => left.lastTouchedAt - right.lastTouchedAt)
    .slice(0, sessions.size - SESSION_MAX_COUNT);
  for (const session of overflow) {
    sessions.delete(session.key);
    void session.close();
  }
}

function getSession(input: { sourceUrl: string; requestOrigin: string; slotServerId?: SlotServerId }) {
  cleanupIdleSessions();
  const sourceUrl = normalizeHttpUrl(input.sourceUrl);
  const requestOrigin = normalizeHttpUrl(input.requestOrigin);
  const key = `${canonicalizeUrl(sourceUrl)}|${canonicalizeUrl(requestOrigin)}|${String(input.slotServerId || "")}`;
  let session = sessions.get(key);
  if (!session) {
    session = new LiveEmbedSession({
      sourceUrl,
      requestOrigin,
      slotServerId: input.slotServerId,
    });
    sessions.set(key, session);
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

export async function fetchLiveEmbedText(input: {
  sourceUrl: string;
  requestOrigin: string;
  slotServerId?: SlotServerId;
  targetUrl: string;
  timeoutMs: number;
}) {
  const session = getSession(input);
  return session.fetchText(input.targetUrl, input.timeoutMs);
}

export async function fetchLiveEmbedAsset(input: {
  sourceUrl: string;
  requestOrigin: string;
  slotServerId?: SlotServerId;
  assetUrl: string;
  timeoutMs: number;
}) {
  const session = getSession(input);
  return session.fetchAsset(input.assetUrl, input.timeoutMs);
}

export type { SessionCandidate as LiveEmbedSessionCandidate };
