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

const ENABLE_BROWSER_EXTRACTOR =
  String(process.env.REPACK_BROWSER_EXTRACTOR_ENABLED || "1").trim() !== "0";
const EXTRACTOR_CACHE_TTL_MS = Math.max(
  5_000,
  Number.parseInt(String(process.env.REPACK_BROWSER_EXTRACTOR_CACHE_TTL_MS || "15000"), 10) || 15_000
);
const EXTRACTOR_WAIT_MS = Math.max(
  2_000,
  Number.parseInt(String(process.env.REPACK_BROWSER_EXTRACTOR_WAIT_MS || "7000"), 10) || 7_000
);
const EXTRACTOR_RETRY_WAIT_MS = Math.max(
  1_000,
  Number.parseInt(String(process.env.REPACK_BROWSER_EXTRACTOR_RETRY_WAIT_MS || "2500"), 10) || 2_500
);
const EXTRACTOR_NETWORK_IDLE_WAIT_MS = Math.max(
  500,
  Number.parseInt(String(process.env.REPACK_BROWSER_EXTRACTOR_NETWORK_IDLE_WAIT_MS || "1500"), 10) || 1_500
);
const EXTRACTOR_PAGE_FETCH_TIMEOUT_MS = Math.max(
  3_000,
  Number.parseInt(String(process.env.REPACK_BROWSER_EXTRACTOR_PAGE_FETCH_TIMEOUT_MS || "9000"), 10) || 9_000
);
const EXTRACTOR_MAX_CRAWL_PAGES = Math.max(
  4,
  Number.parseInt(String(process.env.REPACK_BROWSER_EXTRACTOR_MAX_CRAWL_PAGES || "12"), 10) || 12
);
const EXTRACTOR_MAX_CRAWL_DEPTH = Math.max(
  1,
  Number.parseInt(String(process.env.REPACK_BROWSER_EXTRACTOR_MAX_CRAWL_DEPTH || "3"), 10) || 3
);

type ExtractorCandidate = {
  ingestUrl: string;
  referrerUrl: string;
  targetUrl: string;
  score: number;
  via: "network-manifest" | "network-request" | "dom";
};

type ExtractorResult = {
  ok: boolean;
  playbackUrl: string;
  error: string;
  candidates: ExtractorCandidate[];
};

type CandidateCacheEntry = {
  expiresAt: number;
  result: ExtractorResult;
};

type CandidateInput = {
  ingestUrl: string;
  referrerUrl: string;
  targetUrl: string;
  body?: string;
  slotServerId?: SlotServerId;
  via: ExtractorCandidate["via"];
};

type PageSeed = {
  pageUrl: string;
  referrerUrl: string;
  depth: number;
};

