import { isValidHttpUrl } from "./server-source-policy";

const DEFAULT_USER_AGENT =
  "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/145.0.0.0 Safari/537.36";

const ENABLE_BROWSER_EXTRACTION =
  String(process.env.REPACK_PLAYERV2_BROWSER_EXTRACTOR || "1").trim() !== "0";
const BROWSER_CACHE_TTL_MS = Math.max(
  5_000,
  Number.parseInt(String(process.env.REPACK_PLAYERV2_BROWSER_CACHE_TTL_MS || "20000"), 10) || 20_000
);
const BROWSER_WAIT_AFTER_GOTO_MS = Math.max(
  1_200,
  Number.parseInt(String(process.env.REPACK_PLAYERV2_BROWSER_WAIT_MS || "3500"), 10) || 3_500
);

type BrowserCandidateResult = {
  ok: boolean;
  candidates: string[];
  error: string;
};

type BrowserCacheEntry = {
  expiresAt: number;
  candidates: string[];
};

const candidateCache = new Map<string, BrowserCacheEntry>();
const inflight = new Map<string, Promise<BrowserCandidateResult>>();
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

function buildInternalEmbedProxyUrl(input: {
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

function looksLikePlayerv2ManifestCandidate(rawUrl: string) {
  if (!isValidHttpUrl(rawUrl)) return false;
  try {
    const u = new URL(rawUrl);
    const host = u.hostname.toLowerCase();
    const pathname = String(u.pathname || "").toLowerCase();
    return (host.endsWith(".yallashot.us") || host === "yallashot.us") && pathname.includes("/kooora/");
  } catch {
    return false;
  }
}

function safeOriginWithSlash(rawUrl: string) {
  if (!isValidHttpUrl(rawUrl)) return "";
  try {
    const u = new URL(rawUrl);
    return `${u.origin}/`;
  } catch {
    return "";
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

async function runBrowserExtraction(input: {
  sourceUrl: string;
  requestOrigin: string;
  timeoutMs: number;
}): Promise<BrowserCandidateResult> {
  const sourceUrl = normalizeHttpUrl(input.sourceUrl);
  const requestOrigin = normalizeHttpUrl(input.requestOrigin);
  if (!ENABLE_BROWSER_EXTRACTION) {
    return { ok: false, candidates: [], error: "browser-extractor-disabled" };
  }
  if (!sourceUrl || !requestOrigin) {
    return { ok: false, candidates: [], error: "invalid-browser-extractor-input" };
  }

  const browser = (await loadBrowser()) as {
    newContext: (input: unknown) => Promise<{
      newPage: () => Promise<{
        on: (event: string, handler: (arg: { method: () => string; url: () => string; headers: () => Record<string, string> }) => void) => void;
        goto: (url: string, options: unknown) => Promise<unknown>;
        waitForTimeout: (ms: number) => Promise<void>;
        close: () => Promise<void>;
      }>;
      close: () => Promise<void>;
    }>;
  };
  const context = await browser.newContext({
    ignoreHTTPSErrors: true,
    locale: "ar-EG",
    userAgent: DEFAULT_USER_AGENT,
    viewport: { width: 1365, height: 850 },
    extraHTTPHeaders: {
      "accept-language": "ar,en-US;q=0.9,en;q=0.8",
    },
  });
  const page = await context.newPage();
  const out = new Set<string>();
  const fallbackReferrer = safeOriginWithSlash(sourceUrl) || sourceUrl;

  page.on("request", (request) => {
    if (request.method() !== "GET") return;
    const requestUrl = normalizeHttpUrl(request.url());
    if (!looksLikePlayerv2ManifestCandidate(requestUrl)) return;
    const requestHeaders = request.headers();
    const referrerUrl = normalizeHttpUrl(String(requestHeaders.referer || "").trim()) || fallbackReferrer;
    const proxied = buildInternalEmbedProxyUrl({
      sourceUrl: requestUrl,
      requestOrigin,
      referrerUrl,
    });
    if (proxied) out.add(proxied);
    out.add(requestUrl);
  });

  try {
    await page.goto(sourceUrl, {
      waitUntil: "domcontentloaded",
      timeout: Math.max(6_000, Math.min(30_000, input.timeoutMs)),
    });
    await page.waitForTimeout(Math.max(1_000, Math.min(8_000, BROWSER_WAIT_AFTER_GOTO_MS)));
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error || "browser-extraction-failed");
    await page.close().catch(() => {});
    await context.close().catch(() => {});
    return { ok: false, candidates: [], error: `browser-extraction-failed:${message}` };
  }

  await page.close().catch(() => {});
  await context.close().catch(() => {});
  const candidates = Array.from(out).filter(Boolean);
  if (!candidates.length) return { ok: false, candidates: [], error: "browser-extraction-empty" };
  return { ok: true, candidates, error: "" };
}

export async function extractPlayerv2BrowserCandidates(input: {
  sourceUrl: string;
  requestOrigin: string;
  timeoutMs: number;
}) {
  const sourceUrl = normalizeHttpUrl(input.sourceUrl);
  const requestOrigin = normalizeHttpUrl(input.requestOrigin);
  const cacheKey = `${canonicalizeUrl(sourceUrl)}|${canonicalizeUrl(requestOrigin)}`;
  const now = Date.now();
  const cached = candidateCache.get(cacheKey);
  if (cached && cached.expiresAt > now && cached.candidates.length) {
    return { ok: true, candidates: [...cached.candidates], error: "" } satisfies BrowserCandidateResult;
  }

  const existing = inflight.get(cacheKey);
  if (existing) return existing;

  const pending = runBrowserExtraction({
    sourceUrl,
    requestOrigin,
    timeoutMs: input.timeoutMs,
  }).then((result) => {
    if (result.ok && result.candidates.length) {
      candidateCache.set(cacheKey, {
        expiresAt: Date.now() + BROWSER_CACHE_TTL_MS,
        candidates: [...result.candidates],
      });
    }
    return result;
  }).finally(() => {
    inflight.delete(cacheKey);
  });

  inflight.set(cacheKey, pending);
  return pending;
}