const candidateCache = new Map<string, CandidateCacheEntry>();
const inflight = new Map<string, Promise<ExtractorResult>>();
let browserPromise: Promise<unknown> | null = null;

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
    if (
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
    ) {
      return true;
    }
    return false;
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
    if (
      search.includes("token=") ||
      search.includes("session") ||
      search.includes("stream=") ||
      search.includes("playlist") ||
      search.includes("m3u8") ||
      search.includes("sid=")
    ) {
      return true;
    }
    return false;
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
    if (!looksLikeManifestUrl(absolute)) return true;
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
  const url = String(finalUrl || "").toLowerCase();
  if (/^\s*#extm3u/m.test(text)) return true;
  if (ct.includes("application/vnd.apple.mpegurl") || ct.includes("application/x-mpegurl")) return true;
  return url.includes(".m3u8");
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

function buildBackendProxyUrl(input: {
  sourceUrl: string;
  requestOrigin: string;
  referrerUrl?: string | null;
}) {
  if (!isValidHttpUrl(input.sourceUrl) || !isValidHttpUrl(input.requestOrigin)) return "";
  const params = new URLSearchParams();
  params.set("url", input.sourceUrl);
  params.set("depth", "0");
  params.set("backend", "1");
  const ref = normalizeHttpUrl(input.referrerUrl || input.sourceUrl);
  if (ref) params.set("ref", ref);
  return `${String(input.requestOrigin || "").replace(/\/+$/, "")}/api/embed-proxy?${params.toString()}`;
}

function unwrapProxyTarget(rawUrl: string) {
  if (!isValidHttpUrl(rawUrl)) return "";
  try {
    const parsed = new URL(rawUrl);
    if (!String(parsed.pathname || "").toLowerCase().includes("/api/embed-proxy")) return parsed.toString();
    const target = safeDecodeURIComponent(String(parsed.searchParams.get("url") || "").trim());
    return normalizeHttpUrl(target);
  } catch {
    return "";
  }
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

function scoreCandidate(input: CandidateInput) {
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

function pushCandidate(
  candidates: Map<string, ExtractorCandidate>,
  input: CandidateInput
) {
  const targetUrl = normalizeHttpUrl(input.targetUrl);
  const referrerUrl = normalizeHttpUrl(input.referrerUrl || targetUrl);
  const ingestUrl = normalizeHttpUrl(input.ingestUrl);
  if (!targetUrl || !referrerUrl || !ingestUrl) return;

  const key = canonicalizeUrl(ingestUrl) || ingestUrl.toLowerCase();
  const next: ExtractorCandidate = {
    ingestUrl,
    referrerUrl,
    targetUrl,
    score: scoreCandidate(input),
    via: input.via,
  };
  const prev = candidates.get(key);
  if (!prev || next.score > prev.score) {
    candidates.set(key, next);
  }
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

async function fetchTextDocument(input: { url: string; referrerUrl?: string; timeoutMs?: number }) {
  const controller = new AbortController();
  const timeoutId = setTimeout(
    () => controller.abort(),
    Math.max(2_000, Number.parseInt(String(input.timeoutMs || EXTRACTOR_PAGE_FETCH_TIMEOUT_MS), 10) || EXTRACTOR_PAGE_FETCH_TIMEOUT_MS)
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

async function runBrowserExtraction(input: {
  sourceUrl: string;
  requestOrigin: string;
  slotServerId?: SlotServerId;
  timeoutMs: number;
}): Promise<ExtractorResult> {
  const sourceUrl = normalizeHttpUrl(input.sourceUrl);
  const requestOrigin = normalizeHttpUrl(input.requestOrigin);
  if (!ENABLE_BROWSER_EXTRACTOR) {
    return { ok: false, playbackUrl: "", error: "browser-extractor-disabled", candidates: [] };
  }
  if (!sourceUrl || !requestOrigin) {
    return { ok: false, playbackUrl: "", error: "invalid-browser-extractor-input", candidates: [] };
  }

  const playbackUrl = buildPlaybackProxyUrl({
    sourceUrl,
    requestOrigin,
    referrerUrl: sourceUrl,
  });
  if (!playbackUrl) {
    return { ok: false, playbackUrl: "", error: "browser-extractor-invalid-playback-url", candidates: [] };
  }

  const browser = (await loadBrowser()) as {
    newContext: (input: unknown) => Promise<{
      addInitScript?: (script: () => void) => Promise<void>;
      newPage: () => Promise<{
        addInitScript?: (script: () => void) => Promise<void>;
        on: (event: string, handler: (arg: unknown) => void) => void;
        goto: (url: string, options: unknown) => Promise<unknown>;
        waitForLoadState?: (state: string, options?: { timeout?: number }) => Promise<void>;
        waitForTimeout: (ms: number) => Promise<void>;
        evaluate: <T>(handler: () => T | Promise<T>) => Promise<T>;
        close: () => Promise<void>;
      }>;
      close: () => Promise<void>;
    }>;
  };

  const candidates = new Map<string, ExtractorCandidate>();
  const pageSeeds = new Map<string, PageSeed>();
  const pageQueue: PageSeed[] = [];
  const pendingTasks = new Set<Promise<void>>();
  const context = await browser.newContext({
    ignoreHTTPSErrors: true,
    locale: "ar-EG",
    userAgent: DEFAULT_USER_AGENT,
    viewport: { width: 1440, height: 900 },
    extraHTTPHeaders: {
      "accept-language": "ar,en-US;q=0.9,en;q=0.8",
    },
  });

  const extractorInitScript = () => {
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
        .map((node) => ("href" in node ? node.href : ("src" in node ? node.src : "")))
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

  if (typeof context.addInitScript === "function") {
    await context.addInitScript(extractorInitScript);
  }
  const page = await context.newPage();
  if (typeof page.addInitScript === "function") {
    await page.addInitScript(extractorInitScript);
  }

  const enqueuePageSeed = (rawUrl: string, referrerUrl: string, depth: number) => {
    const normalizedRawUrl = normalizeHttpUrl(rawUrl);
    if (!normalizedRawUrl) return;
    const pageUrl = unwrapProxyTarget(normalizedRawUrl) || normalizedRawUrl;
    if (!looksLikeNavigableStreamPage(pageUrl)) return;
    const safeReferrer =
      normalizeHttpUrl(extractProxyReferrer(normalizedRawUrl) || referrerUrl || sourceUrl) || sourceUrl;
    const key = canonicalizeUrl(pageUrl) || pageUrl.toLowerCase();
    if (!key) return;
    const next: PageSeed = {
      pageUrl,
      referrerUrl: safeReferrer,
      depth,
    };
    const previous = pageSeeds.get(key);
    if (previous && previous.depth <= depth) return;
    pageSeeds.set(key, next);
    pageQueue.push(next);
  };

  const registerUrl = (inputValue: {
    rawUrl: string;
    referrerUrl: string;
    via: CandidateInput["via"];
    body?: string;
    depth?: number;
  }) => {
    const rawUrl = normalizeHttpUrl(inputValue.rawUrl);
    if (!rawUrl) return;
    const targetUrl = unwrapProxyTarget(rawUrl) || rawUrl;
    const referrerUrl =
      normalizeHttpUrl(extractProxyReferrer(rawUrl) || inputValue.referrerUrl || sourceUrl) || sourceUrl;
    if (looksLikeManifestUrl(targetUrl)) {
      const ingestUrl = buildBackendProxyUrl({
        sourceUrl: targetUrl,
        requestOrigin,
        referrerUrl,
      });
      pushCandidate(candidates, {
        ingestUrl,
        referrerUrl,
        targetUrl,
        body: inputValue.body,
        slotServerId: input.slotServerId,
        via: inputValue.via,
      });
      return;
    }
    enqueuePageSeed(targetUrl, referrerUrl, Math.max(0, Number(inputValue.depth || 0)));
  };

  const registerExtractedText = async (inputValue: {
    text: string;
    pageUrl: string;
    sourceUrl: string;
    referrerUrl: string;
    depth: number;
  }) => {
    const pageUrl = normalizeHttpUrl(inputValue.pageUrl);
    const sourcePageUrl = normalizeHttpUrl(inputValue.sourceUrl) || pageUrl;
    const referrerUrl = normalizeHttpUrl(inputValue.referrerUrl || sourcePageUrl) || sourceUrl;
    if (!pageUrl || !sourcePageUrl || !String(inputValue.text || "").trim()) return;

    for (const candidateUrl of extractCandidatesFromText(inputValue.text, pageUrl)) {
      registerUrl({
        rawUrl: candidateUrl,
        referrerUrl,
        via: "dom",
        depth: inputValue.depth + 1,
      });
    }

    const beinCandidates = await fetchBeinAjaxResolvedCandidates(
      sourcePageUrl,
      inputValue.text,
      Math.min(EXTRACTOR_PAGE_FETCH_TIMEOUT_MS, input.timeoutMs)
    );
    for (const candidateUrl of beinCandidates) {
      registerUrl({
        rawUrl: candidateUrl,
        referrerUrl: sourcePageUrl,
        via: "dom",
        depth: inputValue.depth + 1,
      });
    }

    if (looksLikePlayerv2PageUrl(sourcePageUrl) || looksLikePlayerv2Html(inputValue.text)) {
      const playerv2Candidates = await buildPlayerv2Candidates(
        sourcePageUrl,
        inputValue.text,
        Math.min(EXTRACTOR_PAGE_FETCH_TIMEOUT_MS, input.timeoutMs),
        requestOrigin
      );
      for (const candidateUrl of playerv2Candidates) {
        registerUrl({
          rawUrl: candidateUrl,
          referrerUrl: sourcePageUrl,
          via: "dom",
          depth: inputValue.depth + 1,
        });
      }
    }
  };

  const crawlQueuedPages = async () => {
    let crawledPages = 0;
    const visited = new Set<string>();
    while (pageQueue.length && crawledPages < EXTRACTOR_MAX_CRAWL_PAGES) {
      const next = pageQueue.shift();
      if (!next) continue;
      if (next.depth > EXTRACTOR_MAX_CRAWL_DEPTH) continue;
      const key = canonicalizeUrl(next.pageUrl) || next.pageUrl.toLowerCase();
      if (!key || visited.has(key)) continue;
      visited.add(key);
      crawledPages += 1;

      const playbackPageUrl = buildPlaybackProxyUrl({
        sourceUrl: next.pageUrl,
        requestOrigin,
        referrerUrl: next.referrerUrl,
      });
      if (!playbackPageUrl) continue;

      const fetched = await fetchTextDocument({
        url: playbackPageUrl,
        referrerUrl: next.referrerUrl,
        timeoutMs: Math.min(EXTRACTOR_PAGE_FETCH_TIMEOUT_MS, input.timeoutMs),
      });
      if (!fetched.ok || !fetched.body) continue;

      const pageUrl = fetched.finalUrl || playbackPageUrl;
      const sourcePageUrl = fetched.targetUrl || next.pageUrl;
      if (looksLikeManifestResponse(fetched.contentType, fetched.body, sourcePageUrl)) {
        if (hasMediaSegments(fetched.body, sourcePageUrl)) {
          registerUrl({
            rawUrl: sourcePageUrl,
            referrerUrl: next.referrerUrl,
            via: "dom",
            body: fetched.body,
            depth: next.depth,
          });
          continue;
        }
        for (const variantUrl of pickVariantManifestUrls(fetched.body, sourcePageUrl)) {
          registerUrl({
            rawUrl: variantUrl,
            referrerUrl: sourcePageUrl,
            via: "dom",
            depth: next.depth + 1,
          });
        }
        continue;
      }

      if (looksLikeExtractableTextBody(fetched.contentType, fetched.body)) {
        await registerExtractedText({
          text: fetched.body,
          pageUrl,
          sourceUrl: sourcePageUrl,
          referrerUrl: next.referrerUrl,
          depth: next.depth,
        });
      }
    }
  };

  enqueuePageSeed(sourceUrl, sourceUrl, 0);
  for (const livehdVariant of expandLivehdTvServVariants(sourceUrl).slice(0, 4)) {
    enqueuePageSeed(livehdVariant, sourceUrl, 0);
  }

  const drainDomCandidates = async () => {
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
      registerUrl({
        rawUrl,
        referrerUrl: extractProxyReferrer(rawUrl) || sourceUrl,
        via: "dom",
        depth: 1,
      });
    }
  };

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
        sourceUrl;
      registerUrl({
        rawUrl: targetUrl,
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
          sourceUrl;

        if (looksLikeManifestResponse(contentType, body, targetUrl)) {
          if (hasMediaSegments(body, targetUrl)) {
            const ingestUrl = buildBackendProxyUrl({
              sourceUrl: targetUrl,
              requestOrigin,
              referrerUrl,
            });
            pushCandidate(candidates, {
              ingestUrl,
              referrerUrl,
              targetUrl,
              body,
              slotServerId: input.slotServerId,
              via: "network-manifest",
            });
            return;
          }

          for (const variantUrl of pickVariantManifestUrls(body, targetUrl)) {
            const ingestUrl = buildBackendProxyUrl({
              sourceUrl: variantUrl,
              requestOrigin,
              referrerUrl: targetUrl,
            });
            pushCandidate(candidates, {
              ingestUrl,
              referrerUrl: targetUrl,
              targetUrl: variantUrl,
              slotServerId: input.slotServerId,
              via: "network-manifest",
            });
          }
          return;
        }

        if (looksLikeExtractableTextBody(contentType, body) || looksLikeNavigableStreamPage(targetUrl)) {
          await registerExtractedText({
            text: body,
            pageUrl: responseUrl,
            sourceUrl: targetUrl,
            referrerUrl,
            depth: 1,
          });
        }
      } catch {}
    })();
    pendingTasks.add(task);
    void task.finally(() => {
      pendingTasks.delete(task);
    });
  });

  try {
    await page.goto(playbackUrl, {
      waitUntil: "domcontentloaded",
      timeout: Math.max(7_000, Math.min(35_000, input.timeoutMs)),
    });
    if (typeof page.waitForLoadState === "function") {
      await page.waitForLoadState("networkidle", {
        timeout: Math.min(5_000, EXTRACTOR_NETWORK_IDLE_WAIT_MS),
      }).catch(() => {});
    }
    await page.waitForTimeout(Math.max(2_000, Math.min(12_000, EXTRACTOR_WAIT_MS)));
    await drainDomCandidates();
    if (!candidates.size) {
      await page.waitForTimeout(Math.min(6_000, EXTRACTOR_RETRY_WAIT_MS));
      await drainDomCandidates();
    }
    if (pendingTasks.size) {
      await Promise.allSettled(Array.from(pendingTasks));
    }
    if (!candidates.size || pageQueue.length) {
      await crawlQueuedPages();
    }
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error || "browser-extraction-failed");
    await page.close().catch(() => {});
    await context.close().catch(() => {});
    return {
      ok: false,
      playbackUrl,
      error: `browser-extraction-failed:${message}`,
      candidates: [],
    };
  }

  await page.close().catch(() => {});
  await context.close().catch(() => {});

  const ordered = Array.from(candidates.values()).sort((left, right) => right.score - left.score).slice(0, 24);
  if (!ordered.length) {
    return {
      ok: false,
      playbackUrl,
      error: "browser-extraction-empty",
      candidates: [],
    };
  }

  return {
    ok: true,
    playbackUrl,
    error: "",
    candidates: ordered,
  };
}

export async function extractBrowserIngestCandidates(input: {
  sourceUrl: string;
  requestOrigin: string;
  slotServerId?: SlotServerId;
  timeoutMs: number;
}) {
  const sourceUrl = normalizeHttpUrl(input.sourceUrl);
  const requestOrigin = normalizeHttpUrl(input.requestOrigin);
  const cacheKey = `${canonicalizeUrl(sourceUrl)}|${canonicalizeUrl(requestOrigin)}|${String(input.slotServerId || "")}`;
  const now = Date.now();
  const cached = candidateCache.get(cacheKey);
  if (cached && cached.expiresAt > now && cached.result.candidates.length) {
    return {
      ok: true,
      playbackUrl: cached.result.playbackUrl,
      error: "",
      candidates: cached.result.candidates.map((candidate) => ({ ...candidate })),
    } satisfies ExtractorResult;
  }

  const existing = inflight.get(cacheKey);
  if (existing) return existing;

  const pending = runBrowserExtraction({
    sourceUrl,
    requestOrigin,
    slotServerId: input.slotServerId,
    timeoutMs: input.timeoutMs,
  })
    .then((result) => {
      if (result.ok && result.candidates.length) {
        candidateCache.set(cacheKey, {
          expiresAt: Date.now() + EXTRACTOR_CACHE_TTL_MS,
          result: {
            ...result,
            candidates: result.candidates.map((candidate) => ({ ...candidate })),
          },
        });
      }
      return result;
    })
    .catch((error) => ({
      ok: false as const,
      playbackUrl: "",
      error: `browser-extraction-failed:${error instanceof Error ? error.message : String(error || "unknown")}`,
      candidates: [],
    }))
    .finally(() => {
      inflight.delete(cacheKey);
    });

  inflight.set(cacheKey, pending);
  return pending;
}
