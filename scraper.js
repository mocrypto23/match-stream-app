// scraper.js
/**
 * Unified Scraper (Yesterday / Today / Tomorrow) + Deep Stream Link Extractor
 * + SIIIR.TV (Server 2) extractor
 * + LIVEHD77 (Server 3) extractor
 * + LIVEKORA (Server 4) extractor
 * + TSKORA (Server 5) extractor
 * + 1KORA (Server 6) extractor
 *
 * Adds:
 * - stream_url_2..7 support
 *
 * ENV:
 *  - SUPABASE_URL, SUPABASE_KEY (required)
 *  - TABLE_NAME (default: "match-stream-app")
 *  - RPC_NAME (default: "refresh_match_stream_app")
 *  - HEADLESS (default: 1)
 *  - DEBUG (default: 0)
 *  - DIAG (default: 0)
 *  - CONCURRENCY (default: 2)
 *  - SCRAPE_DAY_SCOPE (default: "today_only") -> "today_only" | "all" | comma list ("today,yesterday")
 *  - PRESERVE_FUTURE_ROWS (default: 0 when today_only, else 1)
 *  - CLEANUP_OLD_FINISHED (default: 1)
 */

const { chromium } = require("playwright");
const { createClient } = require("@supabase/supabase-js");
const fs = require("fs");
const path = require("path");
require("dotenv").config({ path: ".env.local" });
const { PlaywrightBlocker } = require("@ghostery/adblocker-playwright");
const fetch = require("cross-fetch");

// ===================== ENV =====================
const supabaseUrl = process.env.SUPABASE_URL;
const supabaseKey = process.env.SUPABASE_KEY;

if (!supabaseUrl || !supabaseKey) {
  console.error("❌ Missing SUPABASE_URL or SUPABASE_KEY in environment.");
  process.exit(1);
}

let blockerPromise = null;

async function getAdBlocker() {
  if (!blockerPromise) {
    blockerPromise = PlaywrightBlocker.fromPrebuiltAdsAndTracking(fetch).then((b) => {
      b.blockImages();
      b.blockFonts();
      return b;
    });
  }
  return blockerPromise;
}

const TABLE_NAME = process.env.TABLE_NAME || "match-stream-app";
const RPC_NAME = process.env.RPC_NAME || "refresh_match_stream_app";
const HEADLESS = (process.env.HEADLESS ?? "1") !== "0";
const DEBUG = (process.env.DEBUG ?? "0") === "1";
const DIAG = (process.env.DIAG ?? "0") === "1";
const CONCURRENCY = Math.max(1, parseInt(process.env.CONCURRENCY || "2", 10) || 2);

function intEnv(name, fallback, min = 1, max = 300000) {
  const raw = process.env[name];
  const parsed = Number.parseInt(String(raw ?? ""), 10);
  if (!Number.isFinite(parsed)) return fallback;
  return Math.min(max, Math.max(min, parsed));
}

const LIST_TIMEOUT_MS = intEnv("LIST_TIMEOUT_MS", 60000, 10000, 180000);
const DEEP_TIMEOUT_MS = intEnv("DEEP_TIMEOUT_MS", 45000, 10000, 180000);
const HTTP_TIMEOUT_MS = intEnv("HTTP_TIMEOUT_MS", 20000, 5000, 120000);
const DEFAULT_HTTP_HEADERS = {
  "user-agent":
    "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/141.0.0.0 Safari/537.36",
  "accept-language": "ar-EG,ar;q=0.9,en-US;q=0.8,en;q=0.7",
  accept: "text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8",
};

const TZ = "Africa/Cairo";

const DAYS = [
  { key: "yesterday", url: "https://www.bein-live.com/matches-yesterday/" },
  { key: "today", url: "https://www.bein-live.com/matches-today_1/" },
  { key: "tomorrow", url: "https://www.bein-live.com/matches-tomorrow/" },
];

const ALL_DAY_KEYS = DAYS.map((d) => d.key);
const SCRAPE_DAY_SCOPE_RAW = String(process.env.SCRAPE_DAY_SCOPE || "today_only").trim().toLowerCase();
const ACTIVE_DAY_KEYS = (() => {
  if (!SCRAPE_DAY_SCOPE_RAW || SCRAPE_DAY_SCOPE_RAW === "today_only" || SCRAPE_DAY_SCOPE_RAW === "today") {
    return ["today"];
  }
  if (SCRAPE_DAY_SCOPE_RAW === "all") {
    return [...ALL_DAY_KEYS];
  }

  const requested = SCRAPE_DAY_SCOPE_RAW
    .split(",")
    .map((x) => x.trim().toLowerCase())
    .filter(Boolean);
  const valid = requested.filter((k) => ALL_DAY_KEYS.includes(k));
  return valid.length ? Array.from(new Set(valid)) : ["today"];
})();
const ACTIVE_DAYS = DAYS.filter((d) => ACTIVE_DAY_KEYS.includes(d.key));
const PRESERVE_FUTURE_ROWS =
  String(process.env.PRESERVE_FUTURE_ROWS ?? (ACTIVE_DAY_KEYS.includes("tomorrow") ? "1" : "0")) !== "0";
const CLEANUP_OLD_FINISHED = String(process.env.CLEANUP_OLD_FINISHED ?? "1") !== "0";

// SIIIR source (Server 2)
const SIIIR = {
  dayUrl: {
    yesterday: "https://w5.siiir.tv/yesterday-matches/",
    today: "https://w5.siiir.tv/today-matches/",
    tomorrow: "https://w5.siiir.tv/tomorrow-matches/",
  },

};
const PRIMARY_FALLBACK_SIIIR_DAY_URL = {
  today: "https://w5.siiir.tv/today-matches/",
};
// LIVEHD77 source (Server 3 - today only)
const LIVEHD = {
  listUrl: "https://livehd77.pro/liive/",
  host: "livehd77.pro",
};
// LIVEKORA source (Server 4) - replaces old yala-live source
const YALA = {
  dayUrl: {
    yesterday: null,
    today: "http://www.livekora.vip/today-matches/",
    tomorrow: null,
  },
  siteHost: "livekora.vip",
};
// TSKORA source (Server 5)
const TSKORA = {
  dayUrl: {
    yesterday: "https://www.tskoralive.com/matches-yesterday",
    today: "https://www.tskoralive.com/matches-today",
    tomorrow: "https://www.tskoralive.com/matches-tomorrow",
  },
  siteHost: "tskoralive.com",
};
// 1KORA source (Server 6)
const ONEKORA = {
  listUrl: "https://1kora.com/",
  siteHost: "1kora.com",
  maxArticles: 24,
};
// LIVEKORA source toggle (Server 4). Enabled by default; set ENABLE_SERVER4_YALA=0 to disable.
const ENABLE_SERVER4_YALA = String(process.env.ENABLE_SERVER4_YALA ?? "1") !== "0";

const SERVER_SLOT_DOMAIN_WHITELIST = Object.freeze({
  1: ["bein-live.com"],
  2: ["siiir.tv", "yallashot.us", "aleynoxitram.sbs"],
  3: ["livehd77.pro", "alkoora.live"],
  4: ["livekora.vip", "koooralive.click", "gomatch-live.com", "kooraxx.com", "sia-bth.net"],
  5: ["tskoralive.com", "pyxq.online"],
  6: ["1kora.com", "ahlamontada.com"],
});

const STREAM_SLOT_FIELD_BY_SLOT = Object.freeze({
  1: "stream_url",
  2: "stream_url_2",
  3: "stream_url_3",
  4: "stream_url_4",
  5: "stream_url_5",
  6: "stream_url_6",
  7: "stream_url_7",
});

const LIVEKORA_SLOT4_HOST_HINTS = SERVER_SLOT_DOMAIN_WHITELIST[4];
// ===================== Anti-Ads Config =====================
const AD_HOSTS = [
  "doubleclick.net",
  "googlesyndication.com",
  "googleadservices.com",
  "googletagservices.com",
  "adservice.google.com",
  "adsystem.com",
  "taboola.com",
  "outbrain.com",
  "mgid.com",
  "propellerads.com",
  "popads.net",
  "onclickalgo.com",
  "pushwelcome.com",
  "pushpushgo.com",
  "hilltopads.net",
  "identitylumber.com",
  "adsco.re",
  "dishtrainer.net",
  "intellipopup.com",
  "blockadsnot.com",
  "adexchangeclear.com",
  "usrpubtrk.com",
  "histats.com",
  "histats.net",
  "trafficstars.com",
  "ero-advertising.com",
  "juicyads.com",
  "exoclick.com",
  "adnxs.com",
  "criteo.com",
  "adform.net",
  "rtbhouse.com",
  "bidvertiser.com",
];

const ADULT_HINTS = [
  "porn",
  "xxx",
  "xnxx",
  "xvideos",
  "redtube",
  "hentai",
  "camgirl",
  "cam4",
  "adult",
];

const BOT_HINTS = [
  "captcha",
  "recaptcha",
  "turnstile",
  "cloudflare",
  "challenge",
  "verify",
  "verification",
  "not-a-robot",
  "not a robot",
  "robot",
];

const NON_STREAM_HOST_HINTS = [
  "facebook.com",
  "twitter.com",
  "x.com",
  "linkedin.com",
  "reddit.com",
  "tumblr.com",
  "telegram.me",
  "api.whatsapp.com",
  "youtube.com",
  "youtu.be",
  "schema.org",
  "gravatar.com",
  "tielabs.com",
];

// ===================== Diagnostics Helpers =====================
function dbg(...args) {
  if (DEBUG) console.log(...args);
}

function ensureDir(p) {
  try {
    fs.mkdirSync(p, { recursive: true });
  } catch { }
}

function diagRoot() {
  return path.join(process.cwd(), "diag");
}

function diagTouch() {
  if (!DIAG) return;
  try {
    const dir = diagRoot();
    ensureDir(dir);
    fs.writeFileSync(
      path.join(dir, "_touch.txt"),
      `ok ${new Date().toISOString()} headless=${HEADLESS} node=${process.version}\n`
    );
  } catch { }
}

function diagWrite(rel, content) {
  if (!DIAG) return;
  try {
    const dir = diagRoot();
    ensureDir(dir);
    const full = path.join(dir, rel);
    ensureDir(path.dirname(full));
    fs.writeFileSync(full, content ?? "");
  } catch { }
}

async function diagShot(page, rel) {
  if (!DIAG) return;
  try {
    const dir = diagRoot();
    ensureDir(dir);
    const full = path.join(dir, rel);
    ensureDir(path.dirname(full));
    await page.screenshot({ path: full, fullPage: true });
  } catch { }
}

diagTouch();

const supabase = createClient(supabaseUrl, supabaseKey);

// ===================== URL Helpers =====================
function isImageUrl(u) {
  if (!u) return false;
  const s = String(u).toLowerCase();
  return /\.(png|jpe?g|gif|webp|svg|avif)(\?|#|$)/i.test(s);
}

function isMediaAssetUrl(u) {
  if (!u) return false;
  const s = String(u).toLowerCase();

  // ملفات ستريم مباشرة/مقاطع HLS/DASH
  if (/\.(m3u8|ts|m4s|mp4|webm|mpd|mkv|avi|mov|flv)(\?|#|$)/i.test(s)) return true;

  // مسارات شائعة للستريم/المقاطع
  if (s.includes("/hls/") || s.includes("/dash/") || s.includes("/live/")) return true;

  // أسماء مقاطع شائعة
  if (s.includes("seg_") || s.includes("segment") || s.includes("chunk") || s.includes("frag")) return true;

  return false;
}

async function resolveFinalUrlViaBrowser(context, startUrl, { timeoutMs = 20000 } = {}) {
  const intermediateHosts = new Set(
    String(process.env.INTERMEDIATE_HOSTS || "linkb.my")
      .split(",")
      .map((x) => x.trim().toLowerCase())
      .filter(Boolean)
  );

  const isIntermediate = (url) => {
    try {
      const host = new URL(url).hostname.toLowerCase();
      return (
        intermediateHosts.has(host) ||
        Array.from(intermediateHosts).some((h) => host === h || host.endsWith("." + h))
      );
    } catch {
      return false;
    }
  };

  const isGoodFinal = (url) => {
    if (!url) return false;
    if (!/^https?:\/\//i.test(url)) return false;
    if (isImageUrl(url)) return false;
    if (isIntermediate(url)) return false;
    return true;
  };

  const page = await context.newPage();
  let finalUrl = null;

  const remember = (u) => {
    if (!u) return;
    if (!finalUrl && isGoodFinal(u)) finalUrl = u;
  };

  const onPopup = async (p) => {
    try {
      await p.waitForLoadState("domcontentloaded", { timeout: 8000 }).catch(() => { });
      remember(p.url());
    } catch { }
    try { await p.close(); } catch { }
  };

  const onCtxPage = async (p) => {
    if (p === page) return;
    try {
      await p.waitForLoadState("domcontentloaded", { timeout: 8000 }).catch(() => { });
      remember(p.url());
    } catch { }
    try { await p.close(); } catch { }
  };

  page.on("popup", onPopup);
  context.on("page", onCtxPage);

  try {
    await page.goto(startUrl, { waitUntil: "domcontentloaded", timeout: timeoutMs });
    remember(page.url());

    const start = Date.now();
    while (!finalUrl && Date.now() - start < timeoutMs) {
      remember(page.url());

      const href = await page.evaluate(() => location.href).catch(() => null);
      if (href) remember(href);

      await page.waitForTimeout(500);
    }

    return finalUrl;
  } finally {
    try { page.off("popup", onPopup); } catch { }
    try { context.off("page", onCtxPage); } catch { }
    try { await page.close(); } catch { }
  }
}

function isJunkCandidateUrl(url) {
  if (!url) return true;
  const u = String(url).toLowerCase();
  return (
    /\.(css|js|png|jpg|jpeg|gif|svg|webp|avif|woff|woff2|ttf|eot|ico|json|map|m3u8|ts|m4s|mp4|mpd|webm)(\?.*)?$/.test(u) ||
    u.includes("cloudflareinsights.com") ||
    u.includes("beacon.min.js") ||
    u.includes("cf-beacon") ||
    u.includes("wp-content/uploads/") ||
    u.includes("/assets/css/") ||
    u.includes("/wp-content/themes/") ||
    u.includes("/wp-includes/")
  );
}

function isAdHost(url) {
  try {
    const host = new URL(url).hostname.toLowerCase();
    return AD_HOSTS.some((h) => host === h || host.endsWith("." + h));
  } catch {
    return false;
  }
}

function isAdultUrl(url) {
  if (!url) return false;
  const s = String(url).toLowerCase();
  return ADULT_HINTS.some((hint) => s.includes(hint));
}

function hasAnyHostHint(url, hints) {
  if (!url) return false;
  const s = String(url).toLowerCase().trim();
  const normHints = (hints || [])
    .map((h) => String(h || "").toLowerCase().trim())
    .filter(Boolean);
  if (!normHints.length) return false;

  // Prefer hostname-aware matching so short hints like "x.com"
  // do not accidentally match unrelated hosts such as "kooraxx.com".
  let parsedAsUrl = false;
  try {
    parsedAsUrl = true;
    const host = new URL(s).hostname.toLowerCase();
    return normHints.some((h) => {
      const domainHint = h.replace(/^https?:\/\//, "").replace(/^www\./, "").replace(/\/+$/, "");
      if (!domainHint) return false;
      return host === domainHint || host.endsWith("." + domainHint);
    });
  } catch { }

  // Fallback for non-URL strings only.
  if (parsedAsUrl) return false;
  return normHints.some((h) => s.includes(h));
}

function isClearlyNonStreamUrl(url) {
  if (!url) return true;
  const s = String(url).toLowerCase();
  return (
    isAdHost(s) ||
    isAdultUrl(s) ||
    isImageUrl(s) ||
    isMediaAssetUrl(s) ||
    isJunkCandidateUrl(s) ||
    hasAnyHostHint(s, NON_STREAM_HOST_HINTS)
  );
}

function canonicalUrlForCompare(rawUrl) {
  const normalized = normalizeUrl(rawUrl, rawUrl);
  if (!normalized) return null;

  try {
    const u = new URL(normalized);
    u.hash = "";
    if ((u.protocol === "http:" && u.port === "80") || (u.protocol === "https:" && u.port === "443")) {
      u.port = "";
    }

    if (u.pathname !== "/") u.pathname = u.pathname.replace(/\/+$/, "");

    const out = u.toString();
    return out.endsWith("/") ? out.slice(0, -1).toLowerCase() : out.toLowerCase();
  } catch {
    return String(normalized).trim().replace(/\/+$/, "").toLowerCase();
  }
}

function dedupeServerUrls({ baseUrl, candidates }) {
  const used = new Set();
  const markUsed = (url) => {
    const key = canonicalUrlForCompare(url);
    if (key) used.add(key);
  };

  markUsed(baseUrl);

  const out = [];
  for (const raw of candidates || []) {
    const normalized = normalizeUrl(raw, raw);
    if (!normalized || isClearlyNonStreamUrl(normalized)) {
      out.push(null);
      continue;
    }

    const key = canonicalUrlForCompare(normalized);
    if (!key || used.has(key)) {
      out.push(null);
      continue;
    }

    used.add(key);
    out.push(normalized);
  }
  return out;
}

async function applyStealth(page) {
  await page.addInitScript(() => {
    try {
      Object.defineProperty(navigator, "webdriver", { get: () => undefined });
      window.chrome = window.chrome || { runtime: {} };
      Object.defineProperty(navigator, "plugins", { get: () => [1, 2, 3, 4, 5] });
      Object.defineProperty(navigator, "languages", {
        get: () => ["ar-EG", "ar", "en-US", "en"],
      });
      Object.defineProperty(navigator, "platform", { get: () => "Win32" });
      Object.defineProperty(navigator, "hardwareConcurrency", { get: () => 8 });

      const originalQuery = window.navigator.permissions?.query;
      if (originalQuery) {
        window.navigator.permissions.query = (parameters) =>
          parameters.name === "notifications"
            ? Promise.resolve({ state: Notification.permission })
            : originalQuery(parameters);
      }
    } catch { }
  });
}

async function applyAntiAds(context, page) {
  if (page.__antiAdsApplied) return;
  page.__antiAdsApplied = true;

  await applyStealth(page);

  page.on("dialog", async (d) => {
    try {
      await d.dismiss();
    } catch { }
  });

  await page.addInitScript((adHosts, adultHints) => {
    try {
      const isBad = (host) => adHosts.some((h) => host === h || host.endsWith("." + h));
      const hasAdultHint = (value) => {
        const s = String(value || "").toLowerCase();
        return adultHints.some((hint) => s.includes(hint));
      };

      const isBlockedUrl = (raw) => {
        try {
          const abs = new URL(String(raw), location.href);
          const host = abs.hostname.toLowerCase();
          const hay = `${host}${abs.pathname}${abs.search}`.toLowerCase();
          return isBad(host) || hasAdultHint(hay);
        } catch {
          return hasAdultHint(raw);
        }
      };

      const origOpen = window.open.bind(window);
      window.open = function (url, name, features) {
        try {
          if (url && isBlockedUrl(url)) return null;
        } catch { }
        return origOpen(url, name, features);
      };

      window.alert = () => { };
      window.confirm = () => false;
      window.prompt = () => null;

      Object.defineProperty(window, "onbeforeunload", {
        get() {
          return null;
        },
        set() { },
      });

      document.addEventListener(
        "click",
        (ev) => {
          try {
            const a = ev?.target?.closest?.("a[href]");
            const href = a?.getAttribute?.("href") || "";
            if (href && isBlockedUrl(href)) {
              ev.preventDefault();
              ev.stopPropagation();
              if (typeof ev.stopImmediatePropagation === "function") ev.stopImmediatePropagation();
            }
          } catch { }
        },
        true
      );
    } catch { }
  }, AD_HOSTS, ADULT_HINTS);

  await page.route("**/*", (route) => {
    try {
      const req = route.request();
      const url = req.url();
      if (isAdHost(url) || isAdultUrl(url)) return route.abort();
      if (typeof route.fallback === "function") return route.fallback();
      return route.continue();
    } catch {
      if (typeof route.fallback === "function") return route.fallback();
      return route.continue();
    }
  });

  try {
    const blocker = await getAdBlocker();
    await blocker.enableBlockingInPage(page);
    dbg("✅ Ghostery adblocker enabled");
  } catch (e) {
    dbg("⚠️ adblocker failed:", e?.message || e);
  }
}

// ===================== Time / Parse Helpers =====================
function normalizeDigits(input) {
  if (input === null || input === undefined) return "";
  const s = String(input);
  const map = {
    "٠": "0",
    "١": "1",
    "٢": "2",
    "٣": "3",
    "٤": "4",
    "٥": "5",
    "٦": "6",
    "٧": "7",
    "٨": "8",
    "٩": "9",
    "۰": "0",
    "۱": "1",
    "۲": "2",
    "۳": "3",
    "۴": "4",
    "۵": "5",
    "۶": "6",
    "۷": "7",
    "۸": "8",
    "۹": "9",
  };
  return s.replace(/[٠-٩۰-۹]/g, (ch) => map[ch] ?? ch);
}

function ymdInTimeZone(date, timeZone) {
  const parts = new Intl.DateTimeFormat("en", {
    timeZone,
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
  }).formatToParts(date);

  const y = parts.find((p) => p.type === "year")?.value;
  const m = parts.find((p) => p.type === "month")?.value;
  const d = parts.find((p) => p.type === "day")?.value;

  if (!y || !m || !d) return null;
  return `${y}-${m}-${d}`;
}

function matchDayFromKey(dayKey) {
  const now = new Date();
  const offset = dayKey === "yesterday" ? -1 : dayKey === "tomorrow" ? 1 : 0;
  const shifted = new Date(now.getTime() + offset * 24 * 60 * 60 * 1000);
  return ymdInTimeZone(shifted, TZ);
}

function toIsoFromDataStart(dataStart) {
  if (!dataStart) return null;
  const s = String(dataStart).trim();
  if (!s) return null;
  return s.includes("T") ? s : s.replace(" ", "T");
}

function cairoDayFromIso(iso) {
  if (!iso) return null;
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return null;
  return ymdInTimeZone(d, TZ);
}

function prettyTimeFromIso(iso) {
  if (!iso) return "—";
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return "—";
  return new Intl.DateTimeFormat("ar-EG", {
    hour: "2-digit",
    minute: "2-digit",
    hour12: true,
    timeZone: TZ,
  }).format(d);
}

function isValidGoalNumber(n) {
  // Practical football score guardrail to avoid parsing kickoff times as scores (e.g. 05:25).
  return Number.isFinite(n) && n >= 0 && n <= 15;
}

function parseScore(raw) {
  if (raw === null || raw === undefined) return null;
  const s = normalizeDigits(String(raw)).trim();
  if (!/^\d{1,2}$/.test(s)) return null;
  const n = parseInt(s, 10);
  if (!isValidGoalNumber(n)) return null;
  return n;
}

function normalizeStoredScore(raw) {
  if (typeof raw !== "number") return null;
  return isValidGoalNumber(raw) ? raw : null;
}

function extractScorePairFromText(raw) {
  const s = normalizeDigits(String(raw || "")).trim();
  if (!s) return null;
  const m = s.match(/(\d{1,2})\s*[-:]\s*(\d{1,2})/);
  if (!m) return null;
  const home = parseScore(m[1]);
  const away = parseScore(m[2]);
  if (home === null || away === null) return null;
  return { home, away };
}

function parseMs(iso) {
  if (!iso) return null;
  const d = new Date(iso);
  const t = d.getTime();
  return Number.isFinite(t) ? t : null;
}

function isLikelyFinishedByTime(matchStartIso, windowMs = 3 * 60 * 60 * 1000) {
  const startMs = parseMs(matchStartIso);
  if (startMs === null) return false;
  return Date.now() > startMs + windowMs;
}

function normalizeStatusKeyValue(raw) {
  const s = String(raw || "").trim().toLowerCase();
  if (s === "live" || s === "finished" || s === "upcoming") return s;
  return "unknown";
}

function pickKnownStatusKey(...values) {
  for (const value of values) {
    const normalized = normalizeStatusKeyValue(value);
    if (normalized !== "unknown") return normalized;
  }
  return "unknown";
}

function statusKeyFromText(statusText) {
  const s0 = String(statusText || "").trim();
  if (!s0) return "unknown";
  const s = s0.toLowerCase();

  if (/لم\s*تبدأ|not started|upcoming|scheduled/i.test(s0)) return "upcoming";
  if (s0.includes("جارية") || s0.includes("مباشر") || s0.includes("الآن") || s0.includes("الان")) return "live";
  if (s0.includes("انتهت") || s0.includes("انتهى") || s0.includes("نهاية")) return "finished";

  if (/\blive\b|in progress|\bnow\b/i.test(s)) return "live";
  if (/\bft\b|full ?time|\bfinished\b|\bended\b|\bfinal\b/i.test(s)) return "finished";

  return "unknown";
}

function normalizeUrl(raw, baseUrl) {
  if (!raw) return null;
  let u = String(raw).trim();
  if (!u || /^(javascript:|data:)/i.test(u)) return null;

  if (u.startsWith("//")) u = "https:" + u;
  if (u.startsWith("/")) {
    try {
      u = new URL(u, baseUrl).toString();
    } catch {
      return null;
    }
  }
  try {
    if (!/^https?:\/\//i.test(u)) u = new URL(u, baseUrl).toString();
  } catch { }
  return /^https?:\/\//i.test(u) ? u : null;
}

function scoreCandidate(u) {
  if (!u) return -99999;
  const s = u.toLowerCase();

  if (isJunkCandidateUrl(s)) return -99999;
  if (isAdultUrl(s)) return -99999;
  if (s === "about:blank") return -9999;
  if (isAdHost(s) || s.includes("googleads") || s.includes("doubleclick")) return -5000;
  if (BOT_HINTS.some((h) => s.includes(h))) return -4000;

  let score = 0;
  if (s.includes("albaplayer")) score += 250;
  if (s.includes("kora-live")) score += 200;
  // ❌ ممنوع m3u8 (بيعمل مشاكل عندك في التخزين)
  // خليه يخسر فورًا بدل ما يكسب
  if (isMediaAssetUrl(s)) return -99999;
  if (s.includes("playerv2.php")) score += 1200;
  if (s.includes("embed")) score += 80;
  if (s.includes("player")) score += 60;
  if (s.includes("iframe")) score += 40;
  if (s.includes("live")) score += 20;

  if (s.includes("bein-live.com") && s.includes("match")) score -= 120;

  if (s.includes("aleynoxitram.sbs") && s.includes("/hard/") && s.includes("match=")) score -= 1200;
  if (s.includes("sir-tv.tv/wp-content/uploads/")) score -= 500;
  if (s.includes("cloudflareinsights.com") || s.includes("beacon.min.js")) score -= 500;

  return score;
}

function pickBestUrl(urls) {
  const uniq = Array.from(new Set(urls.filter(Boolean)));
  uniq.sort((a, b) => scoreCandidate(b) - scoreCandidate(a));
  const best = uniq[0];
  if (best && scoreCandidate(best) > -1000) return best;
  return null;
}

async function waitForStableMatchCount(page, maxWaitMs = 20000, settleMs = 1400) {
  const start = Date.now();
  let last = -1;
  let stableFor = 0;

  while (Date.now() - start < maxWaitMs) {
    const count = await page
      .locator(".AY_Match, .match-container, #ayala-today [id^='m-'][data-start], #ayala-yesterday [id^='m-'][data-start], #ayala-tomorrow [id^='m-'][data-start], [id^='m-'][data-start].AY_WithJS, [id^='m-'][data-start].MT_Loading")
      .count()
      .catch(() => 0);

    if (count > 0 && count === last) stableFor += 400;
    else stableFor = 0;

    last = count;
    if (count > 0 && stableFor >= settleMs) return count;

    await page.waitForTimeout(400);
  }
  return last;
}

function decodeHtmlEntities(value) {
  const s = String(value || "");
  if (!s) return "";
  return s
    .replace(/&#(\d+);/g, (_m, n) => {
      const code = Number.parseInt(String(n), 10);
      return Number.isFinite(code) ? String.fromCharCode(code) : "";
    })
    .replace(/&#x([0-9a-f]+);/gi, (_m, hex) => {
      const code = Number.parseInt(String(hex), 16);
      return Number.isFinite(code) ? String.fromCharCode(code) : "";
    })
    .replace(/&nbsp;/gi, " ")
    .replace(/&amp;/gi, "&")
    .replace(/&quot;/gi, '"')
    .replace(/&#39;|&apos;/gi, "'")
    .replace(/&lt;/gi, "<")
    .replace(/&gt;/gi, ">");
}

function stripHtmlToText(input) {
  const s = String(input || "")
    .replace(/<script[\s\S]*?<\/script>/gi, " ")
    .replace(/<style[\s\S]*?<\/style>/gi, " ")
    .replace(/<[^>]+>/g, " ");
  return normalizeSpaces(decodeHtmlEntities(s));
}

function extractAyMatchRowsFromHtml(html, pageUrl) {
  const text = String(html || "");
  if (!text) return [];

  const cardStartRe =
    /<div\s+([^>]*class=["'][^"']*(?:AY_Match|AY_WithJS|MT_Loading|ay_1a31ddb3|ay_f43fbc9f)[^"']*["'][^>]*)>/gi;
  const starts = [];
  for (const m of text.matchAll(cardStartRe)) {
    if (typeof m.index !== "number") continue;
    starts.push({ index: m.index, attrs: m[1] || "" });
  }
  if (!starts.length) {
    const benacerRows = [];
    const blocks = text.matchAll(/<a[^>]+href=["']([^"']+)["'][^>]*>([\s\S]*?)<\/a>/gi);
    for (const block of blocks) {
      const href = normalizeUrl(block[1] || "", pageUrl);
      const chunk = String(block[2] || "");
      if (!href || !/match-container/i.test(chunk)) continue;

      const teams = Array.from(
        chunk.matchAll(/<div[^>]*class=["'][^"']*team-name[^"']*["'][^>]*>([\s\S]*?)<\/div>/gi)
      )
        .map((m) => stripHtmlToText(m[1] || ""))
        .filter(Boolean);
      if (teams.length < 2) continue;

      const timeTextRaw =
        (chunk.match(/<div[^>]*id=["']match-time["'][^>]*>([\s\S]*?)<\/div>/i) || [])[1] ||
        (chunk.match(/<div[^>]*class=["'][^"']*match-time[^"']*["'][^>]*>([\s\S]*?)<\/div>/i) || [])[1] ||
        "";
      const statusTextRaw =
        (chunk.match(/<div[^>]*class=["'][^"']*match-status-text[^"']*["'][^>]*>([\s\S]*?)<\/div>/i) || [])[1] ||
        (chunk.match(/<div[^>]*class=["'][^"']*match-status[^"']*["'][^>]*>([\s\S]*?)<\/div>/i) || [])[1] ||
        "";
      const channelTextRaw = (() => {
        const li = Array.from(chunk.matchAll(/<li[^>]*>\s*<span[^>]*>([\s\S]*?)<\/span>\s*<\/li>/gi)).map((m) =>
          stripHtmlToText(m[1] || "")
        );
        return li[1] || li[0] || "";
      })();
      const dataStartRaw =
        (chunk.match(/\bdata-start=["']([^"']+)["']/i) || [])[1] ||
        (() => {
          const unix = (chunk.match(/\bdata-start-time=["'](\d{9,13})["']/i) || [])[1] || "";
          if (!unix) return "";
          const asNum = Number.parseInt(unix, 10);
          if (!Number.isFinite(asNum) || asNum <= 0) return "";
          const ms = unix.length > 10 ? asNum : asNum * 1000;
          try {
            return new Date(ms).toISOString();
          } catch {
            return "";
          }
        })();

      const imgCandidates = Array.from(
        chunk.matchAll(/<img[^>]+(?:data-src|data-lazy-src|data-original|src)=["']([^"']+)["'][^>]*>/gi)
      )
        .map((m) => normalizeUrl(m[1] || "", pageUrl))
        .filter(Boolean);

      benacerRows.push({
        home_team: teams[0],
        away_team: teams[1],
        match_url: href,
        data_start: normalizeSpaces(dataStartRaw) || null,
        status_text: stripHtmlToText(statusTextRaw) || null,
        status_key_dom: statusKeyFromText(stripHtmlToText(statusTextRaw || "")) || "unknown",
        time_text: stripHtmlToText(timeTextRaw) || null,
        channel_text: stripHtmlToText(channelTextRaw) || null,
        home_logo: imgCandidates[0] || null,
        away_logo: imgCandidates[1] || null,
        has_score_hint: false,
        home_score_raw: null,
        away_score_raw: null,
      });
    }
    return benacerRows;
  }

  const parseStatusKey = (classRaw, statusTextRaw) => {
    const textStatus = statusKeyFromText(stripHtmlToText(statusTextRaw || ""));
    if (textStatus !== "unknown") return textStatus;

    const cls = String(classRaw || "").toLowerCase();
    if (cls.includes("not-started")) return "upcoming";
    if (cls.includes("live")) return "live";
    if (cls.includes("finished") || cls.includes("ended")) return "finished";
    return "unknown";
  };

  const strictParseGoal = (value) => {
    const s = normalizeDigits(stripHtmlToText(value || ""));
    if (!/^\d{1,2}$/.test(s)) return null;
    const n = Number.parseInt(s, 10);
    if (!Number.isFinite(n) || n < 0 || n > 30) return null;
    return String(n);
  };

  const out = [];

  for (let i = 0; i < starts.length; i++) {
    const start = starts[i];
    const end = starts[i + 1]?.index ?? text.length;
    const chunk = text.slice(start.index, end);
    const attrs = start.attrs || "";

    const teamMatches = Array.from(
      chunk.matchAll(/<div\s+class=["'][^"']*(?:TM_Name|ay_dea3dc0e|ay_30adbd22)[^"']*["'][^>]*>([\s\S]*?)<\/div>/gi)
    );
    const teams = teamMatches.map((m) => stripHtmlToText(m[1])).filter(Boolean);

    const hrefRaw =
      (chunk.match(/<a[^>]+href=["']([^"']*(?:\/matches\/|match=)[^"']*)["']/i) || [])[1] ||
      (chunk.match(/<a[^>]+href=["']([^"']+)["']/i) || [])[1] ||
      "";
    const dataStartRaw =
      (attrs.match(/\bdata-start=["']([^"']+)["']/i) || [])[1] ||
      (chunk.match(/\bdata-start=["']([^"']+)["']/i) || [])[1] ||
      (chunk.match(/\bdata-time=["']([^"']+)["']/i) || [])[1] ||
      "";
    const timeTextRaw =
      (chunk.match(/<span[^>]*class=["'][^"']*(?:MT_Time|ay_0ce77098|ay_e2e911b4)[^"']*["'][^>]*>([\s\S]*?)<\/span>/i) || [])[1] ||
      "";
    const statusTextRaw =
      (chunk.match(/<div[^>]*class=["'][^"']*(?:MT_Stat|MT_Status|status|ay_f9b08507)[^"']*["'][^>]*>([\s\S]*?)<\/div>/i) || [])[1] ||
      "";
    const channelTextRaw =
      (chunk.match(/<li[^>]*>([\s\S]*?)<\/li>/i) || [])[1] ||
      (chunk.match(/<span[^>]*class=["'][^"']*(?:channel|ch)[^"']*["'][^>]*>([\s\S]*?)<\/span>/i) || [])[1] ||
      "";
    const imgCandidates = Array.from(
      chunk.matchAll(/<img[^>]+(?:data-src|data-lazy-src|data-original|src)=["']([^"']+)["'][^>]*>/gi)
    )
      .map((m) => normalizeUrl(m[1] || "", pageUrl))
      .filter(Boolean);
    let goalRaw = Array.from(
      chunk.matchAll(/<span[^>]*class=["'][^"']*RS-goals[^"']*["'][^>]*>([\s\S]*?)<\/span>/gi)
    ).map((m) => m[1] || "");
    if (goalRaw.length < 2) {
      goalRaw = Array.from(
        chunk.matchAll(
          /<span[^>]*class=["'][^"']*(?:score-1|score-2|host_goals|guest_goals|home_score|away_score)[^"']*["'][^>]*>([\s\S]*?)<\/span>/gi
        )
      ).map((m) => m[1] || "");
    }
    const homeScoreRaw = goalRaw.length >= 1 ? strictParseGoal(goalRaw[0]) : null;
    const awayScoreRaw = goalRaw.length >= 2 ? strictParseGoal(goalRaw[1]) : null;
    const statusKey = parseStatusKey(attrs, statusTextRaw);
    const hasScoreHint = homeScoreRaw !== null && awayScoreRaw !== null;
    const hideUpcomingZero =
      statusKey === "upcoming" && homeScoreRaw === "0" && awayScoreRaw === "0";

    const href = normalizeUrl(hrefRaw, pageUrl);
    if (!href || teams.length < 2) continue;

    out.push({
      home_team: teams[0],
      away_team: teams[1],
      match_url: href,
      data_start: normalizeSpaces(dataStartRaw) || null,
      status_text: stripHtmlToText(statusTextRaw) || null,
      status_key_dom: statusKey || "unknown",
      time_text: stripHtmlToText(timeTextRaw) || null,
      channel_text: stripHtmlToText(channelTextRaw) || null,
      home_logo: imgCandidates[0] || null,
      away_logo: imgCandidates[1] || null,
      has_score_hint: hasScoreHint && !hideUpcomingZero,
      home_score_raw: hideUpcomingZero ? null : homeScoreRaw,
      away_score_raw: hideUpcomingZero ? null : awayScoreRaw,
    });
  }

  return out;
}

async function fetchAyMatchRowsFallback(url, dayKey) {
  try {
    const controller = new AbortController();
    const timeoutId = setTimeout(() => controller.abort(), HTTP_TIMEOUT_MS);
    const resp = await fetch(url, {
      method: "GET",
      redirect: "follow",
      signal: controller.signal,
      headers: DEFAULT_HTTP_HEADERS,
    });
    clearTimeout(timeoutId);
    if (!resp.ok) return [];

    const html = await resp.text();
    const rows = extractAyMatchRowsFromHtml(html, resp.url || url);
    const final = rows
      .map((r) => {
        const iso = toIsoFromDataStart(r.data_start);
        const match_day = matchDayFromKey(dayKey) || cairoDayFromIso(iso);
        return { ...r, match_day };
      })
      .filter((r) => r.home_team && r.away_team && r.match_url && r.match_day);

    if (DIAG) diagWrite(`fallback/ay_${dayKey}_${Date.now()}.json`, JSON.stringify(final, null, 2));
    return final;
  } catch {
    return [];
  }
}

function convertAyFallbackRowsToListRows(rows) {
  return (rows || []).map((r) => ({
    home_team: r.home_team,
    away_team: r.away_team,
    data_start: r.data_start || null,
    time_text: r.time_text || null,
    status_text: r.status_text || null,
    status_key_dom: r.status_key_dom || "unknown",
    result_visibility: "unknown",
    has_score_hint: !!r.has_score_hint,
    home_logo: r.home_logo || null,
    away_logo: r.away_logo || null,
    match_url: r.match_url,
    home_score_raw: r.home_score_raw ?? null,
    away_score_raw: r.away_score_raw ?? null,
  }));
}

function dayKeyFromMatchDay(matchDay) {
  const day = String(matchDay || "").trim();
  if (!day) return null;
  if (day === matchDayFromKey("yesterday")) return "yesterday";
  if (day === matchDayFromKey("today")) return "today";
  if (day === matchDayFromKey("tomorrow")) return "tomorrow";
  return null;
}

function toScheduleSeedRow(row, { sourceName = "unknown", dayKeyFallback = null, matchUrlField = "match_url" } = {}) {
  if (!row || typeof row !== "object") return null;

  const homeTeam = normalizeSpaces(row.home_team || "");
  const awayTeam = normalizeSpaces(row.away_team || "");
  if (!homeTeam || !awayTeam) return null;

  const rawMatchUrl = row[matchUrlField] || row.match_url || row.match_page_url || row.article_url || null;
  const matchUrl = rawMatchUrl ? normalizeUrl(rawMatchUrl, rawMatchUrl) || null : null;

  const dataStart = row.data_start || row.match_start || null;
  const iso = toIsoFromDataStart(dataStart);
  const matchDay = row.match_day || matchDayFromKey(dayKeyFallback) || cairoDayFromIso(iso);
  if (!matchDay) return null;

  const statusKeyRaw = String(row.status_key_dom || row.status_key || "unknown").trim().toLowerCase();
  const statusKey = statusKeyRaw || "unknown";

  return {
    home_team: homeTeam,
    away_team: awayTeam,
    data_start: dataStart || null,
    time_text: row.time_text || null,
    status_text: row.status_text || null,
    status_key_dom: statusKey,
    result_visibility: row.result_visibility || "unknown",
    has_score_hint: !!row.has_score_hint || (row.home_score_raw !== null && row.away_score_raw !== null),
    home_logo: row.home_logo || null,
    away_logo: row.away_logo || null,
    match_url: matchUrl,
    home_score_raw: row.home_score_raw ?? null,
    away_score_raw: row.away_score_raw ?? null,
    match_day: matchDay,
    _day_key: dayKeyFallback || dayKeyFromMatchDay(matchDay),
    _seed_source: sourceName,
  };
}

function mergeScheduleSeedRow(baseRow, patchRow) {
  const out = { ...baseRow };
  let changed = false;

  const fill = (field, predicate = (v) => !!v) => {
    if (predicate(out[field])) return;
    if (!predicate(patchRow[field])) return;
    out[field] = patchRow[field];
    changed = true;
  };

  fill("match_url");
  fill("data_start");
  fill("time_text");
  fill("status_text");
  fill("home_logo");
  fill("away_logo");
  fill("_day_key");

  if ((!out.status_key_dom || out.status_key_dom === "unknown") && patchRow.status_key_dom && patchRow.status_key_dom !== "unknown") {
    out.status_key_dom = patchRow.status_key_dom;
    changed = true;
  }
  if (!out.has_score_hint && patchRow.has_score_hint) {
    out.has_score_hint = true;
    changed = true;
  }
  if ((out.home_score_raw === null || out.home_score_raw === undefined) && patchRow.home_score_raw !== null && patchRow.home_score_raw !== undefined) {
    out.home_score_raw = patchRow.home_score_raw;
    changed = true;
  }
  if ((out.away_score_raw === null || out.away_score_raw === undefined) && patchRow.away_score_raw !== null && patchRow.away_score_raw !== undefined) {
    out.away_score_raw = patchRow.away_score_raw;
    changed = true;
  }

  // TEAM_NAME_ALIAS_PATCH_START
  if (ENABLE_TEAM_NAME_ALIAS_PATCH) {
    const preferredHome = maybePromoteTeamLabel(out.home_team, patchRow.home_team);
    if (preferredHome && preferredHome !== out.home_team) {
      out.home_team = preferredHome;
      changed = true;
    }

    const preferredAway = maybePromoteTeamLabel(out.away_team, patchRow.away_team);
    if (preferredAway && preferredAway !== out.away_team) {
      out.away_team = preferredAway;
      changed = true;
    }
  }
  // TEAM_NAME_ALIAS_PATCH_END

  return { row: out, changed };
}

function appendScheduleSeedRows(seedMap, rows, options = {}) {
  const stats = {
    source: options.sourceName || "unknown",
    input: Array.isArray(rows) ? rows.length : 0,
    added: 0,
    enriched: 0,
  };

  if (!Array.isArray(rows) || !rows.length) return stats;

  for (const row of rows) {
    const seed = toScheduleSeedRow(row, options);
    if (!seed) continue;

    const key = keyOfTeams(seed.match_day, seed.home_team, seed.away_team);
    if (!key) continue;

    const existing = seedMap.get(key);
    if (!existing) {
      seedMap.set(key, seed);
      stats.added += 1;
      continue;
    }

    const merged = mergeScheduleSeedRow(existing, seed);
    seedMap.set(key, merged.row);
    if (merged.changed) stats.enriched += 1;
  }

  return stats;
}

function buildScheduleSeedRows({
  primaryRows = [],
  siiirRows = [],
  livehdRows = [],
  livekoraRows = [],
  tskoraRows = [],
  onekoraRows = [],
} = {}) {
  const seedMap = new Map();
  const stats = [];

  stats.push(appendScheduleSeedRows(seedMap, primaryRows, { sourceName: "bein" }));
  stats.push(appendScheduleSeedRows(seedMap, siiirRows, { sourceName: "siiir", matchUrlField: "match_page_url" }));
  stats.push(appendScheduleSeedRows(seedMap, livehdRows, { sourceName: "livehd", dayKeyFallback: "today" }));
  stats.push(appendScheduleSeedRows(seedMap, livekoraRows, { sourceName: "livekora", dayKeyFallback: "today" }));
  stats.push(appendScheduleSeedRows(seedMap, tskoraRows, { sourceName: "tskora" }));
  stats.push(
    appendScheduleSeedRows(seedMap, onekoraRows, {
      sourceName: "onekora",
      dayKeyFallback: "today",
      matchUrlField: "article_url",
    })
  );

  return {
    rows: Array.from(seedMap.values()),
    stats,
  };
}

// ===================== Scrape List (bein-live) =====================
async function scrapeOneDay(page, dayKey, url) {
  console.log(`\n🔎 سحب: ${dayKey} => ${url}`);

  if (DIAG) diagWrite(`list/${dayKey}.url.txt`, url + "\n");

  await page.goto(url, { waitUntil: "domcontentloaded", timeout: LIST_TIMEOUT_MS });
  await page.waitForSelector(
    ".AY_Match, #ayala-today [id^='m-'][data-start], #ayala-yesterday [id^='m-'][data-start], #ayala-tomorrow [id^='m-'][data-start], .no-data__msg, body",
    { timeout: 30000 }
  );

  await page.waitForTimeout(900);
  await waitForStableMatchCount(page, 20000, 1400);

  try {
    await page.mouse.wheel(0, 1400);
    await page.waitForTimeout(700);
  } catch { }

  await diagShot(page, `list/${dayKey}.png`);
  if (DIAG) {
    try {
      const html = await page.content();
      diagWrite(`list/${dayKey}.html`, html.slice(0, 350000));
    } catch { }
  }

  try {
    const bodyText = await page.evaluate(() => (document.body?.innerText || "").slice(0, 4000));
    const lower = (bodyText || "").toLowerCase();
    if (BOT_HINTS.some((h) => lower.includes(h))) {
      console.error("⚠️ BOT/Challenge hints detected on list page (runner may be blocked).");
      if (DIAG) diagWrite(`list/${dayKey}.body.txt`, bodyText);
    }
  } catch { }

  const rows = await page.evaluate((DAY_KEY) => {
    const BASE = "https://www.bein-live.com";

    const toAbs = (u) => {
      if (!u) return "";
      try {
        return new URL(u, BASE).toString();
      } catch {
        return u;
      }
    };

    const pickLogo = (img) => {
      if (!img) return "";
      const ds =
        img.getAttribute("data-src") ||
        img.getAttribute("data-lazy-src") ||
        img.getAttribute("data-original") ||
        "";
      const src = img.getAttribute("src") || "";
      return (ds || "").trim() || (src || "").trim() || "";
    };

    const pickText = (root, selectors) => {
      for (const sel of selectors) {
        const el = root.querySelector(sel);
        const t = (el?.textContent || "").trim();
        if (t) return t;
      }
      return "";
    };

    const statusFromClass = (match) => {
      const cls = (match.className || "").toLowerCase();
      if (cls.includes("not-started")) return "upcoming";
      if (cls.includes("live")) return "live";
      if (cls.includes("finished") || cls.includes("ended")) return "finished";
      return "";
    };

    const statusFromText = (raw) => {
      const t = String(raw || "").toLowerCase().trim();
      if (!t) return "";
      if (t.includes("لم") && (t.includes("تبدأ") || t.includes("تبدا") || t.includes("يبدأ") || t.includes("يبدا"))) return "upcoming";
      if (t.includes("جارية") || t.includes("مباشر") || t.includes("الآن") || t.includes("الان")) return "live";
      if (t.includes("انتهت") || t.includes("انتهى") || t.includes("نهاية")) return "finished";
      if (/not started|upcoming|scheduled/i.test(t)) return "upcoming";
      if (/live|in progress|now/i.test(t)) return "live";
      if (/ft|full ?time|finished|ended|final/i.test(t)) return "finished";
      return "";
    };

    const getResultVisibility = (match) => {
      const res = match.querySelector(".MT_Result");
      if (!res) return "missing";
      const st = (res.getAttribute("style") || "").toLowerCase();
      if (st.includes("display") && st.includes("none")) return "hidden";
      try {
        const cs = window.getComputedStyle(res);
        if (cs && cs.display === "none") return "hidden";
      } catch { }
      return "visible";
    };

    const strictParseGoal = (t) => {
      const s = String(t || "")
        .replace(/[٠-٩]/g, (ch) => "٠١٢٣٤٥٦٧٨٩".indexOf(ch))
        .replace(/[۰-۹]/g, (ch) => "۰۱۲۳۴۵۶۷۸۹".indexOf(ch))
        .trim();
      if (!/^\d{1,2}$/.test(s)) return null;
      const n = parseInt(s, 10);
      if (!Number.isFinite(n) || n < 0 || n > 30) return null;
      return n;
    };

    const findScorePair = (match, statusKey) => {
      if (statusKey === "upcoming") return { home: null, away: null, hasAny: false };

      const visibility = getResultVisibility(match);

      const goals = Array.from(match.querySelectorAll(".RS-goals")).map((g) => (g.textContent || "").trim());
      if (goals.length >= 2) {
        const a = strictParseGoal(goals[0]);
        const b = strictParseGoal(goals[1]);
        if (a !== null && b !== null) {
          if (statusKey === "unknown" && visibility === "hidden" && a === 0 && b === 0) {
            return { home: null, away: null, hasAny: false };
          }
          return { home: String(a), away: String(b), hasAny: true };
        }
      }

      const scoreText = String(
        pickText(match, [".RS-score", ".RS-Score", ".MT_Score", ".MatchScore", ".match-score", ".score"])
      )
        .replace(/[٠-٩]/g, (ch) => "٠١٢٣٤٥٦٧٨٩".indexOf(ch))
        .replace(/[۰-۹]/g, (ch) => "۰۱۲۳۴۵۶۷۸۹".indexOf(ch));
      const m1 = scoreText.match(/(\d{1,2})\s*[-:]\s*(\d{1,2})/);
        if (m1) {
          const a = strictParseGoal(m1[1]);
          const b = strictParseGoal(m1[2]);
          if (a !== null && b !== null) return { home: String(a), away: String(b), hasAny: true };
        }

        const sideA = strictParseGoal(
          pickText(match, [".score-1", ".score1", ".host_goals", ".home_score", "[class*='score-1']"])
        );
        const sideB = strictParseGoal(
          pickText(match, [".score-2", ".score2", ".guest_goals", ".away_score", "[class*='score-2']"])
        );
        if (sideA !== null && sideB !== null) {
          return { home: String(sideA), away: String(sideB), hasAny: true };
        }

        const resultText = String(pickText(match, [".MT_Result", ".ay_abe0d7ce", ".result", ".match-result"]))
          .replace(/[٠-٩]/g, (ch) => "٠١٢٣٤٥٦٧٨٩".indexOf(ch))
          .replace(/[۰-۹]/g, (ch) => "۰۱۲۳۴۵۶۷۸۹".indexOf(ch));
        const m2 = resultText.match(/(\d{1,2})\s*[-:xX]\s*(\d{1,2})/);
        if (m2) {
          const a = strictParseGoal(m2[1]);
          const b = strictParseGoal(m2[2]);
          if (a !== null && b !== null) return { home: String(a), away: String(b), hasAny: true };
        }

        return { home: null, away: null, hasAny: false };
      };

    const cleanText = (value) => String(value || "").replace(/\s+/g, " ").trim();

    const extractTeamName = (teamNode) => {
      if (!teamNode) return "";
      const direct = pickText(teamNode, [
        ".TM_Name",
        "[class*='TM_Name']",
        ".ay_30adbd22",
        ".team-name",
        ".match-team-name",
        "strong",
        "span",
      ]);
      if (direct) return cleanText(direct);

      const candidates = Array.from(teamNode.querySelectorAll("div,span,strong,p"))
        .map((el) => cleanText(el.textContent || ""))
        .filter((t) => t && !/^\d{1,2}$/.test(t) && t !== "-" && !/غير\s*معروف/i.test(t));
      if (!candidates.length) return "";
      candidates.sort((a, b) => b.length - a.length);
      return candidates[0] || "";
    };

    const candidates = Array.from(
      document.querySelectorAll(
        ".AY_Match, #ayala-today [id^='m-'][data-start], #ayala-yesterday [id^='m-'][data-start], #ayala-tomorrow [id^='m-'][data-start], [id^='m-'][data-start].AY_WithJS, [id^='m-'][data-start].MT_Loading"
      )
    );
    const matches = Array.from(new Set(candidates));
    const seen = new Set();

    return matches
      .map((match) => {
        const team1Node = match.querySelector(".TM1, [class*='TM1']");
        const team2Node = match.querySelector(".TM2, [class*='TM2']");
        const fallbackTeams = Array.from(match.querySelectorAll(".TM_Name, [class*='TM_Name'], .ay_30adbd22"))
          .map((e) => cleanText(e.textContent || ""))
          .filter(Boolean);

        const homeTeam = extractTeamName(team1Node) || fallbackTeams[0] || "";
        const awayTeam = extractTeamName(team2Node) || fallbackTeams[1] || "";

        const allImgs = Array.from(match.querySelectorAll("img"));
        const homeImg = team1Node?.querySelector("img") || allImgs[0] || null;
        const awayImg = team2Node?.querySelector("img") || allImgs[1] || null;
        const a = match.querySelector("a[href*='/matches/'], a[href*='match='], a[href]");

        const dataStart = (match.getAttribute("data-start") || "").trim();
        const timeText = pickText(match, [".MT_Time", ".TM_Time", ".match-time", ".MatchTime", ".AY_Time"]);

        const statText = pickText(match, [".MT_Stat", ".MT_Status", ".status"]);
        const classStatus = statusFromClass(match);
        const textStatus = statusFromText(statText);

        let statusKey = textStatus || classStatus || "unknown";

        if (statusKey === "unknown" && DAY_KEY === "yesterday") statusKey = "finished";
        if (statusKey === "unknown" && DAY_KEY === "tomorrow") statusKey = "upcoming";

        const matchUrl = toAbs(a?.getAttribute("href") || "");
        const scorePair = findScorePair(match, statusKey);
        const dedupeKey = `${homeTeam}__${awayTeam}__${dataStart}__${matchUrl}`.toLowerCase();
        if (!homeTeam || !awayTeam || !matchUrl || seen.has(dedupeKey)) return null;
        seen.add(dedupeKey);

        return {
          home_team: homeTeam,
          away_team: awayTeam,
          data_start: dataStart || null,
          time_text: timeText || null,
          status_text: statText || null,
          status_key_dom: statusKey,
          result_visibility: getResultVisibility(match),
          has_score_hint: !!scorePair.hasAny,
          home_logo: toAbs(pickLogo(homeImg)),
          away_logo: toAbs(pickLogo(awayImg)),
          match_url: matchUrl || null,
          home_score_raw: scorePair.home,
          away_score_raw: scorePair.away,
        };
      })
      .filter((m) => m && m.home_team && m.away_team && m.match_url);
  }, dayKey);

  const fallbackRows = await fetchAyMatchRowsFallback(url, dayKey);
  const converted = convertAyFallbackRowsToListRows(fallbackRows);
  if (rows.length && converted.length) {
    const rowKey = (row) => {
      const iso = toIsoFromDataStart(row?.data_start);
      const day = matchDayFromKey(dayKey) || cairoDayFromIso(iso) || "";
      return keyOfTeams(day, row?.home_team, row?.away_team);
    };

    const mergedMap = new Map();
    for (const base of rows) mergedMap.set(rowKey(base), { ...base });

    let added = 0;
    let enriched = 0;
    for (const candidate of converted) {
      const key = rowKey(candidate);
      if (!key) continue;
      const current = mergedMap.get(key);
      if (!current) {
        mergedMap.set(key, { ...candidate });
        added += 1;
        continue;
      }

      let changed = false;
      const merged = { ...current };

      if (!merged.data_start && candidate.data_start) {
        merged.data_start = candidate.data_start;
        changed = true;
      }
      if ((!merged.status_key_dom || merged.status_key_dom === "unknown") && candidate.status_key_dom && candidate.status_key_dom !== "unknown") {
        merged.status_key_dom = candidate.status_key_dom;
        changed = true;
      }
      if (!merged.status_text && candidate.status_text) {
        merged.status_text = candidate.status_text;
        changed = true;
      }
      if (!merged.time_text && candidate.time_text) {
        merged.time_text = candidate.time_text;
        changed = true;
      }
      if ((!merged.home_score_raw || !merged.away_score_raw) && candidate.home_score_raw !== null && candidate.away_score_raw !== null) {
        merged.home_score_raw = candidate.home_score_raw;
        merged.away_score_raw = candidate.away_score_raw;
        merged.has_score_hint = true;
        changed = true;
      }
      if (!merged.home_logo && candidate.home_logo) {
        merged.home_logo = candidate.home_logo;
        changed = true;
      }
      if (!merged.away_logo && candidate.away_logo) {
        merged.away_logo = candidate.away_logo;
        changed = true;
      }
      if (!merged.match_url && candidate.match_url) {
        merged.match_url = candidate.match_url;
        changed = true;
      }

      if (changed) {
        mergedMap.set(key, merged);
        enriched += 1;
      }
    }

    const merged = Array.from(mergedMap.values());
    console.log(`[bein] ${dayKey}: ${rows.length} (browser) + ${added} added + ${enriched} enriched => ${merged.length}`);
    if (DIAG) diagWrite(`rows/raw_${dayKey}.json`, JSON.stringify(merged, null, 2));
    return merged;
  }

  if (rows.length) {
    console.log(`[bein] ${dayKey}: ${rows.length} (browser)`);
    if (DIAG) diagWrite(`rows/raw_${dayKey}.json`, JSON.stringify(rows, null, 2));
    return rows;
  }

  console.log(`📦 ${dayKey}: 0 (browser) -> ${converted.length} (http fallback)`);
  if (DIAG) diagWrite(`rows/raw_${dayKey}.json`, JSON.stringify(converted, null, 2));
  return converted;
}

// ===================== Deep Match Details (bein-live) =====================
async function extractMatchMetaFromDom(page) {
  return page
    .evaluate(() => {
      const pickText = (root, selectors) => {
        for (const sel of selectors) {
          const el = root.querySelector(sel);
          const t = (el?.textContent || "").trim();
          if (t) return t;
        }
        return "";
      };

      const root = document.body || document.documentElement;
      const statText = pickText(root, [".MT_Stat", ".MT_Status", ".match-status", ".MatchStatus", ".RS-status", ".status"]);
      const title = (document.title || "").trim();

      const m = document.querySelector(".AY_Match, [id^='m-'][data-start], .AY_WithJS");
      const cls = (m?.className || "").toLowerCase();
      let classStatus = "";
      if (cls.includes("not-started")) classStatus = "upcoming";
      else if (cls.includes("live")) classStatus = "live";
      else if (cls.includes("finished") || cls.includes("ended")) classStatus = "finished";

      const statusFromText = (raw) => {
        const t = String(raw || "").toLowerCase().trim();
        if (!t) return "";
        if (t.includes("لم") && (t.includes("تبدأ") || t.includes("تبدا") || t.includes("يبدأ") || t.includes("يبدا"))) return "upcoming";
        if (t.includes("جارية") || t.includes("مباشر") || t.includes("الآن") || t.includes("الان")) return "live";
        if (t.includes("انتهت") || t.includes("انتهى") || t.includes("نهاية")) return "finished";
        if (/not started|upcoming|scheduled/i.test(t)) return "upcoming";
        if (/live|in progress|now/i.test(t)) return "live";
        if (/ft|full ?time|finished|ended|final/i.test(t)) return "finished";
        return "";
      };

      let statusKey = statusFromText(statText) || classStatus || "unknown";

      const strictParseGoal = (x) => {
        const s = String(x || "")
          .replace(/[٠-٩]/g, (ch) => "٠١٢٣٤٥٦٧٨٩".indexOf(ch))
          .replace(/[۰-۹]/g, (ch) => "۰۱۲۳۴۵۶۷۸۹".indexOf(ch))
          .trim();
        if (!/^\d{1,2}$/.test(s)) return null;
        const n = parseInt(s, 10);
        if (!Number.isFinite(n) || n < 0 || n > 30) return null;
        return n;
      };

      let home = null;
      let away = null;
      let hasAny = false;

      if (statusKey !== "upcoming") {
        const goals = Array.from(document.querySelectorAll(".RS-goals")).map((g) => (g.textContent || "").trim());
        if (goals.length >= 2) {
          const a = strictParseGoal(goals[0]);
          const b = strictParseGoal(goals[1]);
          if (a !== null && b !== null) {
            home = String(a);
            away = String(b);
            hasAny = true;
          }
        }

        if (!hasAny) {
          const scoreText = String(
            pickText(root, [".RS-score", ".RS-Score", ".MT_Score", ".MatchScore", ".match-score", ".score"])
          )
            .replace(/[٠-٩]/g, (ch) => "٠١٢٣٤٥٦٧٨٩".indexOf(ch))
            .replace(/[۰-۹]/g, (ch) => "۰۱۲۳۴۵۶۷۸۹".indexOf(ch));
          const m1 = scoreText.match(/(\d{1,2})\s*[-:]\s*(\d{1,2})/);
          if (m1) {
            const a = strictParseGoal(m1[1]);
            const b = strictParseGoal(m1[2]);
            if (a !== null && b !== null) {
              home = String(a);
              away = String(b);
              hasAny = true;
            }
          }
        }

        if (!hasAny) {
          const sideA = strictParseGoal(
            pickText(root, [".score-1", ".score1", ".host_goals", ".home_score", "[class*='score-1']"])
          );
          const sideB = strictParseGoal(
            pickText(root, [".score-2", ".score2", ".guest_goals", ".away_score", "[class*='score-2']"])
          );
          if (sideA !== null && sideB !== null) {
            home = String(sideA);
            away = String(sideB);
            hasAny = true;
          }
        }

        if (!hasAny) {
          const resultText = String(pickText(root, [".MT_Result", ".ay_abe0d7ce", ".result", ".match-result"]))
            .replace(/[٠-٩]/g, (ch) => "٠١٢٣٤٥٦٧٨٩".indexOf(ch))
            .replace(/[۰-۹]/g, (ch) => "۰۱۲۳۴۵۶۷۸۹".indexOf(ch));
          const m2 = resultText.match(/(\d{1,2})\s*[-:xX]\s*(\d{1,2})/);
          if (m2) {
            const a = strictParseGoal(m2[1]);
            const b = strictParseGoal(m2[2]);
            if (a !== null && b !== null) {
              home = String(a);
              away = String(b);
              hasAny = true;
            }
          }
        }
      }

      const statusText = statText || title || "";

      return {
        deep_status_text: statusText || null,
        deep_status_key_dom: statusKey || "unknown",
        deep_home_score_raw: home,
        deep_away_score_raw: away,
        deep_has_score_hint: !!hasAny,
      };
    })
    .catch(() => ({
      deep_status_text: null,
      deep_status_key_dom: "unknown",
      deep_home_score_raw: null,
      deep_away_score_raw: null,
      deep_has_score_hint: false,
    }));
}

async function getDeepMatchDetails(page, matchUrl) {
  if (!matchUrl) return { deep_stream_url: null };

  const candidates = new Set();
  const ctx = page.context();

  const onReq = (req) => {
    try {
      const u = req.url();
      if (u) candidates.add(u);
    } catch { }
  };

  const onPopup = async (p) => {
    try {
      await p.waitForLoadState("domcontentloaded", { timeout: 3000 }).catch(() => { });
      const u = p.url();
      if (u) candidates.add(u);
    } catch { }
    try {
      await p.close();
    } catch { }
  };

  const onCtxPage = async (p) => {
    if (p === page) return;
    try {
      await p.waitForLoadState("domcontentloaded", { timeout: 3000 }).catch(() => { });
      const u = p.url();
      if (u) candidates.add(u);
    } catch { }
    try {
      await p.close();
    } catch { }
  };

  page.on("request", onReq);
  page.on("popup", onPopup);
  ctx.on("page", onCtxPage);

  try {
    await page.goto(matchUrl, { waitUntil: "domcontentloaded", timeout: DEEP_TIMEOUT_MS });
    await page.waitForTimeout(1400);

    let meta = await extractMatchMetaFromDom(page);

    try {
      const buttons = page.locator(".video-serv a, .server-tab, .video-serv button");
      if ((await buttons.count()) > 0) {
        const first = buttons.first();
        const href = await first.evaluate((el) => el.getAttribute("href") || "");
        if (href && href.trim()) candidates.add(href.trim());
        else {
          await first.click({ timeout: 3000, noWaitAfter: true });
          await page.waitForTimeout(900);
        }
      }
    } catch { }

    const domUrls = await page
      .evaluate(() => {
        const urls = [];
        document.querySelectorAll(".video-serv a[href]").forEach((a) => urls.push(a.href));
        document.querySelectorAll("iframe").forEach((f) => {
          const s = f.getAttribute("src");
          const ds = f.getAttribute("data-src");
          if (s) urls.push(s);
          if (ds) urls.push(ds);
        });
        document.querySelectorAll("video, source").forEach((v) => {
          const s = v.getAttribute("src");
          if (s) urls.push(s);
        });
        return urls;
      })
      .catch(() => []);

    domUrls.forEach((u) => candidates.add(u));

    try {
      page.frames().forEach((fr) => {
        const u = fr.url();
        if (u) candidates.add(u);
      });
    } catch { }

    await page.waitForTimeout(800);
    const meta2 = await extractMatchMetaFromDom(page);
    meta = {
      deep_status_text: meta2.deep_status_text || meta.deep_status_text,
      deep_status_key_dom: meta2.deep_status_key_dom || meta.deep_status_key_dom,
      deep_home_score_raw: meta2.deep_home_score_raw ?? meta.deep_home_score_raw,
      deep_away_score_raw: meta2.deep_away_score_raw ?? meta.deep_away_score_raw,
      deep_has_score_hint: meta2.deep_has_score_hint || meta.deep_has_score_hint,
    };

    const cleanUrls = Array.from(candidates)
      .map((u) => normalizeUrl(u, matchUrl))
      .filter((u) => u && !isJunkCandidateUrl(u) && !isAdHost(u) && !isAdultUrl(u) && u !== matchUrl)
      // ✅ امنع أي ملفات ستريم/segments نهائيًا (مش صفحة)
      .filter((u) => !isMediaAssetUrl(u));


    const best = pickBestUrl(cleanUrls);

    dbg(`   🎯 Best Link for ${matchUrl}: ${best || "None"}`);

    return {
      deep_stream_url: best || null,
      ...meta,
    };
  } catch (e) {
    dbg(`   ⚠️ Deep error: ${e.message}`);
    return { deep_stream_url: null };
  } finally {
    try {
      page.off("request", onReq);
    } catch { }
    try {
      page.off("popup", onPopup);
    } catch { }
    try {
      ctx.off("page", onCtxPage);
    } catch { }
  }
}

// ===================== SIIIR (Server 2) =====================
function safeTextListFromContainerText(raw) {
  const stop = new Set([
    "انتهت",
    "جارية",
    "مباشر",
    "الآن",
    "اليوم",
    "الأمس",
    "الغد",
    "مباريات",
    "الدوري",
    "كأس",
    "server",
    "hd",
    "بث",
    "البيت",
    "الرسمي",
  ]);

  return String(raw || "")
    .split("\n")
    .map((x) => x.trim())
    .filter(Boolean)
    .filter((x) => x.length >= 2 && x.length <= 40)
    .filter((x) => !/^\d+(\s*[-:]\s*\d+)?$/.test(x))
    .filter((x) => !stop.has(x.toLowerCase()));
}

async function scrapeSiiirDay(page, dayKey) {
  const url = SIIIR.dayUrl[dayKey];
  console.log(`\n🟣 SIIIR list: ${dayKey} => ${url}`);

  if (!url) return [];

  await page.goto(url, { waitUntil: "domcontentloaded", timeout: LIST_TIMEOUT_MS });
  await page.waitForSelector(".AY_Match, .no-data__msg, body", { timeout: 30000 });

  await page.waitForTimeout(900);
  try {
    await waitForStableMatchCount(page, 20000, 1400);
  } catch { }

  await diagShot(page, `siiir/list_${dayKey}.png`);
  if (DIAG) {
    try {
      diagWrite(`siiir/list_${dayKey}.html`, (await page.content()).slice(0, 350000));
    } catch { }
  }

  // نقرأ الكروت من صفحة اليوم
  const rows = await page.evaluate(() => {
    const out = [];
    const matches = Array.from(document.querySelectorAll(".AY_Match"));

    for (const match of matches) {
      const teams = Array.from(match.querySelectorAll(".TM_Name"))
        .map((e) => (e.textContent || "").trim())
        .filter(Boolean);

      if (teams.length < 2) continue;

      const timeEl = match.querySelector(".MT_Time");
      const dataStart = (timeEl?.getAttribute("data-start") || "").trim();

      const a =
        match.querySelector('a[href*="aleynoxitram.sbs/hard/"]') ||
        match.querySelector('a[href*="/hard/"]') ||
        match.querySelector('a[href*="playerv2.php"]') ||
        match.querySelector("a[href]");

      const hrefRaw = a?.getAttribute("href") || "";


      let href = "";
      try {
        href = new URL(hrefRaw, location.href).toString();
      } catch {
        href = "";
      }

      if (!href) continue;

      out.push({
        match_page_url: href,
        home_team: teams[0],
        away_team: teams[1],
        data_start: dataStart || null,
      });
    }

    return out;
  });

  const final = rows
    .map((r) => {
      const iso = toIsoFromDataStart(r.data_start);
      const match_day = cairoDayFromIso(iso) || matchDayFromKey(dayKey);
      return { ...r, match_day, _day_key: dayKey };
    })
    .filter((r) => r.home_team && r.away_team && r.match_page_url && r.match_day);

  if (final.length) {
    console.log(`🟣 SIIIR ${dayKey}: ${final.length} items`);
    if (DIAG) diagWrite(`siiir/raw_${dayKey}.json`, JSON.stringify(final, null, 2));
    return final;
  }

  const fallbackRows = await fetchAyMatchRowsFallback(SIIIR.dayUrl[dayKey], dayKey);
  const converted = fallbackRows
    .map((r) => ({
      match_page_url: r.match_url,
      home_team: r.home_team,
      away_team: r.away_team,
      data_start: r.data_start || null,
      match_day: r.match_day,
      _day_key: dayKey,
    }))
    .filter((r) => r.home_team && r.away_team && r.match_page_url && r.match_day);
  console.log(`🟣 SIIIR ${dayKey}: 0 (browser) -> ${converted.length} (http fallback)`);
  if (DIAG) diagWrite(`siiir/raw_${dayKey}.json`, JSON.stringify(converted, null, 2));
  return converted;
}

function deriveSiiirPlayerV2UrlFromScripts(pageUrl, scriptsText) {
  const normalizedPageUrl = normalizeUrl(pageUrl, pageUrl);
  if (!normalizedPageUrl || !scriptsText) return null;

  try {
    const u = new URL(normalizedPageUrl);
    if (/\/playerv2\.php(\?|$)/i.test(u.pathname)) return normalizedPageUrl;

    let matchId = normalizeDigits(u.searchParams.get("match") || "").trim();
    matchId = matchId.replace(/^match/i, "");
    if (!/^\d{1,5}$/.test(matchId)) return null;

    const hostMatch =
      scriptsText.match(/https:\/\/([^\/\s"'`]+)\/playerv2\.php/i) ||
      scriptsText.match(/playerurl\s*[:=]\s*["'`]?https:\/\/([^\/\s"'`]+)\/playerv2\.php/i) ||
      scriptsText.match(/src\s*[:=]\s*["'`]?https:\/\/([^\/\s"'`]+)\/playerv2\.php/i);
    const host = normalizeSpaces(hostMatch?.[1] || "");
    if (!host) return null;

    const keyMatch =
      scriptsText.match(/\bkey\s*=\s*["'`]?([A-Za-z0-9]+)\b/i) ||
      scriptsText.match(/\bkey\s*:\s*["'`]?([A-Za-z0-9]+)\b/i) ||
      scriptsText.match(/&key=([^&"'`\s]+)\b/i);
    const key = normalizeSpaces(keyMatch?.[1] || "");
    if (!key) return null;

    return `https://${host}/playerv2.php?match=match${encodeURIComponent(matchId)}&key=${encodeURIComponent(key)}`;
  } catch {
    return null;
  }
}

async function resolveSiiirPlayerV2UrlViaHttp(matchPageUrl) {
  const normalized = normalizeUrl(matchPageUrl, matchPageUrl);
  if (!normalized) return null;
  if (/\/playerv2\.php(\?|$)/i.test(normalized)) return normalized;

  try {
    const controller = new AbortController();
    const timeoutId = setTimeout(() => controller.abort(), HTTP_TIMEOUT_MS);
    const resp = await fetch(normalized, {
      method: "GET",
      redirect: "follow",
      signal: controller.signal,
      headers: DEFAULT_HTTP_HEADERS,
    });
    clearTimeout(timeoutId);
    if (!resp.ok) return null;

    const html = await resp.text();
    const finalPageUrl = normalizeUrl(resp.url || normalized, normalized) || normalized;
    let matchId = "";
    try {
      const finalUrlObj = new URL(finalPageUrl);
      matchId = normalizeDigits(finalUrlObj.searchParams.get("match") || "").trim().replace(/^match/i, "");
      if (!/^\d{1,5}$/.test(matchId)) matchId = "";
    } catch { }

    const applyMatchTemplate = (value) => {
      if (!matchId) return String(value || "");
      return String(value || "")
        .replace(/\$\{\s*encodeURIComponent\(\s*matchId\s*\)\s*\}/gi, encodeURIComponent(matchId))
        .replace(/\$\{\s*matchId\s*\}/gi, matchId)
        .replace(/\$\{[^}]*matchId[^}]*\}/gi, matchId);
    };

    const direct =
      html.match(/https:\/\/[^"'`\s]+\/playerv2\.php\?[^"'`\s]+/i)?.[0] ||
      html.match(/playerUrl\s*=\s*`([^`]*playerv2\.php[^`]*)`/i)?.[1] ||
      html.match(/playerUrl\s*=\s*["']([^"'`]*playerv2\.php[^"'`]*)["']/i)?.[1] ||
      null;

    if (direct) {
      const directAbs = normalizeUrl(applyMatchTemplate(direct), finalPageUrl);
      if (directAbs && /\/playerv2\.php(\?|$)/i.test(directAbs)) return directAbs;
    }

    const scriptsText = Array.from(html.matchAll(/<script[^>]*>([\s\S]*?)<\/script>/gi))
      .map((m) => m[1] || "")
      .join("\n");

    return deriveSiiirPlayerV2UrlFromScripts(finalPageUrl, scriptsText);
  } catch {
    return null;
  }
}

async function deriveSiiirPlayerV2Url(page) {
  let pageUrl = "";
  try {
    pageUrl = page.url();
  } catch {
    pageUrl = "";
  }
  if (!pageUrl) return null;

  const scriptsText = await page
    .evaluate(() => Array.from(document.scripts).map((s) => s.textContent || "").join("\n"))
    .catch(() => "");
  return deriveSiiirPlayerV2UrlFromScripts(pageUrl, scriptsText);
}


async function resolveSiiirPlayerIframeSrc(page, matchPageUrl) {
  if (!matchPageUrl) return null;

  // ====== Helpers داخل الدالة ======
  const isPlayerV2 = (u) => typeof u === "string" && /\/playerv2\.php(\?|$)/i.test(u);
  const isHard = (u) => typeof u === "string" && /\/hard\/.+\.html\?match=\d+/i.test(u);

  const candidates = new Set();
  const ctx = page.context();

  const onReq = (req) => {
    try {
      const u = req.url();
      if (u) candidates.add(u);
    } catch { }
  };

  const onPopup = async (p) => {
    try {
      await p.waitForLoadState("domcontentloaded", { timeout: 3000 }).catch(() => { });
      const u = p.url();
      if (u) candidates.add(u);
    } catch { }
    try {
      await p.close();
    } catch { }
  };

  const onCtxPage = async (p) => {
    if (p === page) return;
    try {
      await p.waitForLoadState("domcontentloaded", { timeout: 3000 }).catch(() => { });
      const u = p.url();
      if (u) candidates.add(u);
    } catch { }
    try {
      await p.close();
    } catch { }
  };

  page.on("request", onReq);
  page.on("popup", onPopup);
  ctx.on("page", onCtxPage);

  try {
    const fastHttp = await resolveSiiirPlayerV2UrlViaHttp(matchPageUrl);
    if (isPlayerV2(fastHttp)) {
      dbg("🟣 SIIIR fast-http playerv2:", fastHttp);
      return fastHttp;
    }

    await page.goto(matchPageUrl, { waitUntil: "domcontentloaded", timeout: DEEP_TIMEOUT_MS });

    // ====== Phase 1: محاولات سريعة لاستخراج playerv2 ======
    const maxWaitMs = 8000; // مهم: hard أحيانًا يبني المتغيرات متأخر
    const stepMs = 500;
    const start = Date.now();

    while (Date.now() - start < maxWaitMs) {
      // 1) frames URLs
      try {
        for (const fr of page.frames()) {
          const fu = fr.url();
          if (fu) candidates.add(fu);
          if (isPlayerV2(fu)) {
            dbg("🟣 SIIIR found playerv2 in frame:", fu);
            return fu;
          }
        }
      } catch { }

      // 2) DOM collection (iframes + links + scripts)
      const domUrls = await page
        .evaluate(() => {
          const urls = [];
          const push = (u) => {
            if (u && typeof u === "string") urls.push(u);
          };

          document.querySelectorAll("iframe[src], iframe[data-src]").forEach((f) => {
            push(f.getAttribute("src"));
            push(f.getAttribute("data-src"));
            try { push(f.src); } catch { }
          });

          document.querySelectorAll("a[href]").forEach((a) => {
            push(a.getAttribute("href"));
            try { push(a.href); } catch { }
          });

          const scriptsText = Array.from(document.scripts).map((s) => s.textContent || "").join("\n");
          const m = scriptsText.match(/https:\/\/[^"'`\s]+\/playerv2\.php\?[^"'`\s]+/i);
          if (m && m[0]) push(m[0]);

          return urls;
        })
        .catch(() => []);

      for (const u0 of domUrls) {
        const nu = normalizeUrl(u0, matchPageUrl);
        if (nu) candidates.add(nu);
        if (isPlayerV2(nu)) {
          dbg("🟣 SIIIR found playerv2 in DOM:", nu);
          return nu;
        }
      }

      // 3) derive manual (الأهم)
      const derived = await deriveSiiirPlayerV2Url(page);
      if (derived && isPlayerV2(derived)) {
        candidates.add(derived);
        dbg("🟣 SIIIR derived playerv2:", derived);
        return derived;
      }

      // 4) request candidates might already contain playerv2
      for (const cu of candidates) {
        const nu = normalizeUrl(cu, matchPageUrl);
        if (nu && isPlayerV2(nu)) {
          dbg("🟣 SIIIR found playerv2 in requests:", nu);
          return nu;
        }
      }

      await page.waitForTimeout(stepMs);
    }

    // ====== Phase 2: تنظيف + فرض playerv2 فقط ======
    const clean = Array.from(candidates)
      .map((u) => normalizeUrl(u, matchPageUrl))
      .filter((u) => u && !isAdHost(u) && !isAdultUrl(u) && !isJunkCandidateUrl(u) && u !== matchPageUrl);

    // ✅ ممنوع نرجع hard نهائيًا
    const onlyPlayer = clean.filter((u) => isPlayerV2(u));

    if (DIAG) {
      diagWrite(
        `siiir/resolve_debug_${Date.now()}.json`,
        JSON.stringify(
          {
            matchPageUrl,
            finalUrl: (() => { try { return page.url(); } catch { return ""; } })(),
            cleanCount: clean.length,
            playerCount: onlyPlayer.length,
            sampleClean: clean.slice(0, 120),
            samplePlayer: onlyPlayer.slice(0, 50),
          },
          null,
          2
        )
      );
      await diagShot(page, `siiir/resolve_${Date.now()}.png`);
    }

    if (onlyPlayer.length) {
      // لو في كذا واحد، استخدم scorer (بس كله playerv2)
      const best = pickBestUrl(onlyPlayer);
      dbg("🟣 SIIIR best (playerv2 only):", best || onlyPlayer[0]);
      return best || onlyPlayer[0];
    }

    // ✅ لو لم نجد playerv2 => null (وليس hard)
    dbg("🟣 SIIIR no playerv2 found => null");
    return null;
  } catch (e) {
    dbg("⚠️ SIIIR resolve error:", e?.message || e);
    return null;
  } finally {
    try { page.off("request", onReq); } catch { }
    try { page.off("popup", onPopup); } catch { }
    try { ctx.off("page", onCtxPage); } catch { }
  }
}

async function enrichSiiirWithPlayerUrls(browser, siiirRows) {
  if (!siiirRows.length) return [];

  const limit = Math.min(CONCURRENCY, siiirRows.length);
  const queue = siiirRows.map((r, idx) => ({ r, idx }));
  const out = new Array(siiirRows.length);

  const worker = async (workerId) => {
    const context = await browser.newContext({
      locale: "ar-EG",
      timezoneId: TZ,
      serviceWorkers: "block",
      extraHTTPHeaders: { "Accept-Language": "ar-EG,ar;q=0.9,en-US;q=0.8,en;q=0.7" },
      userAgent:
        "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/121.0.0.0 Safari/537.36",
      viewport: { width: 1280, height: 720 },
    });

    const page = await context.newPage();
    await applyAntiAds(context, page);

    while (queue.length) {
      const item = queue.shift();
      if (!item) break;

      const { r, idx } = item;
      console.log(`🟣 SIIIR [W${workerId}] (${idx + 1}/${siiirRows.length}): ${r.home_team} vs ${r.away_team}`);

      const src = await resolveSiiirPlayerIframeSrc(page, r.match_page_url);
      out[idx] = { ...r, siiir_stream_url: src };
    }

    await context.close();
  };

  await Promise.all(Array.from({ length: limit }, (_, i) => worker(i + 1)));
  return out.map((x) => x || null).filter(Boolean);
}

// ===================== Worker pool (bein-live deep) =====================
async function enrichWithDeepLinks(browser, rows) {
  if (!rows.length) return rows;

  const limit = Math.min(CONCURRENCY, rows.length);
  const queue = rows.map((r, idx) => ({ r, idx }));
  const out = new Array(rows.length);

  const worker = async (workerId) => {
    const context = await browser.newContext({
      locale: "ar-EG",
      timezoneId: TZ,
      serviceWorkers: "block",
      extraHTTPHeaders: { "Accept-Language": "ar-EG,ar;q=0.9,en-US;q=0.8,en;q=0.7" },
      userAgent:
        "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/121.0.0.0 Safari/537.36",
      viewport: { width: 1280, height: 720 },
    });

    const page = await context.newPage();
    await applyAntiAds(context, page);

    while (queue.length) {
      const item = queue.shift();
      if (!item) break;

      const { r, idx } = item;
      console.log(`🔗 Deep [W${workerId}] (${idx + 1}/${rows.length}): ${r.home_team} vs ${r.away_team}`);

      const deep = await getDeepMatchDetails(page, r.match_url);
      out[idx] = { ...r, ...deep };
    }

    await context.close();
  };

  await Promise.all(Array.from({ length: limit }, (_, i) => worker(i + 1)));
  return out.map((x) => x || null).filter(Boolean);
}

// ===================== Merge Guardrails =====================
const ENABLE_TEAM_NAME_ALIAS_PATCH = true;

// TEAM_NAME_ALIAS_PATCH_START
const TEAM_NAME_PHRASE_ALIASES = new Map([
  ["\u0633\u064A\u0631\u0627\u0645\u064A\u0643\u0627\u0643\u0644\u064A\u0648\u0628\u0627\u062A\u0631\u0627", "\u0633\u064A\u0631\u0627\u0645\u064A\u0643\u0627"],
  ["\u0628\u0648\u0631\u0648\u0633\u064A\u0627\u062F\u0648\u0631\u062A\u0645\u0648\u0646\u062F", "\u062F\u0648\u0631\u062A\u0645\u0648\u0646\u062F"],
  ["\u0628\u0631\u0648\u0633\u064A\u0627\u062F\u0648\u0631\u062A\u0645\u0648\u0646\u062F", "\u062F\u0648\u0631\u062A\u0645\u0648\u0646\u062F"],
  ["\u062D\u0633\u064A\u0646\u0627\u0631\u0628\u062F", "\u062D\u0633\u064A\u0646"],
]);

let aliasPatchMerges = 0;

function resetTeamNameAliasPatchMetrics() {
  aliasPatchMerges = 0;
}

function getTeamNameAliasPatchMetrics() {
  return { alias_patch_merges: aliasPatchMerges };
}

function applyTeamNamePhraseAlias(value) {
  const normalized = String(value || "").trim();
  if (!normalized) return "";
  if (!ENABLE_TEAM_NAME_ALIAS_PATCH) return normalized;
  return TEAM_NAME_PHRASE_ALIASES.get(normalized) || normalized;
}

function countLabelTokens(value) {
  const label = normalizeSpaces(value || "");
  if (!label) return 0;
  return label.split(/\s+/).filter(Boolean).length;
}

function chooseRicherTeamLabel(currentLabel, incomingLabel) {
  const current = normalizeSpaces(currentLabel || "");
  const incoming = normalizeSpaces(incomingLabel || "");
  if (!current) return incoming;
  if (!incoming) return current;
  if (current === incoming) return current;

  const currentCanon = canonTeamName(current);
  const incomingCanon = canonTeamName(incoming);
  if (!currentCanon || !incomingCanon || currentCanon !== incomingCanon) return current;

  const currentTokens = countLabelTokens(current);
  const incomingTokens = countLabelTokens(incoming);
  if (incomingTokens > currentTokens) return incoming;
  if (incomingTokens < currentTokens) return current;

  if (incoming.length > current.length) return incoming;
  return current;
}

function maybePromoteTeamLabel(currentLabel, incomingLabel) {
  if (!ENABLE_TEAM_NAME_ALIAS_PATCH) return currentLabel;
  const current = normalizeSpaces(currentLabel || "");
  const chosen = chooseRicherTeamLabel(current, incomingLabel);
  if (chosen && chosen !== current) aliasPatchMerges += 1;
  return chosen || current;
}
// TEAM_NAME_ALIAS_PATCH_END

function canonTeamName(v) {
  let s = normalizeDigits(String(v || "")).trim();
  s = s.replace(/[\u064B-\u0652\u0670\u0640]/g, "");
  s = s
    .replace(/[\u0625\u0623\u0622]/g, "\u0627")
    .replace(/[\u0649\u06CC]/g, "\u064A")
    .replace(/\u06A9/g, "\u0643")
    .replace(/\u0629/g, "\u0647")
    .replace(/\u0624/g, "\u0648")
    .replace(/\u0626/g, "\u064A")
    .toLowerCase();

  const tokenAliases = new Map([
    ["\u062A\u0631\u0627\u0643\u062A\u0648\u0631\u0633\u0627\u0632\u064A", "\u062A\u0631\u0627\u0643\u062A\u0648\u0631"],
    ["\u0627\u0633\u062A\u0642\u0644\u0627\u0644\u0637\u0647\u0631\u0627\u0646", "\u0627\u0633\u062A\u0642\u0644\u0627\u0644"],
    ["\u0627\u0633\u062A\u0642\u0644\u0627\u0644\u062A\u0647\u0631\u0627\u0646", "\u0627\u0633\u062A\u0642\u0644\u0627\u0644"],
    ["\u0627\u0644\u062D\u0633\u064A\u0646\u0627\u0631\u0628\u062F", "\u0627\u0644\u062D\u0633\u064A\u0646"],
    ["\u0628\u064A\u0632\u0627", "\u0628\u064A\u0633\u0627"],
    ["\u0645\u0627\u064A\u0646\u062A\u0633", "\u0645\u0627\u064A\u0646\u0632"],
    ["\u0633\u0627\u0646\u062C\u0631\u0645\u0627\u0646", "\u0633\u0627\u0646\u062C\u064A\u0631\u0645\u0627\u0646"],
    ["\u0645\u0627\u0646", "\u0645\u0627\u0646\u0634\u0633\u062A\u0631"],
    ["man", "manchester"],
    ["\u0628\u064A\u062A\u0631\u0648", "\u0628\u062A\u0631\u0648"],
    ["\u0627\u062A\u0644\u062A\u064A\u0643\u0648", "\u0627\u062A\u0644\u064A\u062A\u0643\u0648"],
    ["\u0627\u062A\u0644\u0627\u0646\u062A\u0627", "\u0627\u062A\u0627\u0644\u0627\u0646\u062A\u0627"],
    ["\u0628\u064A\u062A\u0631\u0648\u0627\u062A\u0644\u062A\u064A\u0643\u0648", "\u0628\u062A\u0631\u0648\u0627\u062A\u0644\u064A\u062A\u0643\u0648"],
    ["\u0628\u064A\u062A\u0631\u0648\u0627\u062A\u0644\u064A\u062A\u0643\u0648", "\u0628\u062A\u0631\u0648\u0627\u062A\u0644\u064A\u062A\u0643\u0648"],
    ["\u0628\u062A\u0631\u0648\u0627\u062A\u0644\u062A\u064A\u0643\u0648", "\u0628\u062A\u0631\u0648\u0627\u062A\u0644\u064A\u062A\u0643\u0648"],
  ]);

  const removablePrefixes = new Set([
    "\u0633\u062A\u0627\u062F",
    "\u0627\u0633\u062A\u0627\u062F",
    "stad",
    "stade",
  ]);

  const removableSuffixes = new Set([
    "\u064A\u0648\u0646\u0627\u064A\u062A\u062F",
    "united",
    "\u0647\u0648\u062A\u0633\u0628\u0631",
    "hotspur",
    "fc",
    "cf",
    "sc",
    "club",
    "\u0646\u0627\u062F\u064A",
  ]);

  const tokens = s
    .split(/[^\p{L}\p{N}]+/gu)
    .map((t) => t.trim())
    .filter(Boolean)
    .map((t) => {
      let out = t;

      // Remove leading Arabic definite article (al-) when token is long enough.
      if (/^\u0627\u0644[\p{L}\p{N}]{3,}$/u.test(out)) out = out.slice(2);

      return tokenAliases.get(out) || out;
    })
    .filter(Boolean);

  if (tokens.length > 1) {
    while (tokens.length > 1 && removablePrefixes.has(tokens[0])) {
      tokens.shift();
    }
  }

  if (tokens.length > 1) {
    while (tokens.length > 1 && removableSuffixes.has(tokens[tokens.length - 1])) {
      tokens.pop();
    }
  }

  const joined = tokens.join("");
  if (!joined) return "";
  const canonical = tokenAliases.get(joined) || joined;
  if (!ENABLE_TEAM_NAME_ALIAS_PATCH) return canonical;
  return applyTeamNamePhraseAlias(canonical);
}

function keyOfTeams(matchDay, home, away) {
  const day = String(matchDay || "").toLowerCase();
  const a = canonTeamName(home);
  const b = canonTeamName(away);
  const pair = [a, b].sort().join("__");
  return `${day}||${pair}`;
}

function teamSoftMatchScore(teamA, teamB) {
  const a = canonTeamName(teamA);
  const b = canonTeamName(teamB);
  if (!a || !b) return 0;
  if (a === b) return 3;

  const minLen = Math.min(a.length, b.length);
  if (minLen >= 4 && (a.includes(b) || b.includes(a))) return 2;

  let commonPrefix = 0;
  const maxPrefix = Math.min(a.length, b.length);
  while (commonPrefix < maxPrefix && a[commonPrefix] === b[commonPrefix]) commonPrefix += 1;
  if (minLen >= 5 && commonPrefix >= Math.max(4, Math.floor(minLen * 0.6))) return 1.5;

  return 0;
}

function isEditDistanceAtMost(a0, b0, maxDist = 1) {
  const a = String(a0 || "");
  const b = String(b0 || "");
  if (!a || !b) return false;
  if (a === b) return true;

  const la0 = a.length;
  const lb0 = b.length;
  if (Math.abs(la0 - lb0) > maxDist) return false;

  // Ensure a is shorter (or equal) to save memory.
  let s = a;
  let t = b;
  let ls = la0;
  let lt = lb0;
  if (ls > lt) {
    s = b;
    t = a;
    ls = lb0;
    lt = la0;
  }

  const prev = new Array(ls + 1);
  for (let i = 0; i <= ls; i += 1) prev[i] = i;

  for (let j = 1; j <= lt; j += 1) {
    const cur = new Array(ls + 1);
    cur[0] = j;
    let rowMin = cur[0];
    const tj = t[j - 1];

    for (let i = 1; i <= ls; i += 1) {
      const cost = s[i - 1] === tj ? 0 : 1;
      const del = prev[i] + 1;
      const ins = cur[i - 1] + 1;
      const sub = prev[i - 1] + cost;
      const v = Math.min(del, ins, sub);
      cur[i] = v;
      if (v < rowMin) rowMin = v;
    }

    if (rowMin > maxDist) return false;
    for (let i = 0; i <= ls; i += 1) prev[i] = cur[i];
  }

  return prev[ls] <= maxDist;
}

function teamSoftEqual(teamA, teamB, { minLen = 6 } = {}) {
  const a = canonTeamName(teamA);
  const b = canonTeamName(teamB);
  if (!a || !b) return false;
  if (a === b) return true;

  const min = Math.min(a.length, b.length);
  if (min < minLen) return false;

  const maxDist = min >= 10 ? 2 : 1;
  return isEditDistanceAtMost(a, b, maxDist);
}

function teamSoftEqualScore(teamA, teamB, { minLen = 6 } = {}) {
  const a = canonTeamName(teamA);
  const b = canonTeamName(teamB);
  if (!a || !b) return 0;
  if (a === b) return 3;

  const min = Math.min(a.length, b.length);
  if (min < minLen) return 0;

  const maxDist = min >= 10 ? 2 : 1;
  return isEditDistanceAtMost(a, b, maxDist) ? 2 : 0;
}

function rowQualityScore(row) {
  if (!row || typeof row !== "object") return 0;
  let score = 0;
  if (row.home_logo) score += 10;
  if (row.away_logo) score += 10;
  if (parseMs(row.match_start) !== null) score += 12;

  if (isBeinMatchPageUrl(row.stream_url)) score += 80;
  if (row.stream_url_2) score += 18;
  if (row.stream_url_3) score += 18;
  if (row.stream_url_4) score += 18;
  if (row.stream_url_5) score += 18;
  if (row.stream_url_6) score += 18;

  if (typeof row.home_score === "number" && typeof row.away_score === "number") score += 6;

  const sk = normalizeStatusKeyValue(row.status_key);
  if (sk === "live") score += 4;
  if (sk === "finished") score += 2;
  return score;
}

function mergeDuplicateMatchRows(primary, secondary, { isolationStats = null, matchKey = null, stage = "soft_dedupe" } = {}) {
  const a = primary || {};
  const b = secondary || {};
  const out = { ...a };

  // TEAM_NAME_ALIAS_PATCH_START
  if (ENABLE_TEAM_NAME_ALIAS_PATCH) {
    const preferredHome = maybePromoteTeamLabel(out.home_team, b.home_team);
    if (preferredHome) out.home_team = preferredHome;

    const preferredAway = maybePromoteTeamLabel(out.away_team, b.away_team);
    if (preferredAway) out.away_team = preferredAway;
  }
  // TEAM_NAME_ALIAS_PATCH_END

  if (!out.home_logo && b.home_logo) out.home_logo = b.home_logo;
  if (!out.away_logo && b.away_logo) out.away_logo = b.away_logo;

  out.stream_url = preferPrimarySourceUrl(out.stream_url, b.stream_url, {
    stats: isolationStats,
    matchKey: matchKey || out.match_key || b.match_key || null,
    stage,
  });
  out.stream_url_2 = preferExistingUrl(2, out.stream_url_2, b.stream_url_2, {
    stats: isolationStats,
    matchKey: matchKey || out.match_key || b.match_key || null,
    stage,
  });
  out.stream_url_3 = preferExistingUrl(3, out.stream_url_3, b.stream_url_3, {
    stats: isolationStats,
    matchKey: matchKey || out.match_key || b.match_key || null,
    stage,
  });
  out.stream_url_4 = preferExistingUrl(4, out.stream_url_4, b.stream_url_4, {
    stats: isolationStats,
    matchKey: matchKey || out.match_key || b.match_key || null,
    stage,
  });
  out.stream_url_5 = preferExistingUrl(5, out.stream_url_5, b.stream_url_5, {
    stats: isolationStats,
    matchKey: matchKey || out.match_key || b.match_key || null,
    stage,
  });
  out.stream_url_6 = preferExistingUrl(6, out.stream_url_6, b.stream_url_6, {
    stats: isolationStats,
    matchKey: matchKey || out.match_key || b.match_key || null,
    stage,
  });
  out.stream_url_7 = null;

  if ((!out.match_start || parseMs(out.match_start) === null) && b.match_start && parseMs(b.match_start) !== null) {
    out.match_start = b.match_start;
  }
  if (!String(out.match_time || "").trim() && String(b.match_time || "").trim()) {
    out.match_time = b.match_time;
  }

  const aHasScore = typeof out.home_score === "number" && typeof out.away_score === "number";
  const bHasScore = typeof b.home_score === "number" && typeof b.away_score === "number";
  if (!aHasScore && bHasScore) {
    out.home_score = normalizeStoredScore(b.home_score);
    out.away_score = normalizeStoredScore(b.away_score);
  }

  const outStatus = normalizeStatusKeyValue(out.status_key);
  const bStatus = normalizeStatusKeyValue(b.status_key);
  if ((outStatus === "unknown" || outStatus === "upcoming") && (bStatus === "live" || bStatus === "finished")) {
    out.status_key = bStatus;
  }
  if (!String(out.status_text || "").trim() && String(b.status_text || "").trim()) {
    out.status_text = b.status_text;
  }

  return out;
}

function softMatchKeyParts(row) {
  const day = String(row?.match_day || "").trim();
  const ms = parseMs(row?.match_start);
  const bucketMs = 10 * 60 * 1000;
  const bucket = ms === null ? null : Math.round(ms / bucketMs);
  const url = normalizeUrl(row?.stream_url, row?.stream_url) || null;
  const home = canonTeamName(row?.home_team || "");
  const away = canonTeamName(row?.away_team || "");
  return { day, ms, bucket, url: url ? url.toLowerCase() : null, home, away };
}

function scoreRowPairSoft(a, b) {
  const directA = teamSoftEqualScore(a?.home_team, b?.home_team) + teamSoftEqualScore(a?.away_team, b?.away_team);
  const swappedA = teamSoftEqualScore(a?.home_team, b?.away_team) + teamSoftEqualScore(a?.away_team, b?.home_team);
  const teamScore = Math.max(directA, swappedA);

  let timeScore = 0;
  const am = parseMs(a?.match_start);
  const bm = parseMs(b?.match_start);
  if (am !== null && bm !== null) {
    const diff = Math.abs(am - bm);
    if (diff <= 5 * 60 * 1000) timeScore = 1.0;
    else if (diff <= 15 * 60 * 1000) timeScore = 0.6;
    else if (diff <= 20 * 60 * 1000) timeScore = 0.3;
  }

  let urlScore = 0;
  const au = normalizeUrl(a?.stream_url, a?.stream_url);
  const bu = normalizeUrl(b?.stream_url, b?.stream_url);
  if (au && bu && au.toLowerCase() === bu.toLowerCase()) urlScore = 1.2;

  return teamScore + timeScore + urlScore;
}

function hasAnyStreamUrlSoft(row) {
  if (!row || typeof row !== "object") return false;
  return !!(
    normalizeUrl(row.stream_url, row.stream_url) ||
    normalizeUrl(row.stream_url_2, row.stream_url_2) ||
    normalizeUrl(row.stream_url_3, row.stream_url_3) ||
    normalizeUrl(row.stream_url_4, row.stream_url_4) ||
    normalizeUrl(row.stream_url_5, row.stream_url_5) ||
    normalizeUrl(row.stream_url_6, row.stream_url_6)
  );
}

function rowsLikelySameMatchSoft(a, b) {
  if (!a || !b) return false;
  if (String(a.match_day || "") !== String(b.match_day || "")) return false;

  const teamDirect = teamSoftEqual(a.home_team, b.home_team) && teamSoftEqual(a.away_team, b.away_team);
  const teamSwapped = teamSoftEqual(a.home_team, b.away_team) && teamSoftEqual(a.away_team, b.home_team);
  if (!teamDirect && !teamSwapped) return false;

  const aUrl = normalizeUrl(a.stream_url, a.stream_url);
  const bUrl = normalizeUrl(b.stream_url, b.stream_url);
  if (aUrl && bUrl && aUrl.toLowerCase() === bUrl.toLowerCase()) return true;

  const am = parseMs(a.match_start);
  const bm = parseMs(b.match_start);
  if (am !== null && bm !== null) {
    return Math.abs(am - bm) <= 20 * 60 * 1000;
  }

  // If one row is missing kickoff time, allow merge only when at least one team is an exact match.
  // This prevents merges like "Manchester City" vs "Manchester United" which share prefixes but are different teams.
  const usedSwapped = teamSwapped && !teamDirect;
  const ah = canonTeamName(a.home_team);
  const aa = canonTeamName(a.away_team);
  const bh = canonTeamName(b.home_team);
  const ba = canonTeamName(b.away_team);
  let exact = 0;
  if (!usedSwapped) {
    if (ah && bh && ah === bh) exact += 1;
    if (aa && ba && aa === ba) exact += 1;
  } else {
    if (ah && ba && ah === ba) exact += 1;
    if (aa && bh && aa === bh) exact += 1;
  }

  // Prefer time-based matching when available.
  const hasAnyTime = am !== null || bm !== null;
  if (!hasAnyTime) return false;

  // Require that both rows actually have stream data; prevents merging empty placeholders.
  if (!hasAnyStreamUrlSoft(a) || !hasAnyStreamUrlSoft(b)) return false;

  return exact >= 1;
}

function softDedupeMatchRows(rows, { isolationStats = null, stage = "soft_dedupe" } = {}) {
  const input = Array.isArray(rows) ? rows.filter(Boolean) : [];
  if (input.length <= 1) return { rows: input, dropped: 0, droppedMatchKeys: [] };

  const out = [];
  let dropped = 0;
  const droppedMatchKeys = [];

  const byDayBucket = new Map();
  const byDayUrl = new Map();
  const byDayTeam = new Map();

  const addIndex = (row, idx) => {
    const meta = softMatchKeyParts(row);
    if (meta.day && meta.bucket !== null) {
      const k = `${meta.day}||${meta.bucket}`;
      const arr = byDayBucket.get(k) || [];
      arr.push(idx);
      byDayBucket.set(k, arr);
    }
    if (meta.day && meta.url) {
      const k = `${meta.day}||url:${meta.url}`;
      if (!byDayUrl.has(k)) byDayUrl.set(k, idx);
    }
    if (meta.day) {
      const homeKey = meta.home && meta.home.length >= 4 ? `${meta.day}||t:${meta.home}` : null;
      const awayKey = meta.away && meta.away.length >= 4 ? `${meta.day}||t:${meta.away}` : null;
      for (const key of [homeKey, awayKey]) {
        if (!key) continue;
        const arr = byDayTeam.get(key) || [];
        arr.push(idx);
        byDayTeam.set(key, arr);
      }
    }
  };

  const candidateIndicesFor = (row) => {
    const meta = softMatchKeyParts(row);
    const candidates = new Set();
    if (meta.day && meta.url) {
      const k = `${meta.day}||url:${meta.url}`;
      const hit = byDayUrl.get(k);
      if (typeof hit === "number") candidates.add(hit);
    }
    if (meta.day && meta.bucket !== null) {
      for (const delta of [-1, 0, 1]) {
        const k = `${meta.day}||${meta.bucket + delta}`;
        const arr = byDayBucket.get(k) || [];
        for (const idx of arr) candidates.add(idx);
      }
    }
    if (meta.day) {
      const homeKey = meta.home && meta.home.length >= 4 ? `${meta.day}||t:${meta.home}` : null;
      const awayKey = meta.away && meta.away.length >= 4 ? `${meta.day}||t:${meta.away}` : null;
      for (const key of [homeKey, awayKey]) {
        if (!key) continue;
        const arr = byDayTeam.get(key) || [];
        for (const idx of arr) candidates.add(idx);
      }
    }
    return Array.from(candidates);
  };

  for (const row of input) {
    let merged = false;
    const candidates = candidateIndicesFor(row);
    let bestIdx = -1;
    let bestScore = -99999;
    for (const idx of candidates) {
      const cur = out[idx];
      if (!cur) continue;
      if (!rowsLikelySameMatchSoft(cur, row)) continue;
      const s = scoreRowPairSoft(cur, row);
      if (s > bestScore) {
        bestScore = s;
        bestIdx = idx;
      }
    }

    if (bestIdx >= 0) {
      const current = out[bestIdx];
      const currentQ = rowQualityScore(current);
      const incomingQ = rowQualityScore(row);

      const preferIncoming =
        incomingQ > currentQ ||
        (incomingQ === currentQ && String(row.match_key || "") < String(current.match_key || ""));

      const winner = preferIncoming ? row : current;
      const loser = preferIncoming ? current : row;

      const winnerKey = String(winner?.match_key || "").trim();
      const loserKey = String(loser?.match_key || "").trim();
      if (loserKey && loserKey !== winnerKey) droppedMatchKeys.push(loserKey);

      const mergedRow = mergeDuplicateMatchRows(winner, loser, {
        isolationStats,
        matchKey: String(winner.match_key || current.match_key || row.match_key || "") || null,
        stage,
      });

      out[bestIdx] = mergedRow;
      addIndex(mergedRow, bestIdx);
      dropped += 1;
      merged = true;
    }

    if (!merged) {
      out.push(row);
      addIndex(row, out.length - 1);
    }
  }

  return { rows: out, dropped, droppedMatchKeys };
}

function findLivehdFallbackUrl(rows, { matchDay, homeTeam, awayTeam }) {
  if (!Array.isArray(rows) || !rows.length || !matchDay || !homeTeam || !awayTeam) return null;

  let best = null;
  let bestScore = 0;
  let secondBestScore = 0;
  let bestMeta = null;

  for (const r of rows) {
    if (!r || !r.livehd_stream_url) continue;
    if (String(r.match_day || "") !== String(matchDay || "")) continue;

    const directHome = teamSoftMatchScore(homeTeam, r.home_team);
    const directAway = teamSoftMatchScore(awayTeam, r.away_team);
    const swappedHome = teamSoftMatchScore(homeTeam, r.away_team);
    const swappedAway = teamSoftMatchScore(awayTeam, r.home_team);
    const direct = directHome + directAway;
    const swapped = swappedHome + swappedAway;
    const score = Math.max(direct, swapped);
    const usedSwapped = swapped > direct;
    const sideA = usedSwapped ? swappedHome : directHome;
    const sideB = usedSwapped ? swappedAway : directAway;
    const sideMin = Math.min(sideA, sideB);
    const sideMax = Math.max(sideA, sideB);

    if (score > bestScore) {
      secondBestScore = bestScore;
      bestScore = score;
      best = r;
      bestMeta = { sideMin, sideMax };
      continue;
    }
    if (score > secondBestScore) {
      secondBestScore = score;
    }
  }

  // 4 = two strong partial matches or better.
  if (best && bestScore >= 4) return best.livehd_stream_url;

  // Allow close matches when both sides are non-trivial and winner is clear.
  if (
    best &&
    bestMeta &&
    bestScore >= 3.5 &&
    bestMeta.sideMin >= 1.5 &&
    bestMeta.sideMax >= 2 &&
    bestScore - secondBestScore >= 0.5
  ) {
    return best.livehd_stream_url;
  }

  return null;
}

function findYalaFallbackUrl(rows, { matchDay, homeTeam, awayTeam }) {
  if (!Array.isArray(rows) || !rows.length || !matchDay || !homeTeam || !awayTeam) return null;

  let best = null;
  let bestScore = 0;

  for (const r of rows) {
    if (!r || !r.yala_stream_url) continue;
    if (String(r.match_day || "") !== String(matchDay || "")) continue;

    const direct =
      teamSoftMatchScore(homeTeam, r.home_team) + teamSoftMatchScore(awayTeam, r.away_team);
    const swapped =
      teamSoftMatchScore(homeTeam, r.away_team) + teamSoftMatchScore(awayTeam, r.home_team);
    const score = Math.max(direct, swapped);

    if (score > bestScore) {
      bestScore = score;
      best = r;
    }
  }

  if (best && bestScore >= 4) return best.yala_stream_url;
  return null;
}

function keyOfRow(r) {
  // Prefer recomputed key so old stored keys with spelling drift don't fork one match into duplicates.
  const recomputed = keyOfTeams(r?.match_day, r?.home_team, r?.away_team);
  if (recomputed) return recomputed;
  if (r && r.match_key) return String(r.match_key);
  return "";
}


function isWeakStreamUrl(u) {
  if (!u) return true;
  const s = String(u).toLowerCase();

  // ✅ ممنوع الصور تتحفظ كـ stream_url (ده سبب png في supabase غالبًا)
  if (isImageUrl(s)) return true;

  // أي لينك بين-لايف ماتش ضعيف
  if (s.includes("bein-live.com") && s.includes("match")) return true;

  // hard wrapper غير موثوق داخل iframe => ضعيف
  if (s.includes("/hard/") && s.includes("aleynoxitram.sbs")) return true;

  // أقوى شيء لServer2 هو playerv2
  if (s.includes("playerv2.php")) return false;

  // ممنوع m3u8 عندك
  if (s.includes("m3u8")) return true;

  const goodHints = ["embed", "player", "iframe", "albaplayer", "kora-live"];
  return !goodHints.some((h) => s.includes(h));
}

function isBeinMatchPageUrl(u) {
  const normalized = normalizeUrl(u, u);
  if (!normalized) return false;
  try {
    const parsed = new URL(normalized);
    const host = parsed.hostname.toLowerCase();
    const path = parsed.pathname.toLowerCase();
    return host.endsWith("bein-live.com") && /\/matches\//i.test(path);
  } catch {
    return false;
  }
}

function isSiiirUrl(u) {
  const normalized = normalizeUrl(u, u);
  if (!normalized) return false;
  try {
    return new URL(normalized).hostname.toLowerCase().endsWith("siiir.tv");
  } catch {
    return false;
  }
}

function slotFieldFromSlot(slot) {
  return STREAM_SLOT_FIELD_BY_SLOT[slot] || `stream_url_${slot}`;
}

function hostMatchesAnyHint(hostname, hints) {
  if (!hostname) return false;
  const host = String(hostname).toLowerCase().trim();
  const normalizedHints = (hints || [])
    .map((h) => String(h || "").toLowerCase().trim())
    .filter(Boolean);
  if (!normalizedHints.length) return false;
  return normalizedHints.some((hint) => host === hint || host.endsWith("." + hint));
}

function createServerIsolationStats() {
  return {
    isolation_reject_server2: 0,
    isolation_reject_server3: 0,
    isolation_reject_server4: 0,
    rejection_samples: [],
  };
}

function noteServerIsolationReject(stats, slot, url, reason, context = {}) {
  if (!stats) return;
  if (slot === 2) stats.isolation_reject_server2 += 1;
  if (slot === 3) stats.isolation_reject_server3 += 1;
  if (slot === 4) stats.isolation_reject_server4 += 1;

  if (Array.isArray(stats.rejection_samples) && stats.rejection_samples.length < 40) {
    stats.rejection_samples.push({
      slot,
      field: slotFieldFromSlot(slot),
      url: String(url || ""),
      reason: reason || "isolation_reject",
      match_key: context.matchKey || null,
      stage: context.stage || null,
    });
  }
}

function validateServerUrlBySlot(slot, url, { stats = null, reason = "", matchKey = null, stage = "" } = {}) {
  const normalized = normalizeUrl(url, url);
  if (!normalized) return null;

  let allowed = false;
  let rejectReason = reason || "slot_mismatch";

  try {
    const parsed = new URL(normalized);
    const host = parsed.hostname.toLowerCase();
    const path = parsed.pathname.toLowerCase();

    switch (slot) {
      case 1: {
        allowed = hostMatchesAnyHint(host, SERVER_SLOT_DOMAIN_WHITELIST[1]) && /\/matches\//i.test(path);
        if (!allowed) rejectReason = reason || "server1_requires_bein_match_page";
        break;
      }
      case 2: {
        const isPlayerv2 = /\/playerv2\.php(\?|$)/i.test(`${parsed.pathname}${parsed.search}`);
        const hostLooksSiiir = hostMatchesAnyHint(host, SERVER_SLOT_DOMAIN_WHITELIST[2]);
        allowed = isPlayerv2 && (hostLooksSiiir || !isClearlyNonStreamUrl(normalized));
        if (!allowed) rejectReason = reason || "server2_requires_playerv2";
        break;
      }
      case 3: {
        allowed =
          looksLikePlayerUrl(normalized) &&
          !isClearlyNonStreamUrl(normalized) &&
          hostMatchesAnyHint(host, SERVER_SLOT_DOMAIN_WHITELIST[3]) &&
          !/livehd77\.pro\/(liive|matches-today|category|author|tag)\//i.test(normalized);
        if (!allowed) rejectReason = reason || "server3_requires_livehd_domain";
        break;
      }
      case 4: {
        allowed =
          looksLikePlayerUrl(normalized) &&
          !isClearlyNonStreamUrl(normalized) &&
          hostMatchesAnyHint(host, SERVER_SLOT_DOMAIN_WHITELIST[4]);
        if (!allowed) rejectReason = reason || "server4_requires_livekora_domain";
        break;
      }
      case 5: {
        const hostAllowed = hostMatchesAnyHint(host, SERVER_SLOT_DOMAIN_WHITELIST[5]);
        const isTskoraPage = hostMatchesAnyHint(host, ["tskoralive.com"]);
        const isPlayerLike = looksLikePlayerUrl(normalized) || /\/watch\//i.test(path);
        allowed = hostAllowed && !isClearlyNonStreamUrl(normalized) && (isTskoraPage || isPlayerLike);
        if (!allowed) rejectReason = reason || "server5_requires_tskora_domain";
        break;
      }
      case 6: {
        allowed = hostMatchesAnyHint(host, SERVER_SLOT_DOMAIN_WHITELIST[6]) && !isClearlyNonStreamUrl(normalized);
        if (!allowed) rejectReason = reason || "server6_requires_1kora_domain";
        break;
      }
      case 7: {
        allowed = false;
        rejectReason = reason || "server7_reserved";
        break;
      }
      default: {
        allowed = false;
        rejectReason = reason || "unknown_slot";
        break;
      }
    }
  } catch {
    allowed = false;
    rejectReason = reason || "invalid_url";
  }

  if (!allowed) {
    noteServerIsolationReject(stats, slot, normalized, rejectReason, { matchKey, stage });
    return null;
  }
  return normalized;
}

function sanitizeRowBySlotContract(row, { stats = null, stage = "sanitize", matchKey = null } = {}) {
  if (!row || typeof row !== "object") return row;
  const out = { ...row };
  out.stream_url = validateServerUrlBySlot(1, out.stream_url, {
    stats,
    reason: "sanitize_server1",
    matchKey: matchKey || out.match_key || null,
    stage,
  });
  out.stream_url_2 = validateServerUrlBySlot(2, out.stream_url_2, {
    stats,
    reason: "sanitize_server2",
    matchKey: matchKey || out.match_key || null,
    stage,
  });
  out.stream_url_3 = validateServerUrlBySlot(3, out.stream_url_3, {
    stats,
    reason: "sanitize_server3",
    matchKey: matchKey || out.match_key || null,
    stage,
  });
  out.stream_url_4 = validateServerUrlBySlot(4, normalizeYalaServer4UrlForPlayback(out.stream_url_4), {
    stats,
    reason: "sanitize_server4",
    matchKey: matchKey || out.match_key || null,
    stage,
  });
  out.stream_url_5 = validateServerUrlBySlot(5, out.stream_url_5, {
    stats,
    reason: "sanitize_server5",
    matchKey: matchKey || out.match_key || null,
    stage,
  });
  out.stream_url_6 = validateServerUrlBySlot(6, out.stream_url_6, {
    stats,
    reason: "sanitize_server6",
    matchKey: matchKey || out.match_key || null,
    stage,
  });
  out.stream_url_7 = null;
  return out;
}

function collectSlotUrlSamples(rows, fieldName, limit = 5) {
  const out = [];
  const cap = Math.max(1, Number(limit) || 1);
  for (const row of rows || []) {
    if (!row || !row[fieldName]) continue;
    const raw = normalizeUrl(row[fieldName], row[fieldName]);
    if (!raw) continue;
    try {
      const u = new URL(raw);
      out.push({
        match_key: row.match_key || null,
        field: fieldName,
        host: u.hostname.toLowerCase(),
        url: raw,
      });
    } catch {
      out.push({
        match_key: row.match_key || null,
        field: fieldName,
        host: null,
        url: raw,
      });
    }
    if (out.length >= cap) break;
  }
  return out;
}

function collectLivekoraLeakSamples(rows, { limit = 6 } = {}) {
  const out = [];
  const fieldsToCheck = ["stream_url", "stream_url_2", "stream_url_3", "stream_url_5", "stream_url_6", "stream_url_7"];
  const cap = Math.max(1, Number(limit) || 1);
  for (const row of rows || []) {
    for (const field of fieldsToCheck) {
      const raw = normalizeUrl(row?.[field], row?.[field]);
      if (!raw) continue;
      try {
        const host = new URL(raw).hostname.toLowerCase();
        if (!hostMatchesAnyHint(host, LIVEKORA_SLOT4_HOST_HINTS)) continue;
      } catch {
        continue;
      }

      out.push({
        match_key: row?.match_key || null,
        field,
        url: raw,
      });
      if (out.length >= cap) return out;
    }
  }
  return out;
}

function hasAnyBackupServerUrl(row) {
  if (!row || typeof row !== "object") return false;
  const server5 = normalizeUrl(row.stream_url_5, row.stream_url_5);
  const server5Strong = server5 && !isWeakGenericServer5Url(server5);
  return !!(
    normalizeUrl(row.stream_url_2, row.stream_url_2) ||
    normalizeUrl(row.stream_url_3, row.stream_url_3) ||
    normalizeUrl(row.stream_url_4, row.stream_url_4) ||
    server5Strong ||
    normalizeUrl(row.stream_url_6, row.stream_url_6)
  );
}

function isWeakGenericServer5Url(value) {
  const normalized = normalizeUrl(value, value);
  if (!normalized) return false;
  try {
    const u = new URL(normalized);
    const host = u.hostname.toLowerCase();
    const path = u.pathname.toLowerCase();
    if (!host.endsWith("pyxq.online")) return false;
    return /^\/albaplayer\/(ontime\d*|bein(?:-?sport)?-?\d+|max\d+|ssc\d+|stars?|beinsports?\d+)\/?$/i.test(path);
  } catch {
    return false;
  }
}

function isPrimaryOnlyRow(row) {
  if (!row || typeof row !== "object") return false;
  const primary = normalizeUrl(row.stream_url, row.stream_url);
  if (!primary) return false;
  return !hasAnyBackupServerUrl(row);
}

function shouldPreserveExistingRow(
  row,
  { allowSiiirFallbackRows = false, dropPrimaryOnlyRows = false, preserveFutureRows = true, todayDay = null } = {}
) {
  if (!row) return false;
  if (dropPrimaryOnlyRows && isPrimaryOnlyRow(row)) return false;
  if (!preserveFutureRows && todayDay && String(row.match_day || "") > String(todayDay)) return false;
  if (isBeinMatchPageUrl(row.stream_url)) return true;
  if (allowSiiirFallbackRows && isSiiirUrl(row.stream_url)) return true;
  return false;
}

function preferExistingUrl(slot, newUrl, oldUrl, options = {}) {
  const normalizedNewUrl = slot === 4 ? normalizeYalaServer4UrlForPlayback(newUrl) : newUrl;
  const normalizedOldUrl = slot === 4 ? normalizeYalaServer4UrlForPlayback(oldUrl) : oldUrl;
  const baseContext = {
    stats: options.stats || null,
    matchKey: options.matchKey || null,
    stage: options.stage || "merge_prefer",
  };
  const newCandidate = validateServerUrlBySlot(slot, normalizedNewUrl, {
    ...baseContext,
    reason: options.reasonNew || `prefer_slot${slot}_new_invalid`,
  });
  const oldCandidate = validateServerUrlBySlot(slot, normalizedOldUrl, {
    ...baseContext,
    reason: options.reasonOld || `prefer_slot${slot}_old_invalid`,
  });

  if (!newCandidate && oldCandidate) return oldCandidate;
  if (newCandidate && !oldCandidate) return newCandidate;
  if (!newCandidate && !oldCandidate) return null;
  if (isWeakStreamUrl(newCandidate) && !isWeakStreamUrl(oldCandidate)) return oldCandidate;
  return newCandidate;
}

function isLegacyServer4YalaUrl(value) {
  const normalized = normalizeUrl(value, value);
  if (!normalized) return false;
  try {
    const host = new URL(normalized).hostname.toLowerCase();
    return host.endsWith("yala-live.tv") || host.endsWith("sia-bth.net") || host.endsWith("kooraxx.com");
  } catch {
    return false;
  }
}

function preferPrimarySourceUrl(newUrl, oldUrl, options = {}) {
  const baseContext = {
    stats: options.stats || null,
    matchKey: options.matchKey || null,
    stage: options.stage || "merge_prefer_primary",
  };
  const newCandidate = validateServerUrlBySlot(1, newUrl, {
    ...baseContext,
    reason: options.reasonNew || "prefer_server1_new_invalid",
  });
  const oldCandidate = validateServerUrlBySlot(1, oldUrl, {
    ...baseContext,
    reason: options.reasonOld || "prefer_server1_old_invalid",
  });
  if (newCandidate && isBeinMatchPageUrl(newCandidate)) return newCandidate;
  return oldCandidate;
}

async function fetchExistingForDays(days) {
  let { data, error } = await supabase
    .from(TABLE_NAME)
    .select(
      "match_key,home_team,away_team,home_logo,away_logo,stream_url,stream_url_2,stream_url_3,stream_url_4,stream_url_5,stream_url_6,stream_url_7,match_day,match_start,match_time,home_score,away_score,status_key,status_text"
    )

    .in("match_day", days);

  if (error && /stream_url_6|stream_url_7/i.test(error.message || "")) {
    const legacy = await supabase
      .from(TABLE_NAME)
      .select(
        "match_key,home_team,away_team,home_logo,away_logo,stream_url,stream_url_2,stream_url_3,stream_url_4,stream_url_5,match_day,match_start,match_time,home_score,away_score,status_key,status_text"
      )
      .in("match_day", days);

    error = legacy.error;
    data = Array.isArray(legacy.data)
      ? legacy.data.map((r) => ({ ...r, stream_url_6: null, stream_url_7: null }))
      : legacy.data;
  }

  if (error) {
    console.error("⚠️ Could not read existing rows for merge:", error.message);
    return [];
  }
  return Array.isArray(data) ? data : [];
}

function mergeWithExisting({
  newRows,
  existingRows,
  allowSiiirFallbackRows = false,
  dropPrimaryOnlyRows = false,
  preserveFutureRows = true,
  todayDay = null,
  isolationStats = null,
}) {
  const nowMs = Date.now();
  const collapsedExistingDroppedMatchKeys = [];

  const existingMap = new Map();
  for (const r of existingRows) {
    const k = keyOfRow(r);
    if (!k) continue;

    const current = existingMap.get(k);
    if (!current) {
      existingMap.set(k, r);
      continue;
    }

    const currentQ = rowQualityScore(current);
    const incomingQ = rowQualityScore(r);
    const preferIncoming =
      incomingQ > currentQ ||
      (incomingQ === currentQ && String(r.match_key || "") < String(current.match_key || ""));
    const winner = preferIncoming ? r : current;
    const loser = preferIncoming ? current : r;

    const winnerKey = String(winner?.match_key || "").trim();
    const loserKey = String(loser?.match_key || "").trim();
    if (loserKey && loserKey !== winnerKey) collapsedExistingDroppedMatchKeys.push(loserKey);

    const mergedExisting = mergeDuplicateMatchRows(winner, loser, {
      isolationStats,
      matchKey: winnerKey || k || null,
      stage: "merge_existing_collapse",
    });
    existingMap.set(k, mergedExisting);
  }

  const mergedMap = new Map();

  // 1. Process New Rows
  for (const r of newRows) {
    const k = keyOfRow(r);
    const old = existingMap.get(k);

    let out = { ...r };

    if (old) {
      if (!out.home_logo && old.home_logo) out.home_logo = old.home_logo;
      if (!out.away_logo && old.away_logo) out.away_logo = old.away_logo;

      // Server 1
      out.stream_url = preferPrimarySourceUrl(out.stream_url, old.stream_url, {
        stats: isolationStats,
        matchKey: k,
        stage: "merge_prefer_primary",
      });

      // Servers 2..7 (preserve if new scrape missing)
      out.stream_url_2 = preferExistingUrl(2, out.stream_url_2, old.stream_url_2, {
        stats: isolationStats,
        matchKey: k,
        stage: "merge_prefer_server2",
      });
      out.stream_url_3 = preferExistingUrl(3, out.stream_url_3, old.stream_url_3, {
        stats: isolationStats,
        matchKey: k,
        stage: "merge_prefer_server3",
      });
      out.stream_url_4 = preferExistingUrl(4, out.stream_url_4, old.stream_url_4, {
        stats: isolationStats,
        matchKey: k,
        stage: "merge_prefer_server4",
      });
      out.stream_url_5 = preferExistingUrl(5, out.stream_url_5, old.stream_url_5, {
        stats: isolationStats,
        matchKey: k,
        stage: "merge_prefer_server5",
      });
      out.stream_url_6 = preferExistingUrl(6, out.stream_url_6, old.stream_url_6, {
        stats: isolationStats,
        matchKey: k,
        stage: "merge_prefer_server6",
      });
      out.stream_url_7 = null;

      const oldMs = parseMs(old.match_start);
      const newMs = parseMs(out.match_start);
      const oldLooksNowish = oldMs !== null && oldMs > nowMs - 6 * 60 * 60 * 1000 && oldMs < nowMs + 15 * 60 * 1000;
      const newIsFarFuture = newMs !== null && newMs > nowMs + 2 * 60 * 60 * 1000;

      if (!(oldLooksNowish && newIsFarFuture)) {
        if ((!out.match_start || !parseMs(out.match_start)) && old.match_start) {
          out.match_start = old.match_start;
          out.match_time = old.match_time || out.match_time;
        }
      }

      const newHS = normalizeStoredScore(out.home_score);
      const newAS = normalizeStoredScore(out.away_score);
      const oldHS = normalizeStoredScore(old.home_score);
      const oldAS = normalizeStoredScore(old.away_score);

      const oldHasScore = oldHS !== null && oldAS !== null;
      const newHasScore = newHS !== null && newAS !== null;

      if (newHasScore) {
        out.home_score = newHS;
        out.away_score = newAS;
      } else {
        out.home_score = null;
        out.away_score = null;
      }

      if (!newHasScore && oldHasScore) {
        out.home_score = oldHS;
        out.away_score = oldAS;
      }

      const newStatusKey = String(out.status_key || "").trim().toLowerCase();
      const oldStatusKey = String(old.status_key || "").trim().toLowerCase();
      if ((!newStatusKey || newStatusKey === "unknown") && oldStatusKey && oldStatusKey !== "unknown") {
        out.status_key = oldStatusKey;
      }
      if (!String(out.status_text || "").trim() && String(old.status_text || "").trim()) {
        out.status_text = old.status_text;
      }
    }

    const finalStatus = normalizeStatusKeyValue(out.status_key);
    if ((finalStatus === "unknown" || finalStatus === "upcoming") && isLikelyFinishedByTime(out.match_start)) {
      out.status_key = "finished";
    }
    if (
      normalizeStatusKeyValue(out.status_key) === "finished" &&
      (typeof out.home_score !== "number" || typeof out.away_score !== "number")
    ) {
      const scoreFromText = extractScorePairFromText(out.status_text);
      if (scoreFromText) {
        out.home_score = scoreFromText.home;
        out.away_score = scoreFromText.away;
      }
    }

    // Strict isolation: no cross-server dedup in merge
    // Drop weak leftovers for newer optional servers.
    if (isWeakStreamUrl(out.stream_url_4)) out.stream_url_4 = null;
    if (isLegacyServer4YalaUrl(out.stream_url_4)) out.stream_url_4 = null;
    if (isWeakStreamUrl(out.stream_url_5)) out.stream_url_5 = null;
    if (isWeakStreamUrl(out.stream_url_6)) out.stream_url_6 = null;
    if (isWeakStreamUrl(out.stream_url_7)) out.stream_url_7 = null;

    const sanitizedOut = sanitizeRowBySlotContract(out, {
      stats: isolationStats,
      stage: "merge_row_finalize",
      matchKey: k,
    });
    if (dropPrimaryOnlyRows && isPrimaryOnlyRow(sanitizedOut)) {
      console.log(`[merge] dropping primary-only row while server1 degraded: ${sanitizedOut.home_team} vs ${sanitizedOut.away_team}`);
      continue;
    }
    mergedMap.set(k, sanitizedOut);
  }

  // 2. Preserve Existing Rows (Fix for disappearing matches)
  for (const r of existingRows) {
    const k = keyOfRow(r);
    if (mergedMap.has(k)) continue;
    const preserved = { ...r };
    if (
      !shouldPreserveExistingRow(preserved, {
        allowSiiirFallbackRows,
        dropPrimaryOnlyRows,
        preserveFutureRows,
        todayDay,
      })
    ) {
      console.log(`[merge] dropping stale external row: ${preserved.home_team} vs ${preserved.away_team}`);
      continue;
    }
    preserved.home_score = normalizeStoredScore(preserved.home_score);
    preserved.away_score = normalizeStoredScore(preserved.away_score);
    if (preserved.home_score === null || preserved.away_score === null) {
      preserved.home_score = null;
      preserved.away_score = null;
    }
    const preservedStatus = normalizeStatusKeyValue(preserved.status_key);
    if ((preservedStatus === "unknown" || preservedStatus === "upcoming") && isLikelyFinishedByTime(preserved.match_start)) {
      preserved.status_key = "finished";
    }
    if (
      normalizeStatusKeyValue(preserved.status_key) === "finished" &&
      (typeof preserved.home_score !== "number" || typeof preserved.away_score !== "number")
    ) {
      const scoreFromText = extractScorePairFromText(preserved.status_text);
      if (scoreFromText) {
        preserved.home_score = scoreFromText.home;
        preserved.away_score = scoreFromText.away;
      }
    }
    if (isLegacyServer4YalaUrl(preserved.stream_url_4)) preserved.stream_url_4 = null;
    console.log(`[merge] preserving missed match from DB: ${preserved.home_team} vs ${preserved.away_team}`);
    const sanitizedPreserved = sanitizeRowBySlotContract(preserved, {
      stats: isolationStats,
      stage: "merge_preserved_row_finalize",
      matchKey: k,
    });
    if (dropPrimaryOnlyRows && isPrimaryOnlyRow(sanitizedPreserved)) {
      console.log(`[merge] dropping primary-only preserved row while server1 degraded: ${sanitizedPreserved.home_team} vs ${sanitizedPreserved.away_team}`);
      continue;
    }
    mergedMap.set(k, sanitizedPreserved);
  }

  return {
    mergedRows: Array.from(mergedMap.values()),
    droppedMatchKeys: collapsedExistingDroppedMatchKeys,
  };
}

async function backfillDynamicMatchFields(rows) {
  const valid = Array.isArray(rows) ? rows.filter((r) => r && r.match_key) : [];
  if (!valid.length) return { ok: 0, fail: 0 };

  let ok = 0;
  let fail = 0;
  const chunkSize = 20;

  for (let i = 0; i < valid.length; i += chunkSize) {
    const chunk = valid.slice(i, i + chunkSize);
    await Promise.all(
      chunk.map(async (row) => {
        const payload = {
          match_start: row.match_start || null,
          match_time: row.match_time || null,
          home_score: typeof row.home_score === "number" ? row.home_score : null,
          away_score: typeof row.away_score === "number" ? row.away_score : null,
          status_key: row.status_key || null,
          status_text: row.status_text || null,
        };

        const { error } = await supabase.from(TABLE_NAME).update(payload).eq("match_key", row.match_key);
        if (error) {
          fail += 1;
          if (DIAG) diagWrite(`post_rpc/errors_${Date.now()}.txt`, `${row.match_key}: ${error.message}\n`);
          return;
        }
        ok += 1;
      })
    );
  }

  return { ok, fail };
}

async function cleanupOldFinishedRows({ olderThanDay }) {
  if (!CLEANUP_OLD_FINISHED) return { skipped: true, deleted: 0, error: null };
  const cutoff = String(olderThanDay || "").trim();
  if (!cutoff) return { skipped: true, deleted: 0, error: null };

  const { count, error } = await supabase
    .from(TABLE_NAME)
    .delete({ count: "exact" })
    .lt("match_day", cutoff)
    .eq("status_key", "finished");

  if (error) {
    console.error("⚠️ cleanup old finished rows failed:", error.message);
    return { skipped: false, deleted: 0, error };
  }
  return { skipped: false, deleted: Number(count) || 0, error: null };
}
// ===================== LIVEHD77 (Server 3) =====================
function scoreLivehdCandidate(u) {
  if (!u) return -99999;
  const s = String(u).toLowerCase();

  if (!/^https?:\/\//i.test(s)) return -99999;
  if (isImageUrl(s) || isMediaAssetUrl(s) || isAdHost(s) || isAdultUrl(s)) return -99999;
  if (isJunkCandidateUrl(s)) return -99999;

  let score = scoreCandidate(s);

  if (s.includes("livehd77.pro/tv/")) score += 1400;
  if (s.includes("alkoora.live/albaplayer")) score += 1300;
  if (s.includes("albaplayer")) score += 700;
  if (s.includes("/tv/")) score += 600;
  if (s.includes("player") || s.includes("embed") || s.includes("iframe")) score += 200;

  if (s.includes("livehd77.pro/liive/")) score -= 2200;
  if (s.includes("livehd77.pro/matches-today/")) score -= 2200;
  if (s.includes("/category/") || s.includes("/author/") || s.includes("/tag/")) score -= 2500;
  if (s.includes("/privacy-policy/") || s.includes("/about-us/") || s.includes("/contact/")) score -= 2500;
  if (s.includes("/wp-content/") || s.includes("/wp-includes/")) score -= 2600;

  return score;
}

function normalizeLivehdServer3Url(rawUrl) {
  const base = normalizeUrl(rawUrl, rawUrl);
  if (!base) return null;
  try {
    const u = new URL(base);
    const host = u.hostname.toLowerCase();
    const path = u.pathname.toLowerCase();
    const isAlbaplayer = path.includes("/albaplayer/") || path.includes("/alba.php");
    const isLivehdChain = host.includes("alkoora.live") || host.includes("livehd77.pro");
    if (isAlbaplayer && isLivehdChain) {
      u.searchParams.set("serv", "2");
    }
    return u.toString();
  } catch {
    return base;
  }
}

function pickBestLivehdUrl(urls, { baseUrl = null } = {}) {
  const base = baseUrl ? normalizeUrl(baseUrl, baseUrl) : null;

  const uniq = Array.from(new Set((urls || []).filter(Boolean)))
    .map((u) => normalizeUrl(u, baseUrl || u))
    .filter(Boolean)
    .filter((u) => !base || u !== base);

  if (!uniq.length) return null;

  uniq.sort((a, b) => scoreLivehdCandidate(b) - scoreLivehdCandidate(a));
  const best = uniq[0];
  if (!best) return null;

  return scoreLivehdCandidate(best) > -900 ? best : null;
}

async function collectLivehdCandidateUrlsFromPage(page, baseUrl) {
  const out = new Set();

  try {
    const current = page.url();
    if (current) out.add(current);
  } catch { }

  try {
    for (const fr of page.frames()) {
      const u = fr.url();
      if (u) out.add(u);
    }
  } catch { }

  const domUrls = await page
    .evaluate(() => {
      const urls = [];
      const push = (u) => {
        if (!u || typeof u !== "string") return;
        const s = u.trim();
        if (s) urls.push(s);
      };

      const maybeStreamLike = (u) => {
        const s = String(u || "").toLowerCase();
        return (
          s.includes("/tv/") ||
          s.includes("albaplayer") ||
          s.includes("player") ||
          s.includes("embed") ||
          s.includes("stream")
        );
      };

      document.querySelectorAll("iframe").forEach((el) => {
        push(el.getAttribute("src"));
        push(el.getAttribute("data-src"));
        try {
          push(el.src);
        } catch { }
      });

      document.querySelectorAll("a[href]").forEach((a) => {
        const href = a.getAttribute("href") || "";
        if (!maybeStreamLike(href)) return;
        push(href);
        try {
          push(a.href);
        } catch { }
      });

      const scriptsText = Array.from(document.scripts)
        .map((s) => s.textContent || "")
        .join("\n");

      const raw = scriptsText.match(/https?:\/\/[^"'`\s]+/gi) || [];
      for (const u of raw) {
        if (maybeStreamLike(u)) push(u);
      }

      return urls;
    })
    .catch(() => []);

  for (const u of domUrls) out.add(u);

  return Array.from(out)
    .map((u) => normalizeUrl(u, baseUrl))
    .filter(Boolean);
}

async function scrapeLivehdToday(page) {
  console.log(`\n🟢 LIVEHD list: today => ${LIVEHD.listUrl}`);

  try {
    await page.goto(LIVEHD.listUrl, { waitUntil: "domcontentloaded", timeout: LIST_TIMEOUT_MS });
    await page.waitForSelector("#today .MatchITem, .MatchITem, body", { timeout: 30000 });
    await page.waitForTimeout(1200);

    await diagShot(page, "livehd/list_today.png");
    if (DIAG) {
      try {
        diagWrite("livehd/list_today.html", (await page.content()).slice(0, 350000));
      } catch { }
    }

    const rows = await page.evaluate(() => {
      const out = [];
      const toAbs = (u) => {
        try {
          return new URL(u, location.href).toString();
        } catch {
          return "";
        }
      };

      const pickTeam = (item, cls) => {
        const side = item.querySelector(`.${cls}`);
        if (!side) return "";

        const directSpans = Array.from(side.querySelectorAll(":scope > span"));
        for (const sp of directSpans) {
          const t = (sp.textContent || "").trim();
          if (t) return t;
        }

        const imgAlt = (side.querySelector("img[alt]")?.getAttribute("alt") || "").trim();
        if (imgAlt) return imgAlt;

        const fallback = (side.textContent || "").trim();
        return fallback || "";
      };

      const root = document.querySelector("#today") || document;
      const cards = Array.from(root.querySelectorAll(".MatchITem"));

      for (const card of cards) {
        const linkEl = card.querySelector("a[href]");
        const href = toAbs(linkEl?.getAttribute("href") || "");

        const home = pickTeam(card, "host");
        const away = pickTeam(card, "guest");

        const statusText = (card.querySelector(".match-status-text")?.textContent || "").trim();
        const timeText = (card.querySelector(".match-time-display")?.textContent || "").trim();

        if (!href || !home || !away) continue;

        out.push({
          home_team: home,
          away_team: away,
          match_url: href,
          status_text: statusText || null,
          time_text: timeText || null,
        });
      }

      return out;
    });

    const todayDate = matchDayFromKey("today");
    const final = rows
      .map((r) => ({ ...r, match_day: todayDate }))
      .filter((r) => r.home_team && r.away_team && r.match_url && r.match_day);

    console.log(`🟢 LIVEHD today: ${final.length} matches.`);
    if (DIAG) diagWrite("livehd/raw_today.json", JSON.stringify(final, null, 2));
    return final;
  } catch (e) {
    console.error("⚠️ LIVEHD list error:", e.message);
    return [];
  }
}

async function resolveLivehdFromTvPage(page, tvUrl) {
  try {
    await page.goto(tvUrl, { waitUntil: "domcontentloaded", timeout: DEEP_TIMEOUT_MS, referer: LIVEHD.listUrl });
    await page.waitForSelector("iframe, body", { timeout: 12000 }).catch(() => { });
    await page.waitForTimeout(800);

    const candidates = await collectLivehdCandidateUrlsFromPage(page, tvUrl);
    const best = pickBestLivehdUrl(candidates, { baseUrl: tvUrl });
    return normalizeLivehdServer3Url(best || null);
  } catch {
    return null;
  }
}

async function resolveLivehdStreamViaHttp(matchUrl) {
  if (!matchUrl) return null;
  try {
    const controller = new AbortController();
    const timeoutId = setTimeout(() => controller.abort(), HTTP_TIMEOUT_MS);
    const resp = await fetch(matchUrl, {
      method: "GET",
      headers: { ...DEFAULT_HTTP_HEADERS, Referer: LIVEHD.listUrl },
      redirect: "follow",
      signal: controller.signal,
    });
    clearTimeout(timeoutId);
    if (!resp.ok) return null;

    const html = await resp.text();
    const candidates = [];

    // Extract iframes/links
    // Simple regex for src="..."
    const srcMatches = html.matchAll(/(?:src|href)=["']([^"']+)["']/gi);
    for (const m of srcMatches) {
      if (m[1]) candidates.push(m[1]);
    }

    // Scripts
    const scriptUrls = html.match(/https?:\/\/[^"'`\s<>()]+/gi) || [];
    candidates.push(...scriptUrls);

    const clean = candidates
      .map(u => normalizeUrl(u, matchUrl))
      .filter(Boolean)
      .filter(u => !isClearlyNonStreamUrl(u));

    // Filter for LiveHD specific patterns
    const good = clean.filter(u => {
      const s = u.toLowerCase();
      return s.includes("albaplayer") || s.includes("playerv2.php") || s.includes("/tv/") || s.includes("embed") || s.includes("player");
    });

    const best = pickBestLivehdUrl(good, { baseUrl: matchUrl });
    if (best) return normalizeLivehdServer3Url(best);

    return null;
  } catch {
    return null;
  }
}

async function resolveLivehdStream(page, matchUrl) {
  if (!matchUrl) return null;

  // ⚡ HTTP Fast Path
  const fast = await resolveLivehdStreamViaHttp(matchUrl);
  if (fast) {
    dbg(`🟢 LIVEHD fast-http: ${fast}`);
    return fast;
  }

  try {
    await page.goto(matchUrl, { waitUntil: "domcontentloaded", timeout: DEEP_TIMEOUT_MS, referer: LIVEHD.listUrl });
    await page.waitForSelector("iframe, a[href], body", { timeout: 12000 }).catch(() => { });
    await page.waitForTimeout(800);

    const candidates = await collectLivehdCandidateUrlsFromPage(page, matchUrl);
    const best = pickBestLivehdUrl(candidates, { baseUrl: matchUrl });
    if (!best) return null;

    const bestLower = String(best).toLowerCase();
    if (bestLower.includes("livehd77.pro/tv/")) {
      const deep = await resolveLivehdFromTvPage(page, best);
      if (deep && scoreLivehdCandidate(deep) >= scoreLivehdCandidate(best)) {
        return normalizeLivehdServer3Url(deep);
      }
    }

    return normalizeLivehdServer3Url(best);
  } catch (e) {
    console.error(`⚠️ LIVEHD resolve error (${matchUrl}):`, e.message);
    return null;
  }
}

async function enrichLivehdWithStreams(browser, rows) {
  if (!rows.length) return [];

  const limit = Math.min(CONCURRENCY, rows.length);
  const queue = rows.map((r, idx) => ({ r, idx }));
  const out = new Array(rows.length);

  const worker = async (workerId) => {
    const context = await browser.newContext({
      locale: "ar-EG",
      timezoneId: TZ,
      serviceWorkers: "block",
      extraHTTPHeaders: {
        "Accept-Language": "ar-EG,ar;q=0.9,en-US;q=0.8,en;q=0.7",
        Referer: LIVEHD.listUrl,
      },
      userAgent:
        "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/121.0.0.0 Safari/537.36",
      viewport: { width: 1280, height: 720 },
    });

    const page = await context.newPage();
    await applyAntiAds(context, page);

    while (queue.length) {
      const item = queue.shift();
      if (!item) break;

      const { r, idx } = item;
      console.log(`🟢 LIVEHD [W${workerId}] (${idx + 1}/${rows.length}): ${r.home_team} vs ${r.away_team}`);
      const finalUrl = await resolveLivehdStream(page, r.match_url);
      out[idx] = { ...r, livehd_stream_url: finalUrl };
    }

    await context.close();
  };

  await Promise.all(Array.from({ length: limit }, (_, i) => worker(i + 1)));
  return out.filter((x) => x && x.livehd_stream_url);
}

function hostMatches(url, hostHint) {
  if (!url || !hostHint) return false;
  try {
    const host = new URL(url).hostname.toLowerCase();
    const hint = String(hostHint).toLowerCase();
    return host === hint || host.endsWith("." + hint);
  } catch {
    return false;
  }
}

function normalizeSpaces(v) {
  return String(v || "")
    .replace(/\s+/g, " ")
    .trim();
}

function scoreWithHostPreference(url, preferredHostHints = []) {
  const normalized = normalizeUrl(url, url);
  if (!normalized) return -99999;
  if (isClearlyNonStreamUrl(normalized)) return -99999;

  let score = scoreCandidate(normalized);
  const s = normalized.toLowerCase();

  if (s.includes("albaplayer")) score += 420;
  if (s.includes("playerv2.php")) score += 520;
  if (s.includes("embed")) score += 180;
  if (s.includes("/tv/")) score += 120;

  if (s.includes("/matches/") && (s.includes("yala-live.tv") || s.includes("tskoralive.com"))) score -= 600;

  if (Array.isArray(preferredHostHints) && preferredHostHints.length) {
    const hasPreferred = preferredHostHints.some((h) => s.includes(String(h).toLowerCase()));
    if (hasPreferred) score += 260;
  }

  return score;
}

function looksLikePlayerUrl(url) {
  const s = String(url || "").toLowerCase();
  if (!/^https?:\/\//i.test(s)) return false;
  return /\/albaplayer\/|\/alba\.php|\/playerv2\.php(\?|$)|\/embed|\/player|\/tv\//i.test(s);
}

async function scrapeAyMatchDay(page, { sourceName, dayKey, url, diagPrefix }) {
  console.log(`\n🟡 ${sourceName} list: ${dayKey} => ${url}`);
  if (!url) return [];

  try {
    await page.goto(url, { waitUntil: "domcontentloaded", timeout: LIST_TIMEOUT_MS });
    await page.waitForSelector(".AY_Match, .match-container, body", { timeout: 30000 });
    await page.waitForTimeout(900);
    await waitForStableMatchCount(page, 18000, 1200).catch(() => { });

    await diagShot(page, `${diagPrefix}/list_${dayKey}.png`);
    if (DIAG) {
      try {
        diagWrite(`${diagPrefix}/list_${dayKey}.html`, (await page.content()).slice(0, 350000));
      } catch { }
    }

    const rows = await page.evaluate(() => {
      const toAbs = (u) => {
        try {
          return new URL(u, location.href).toString();
        } catch {
          return "";
        }
      };

      const pickText = (root, selectors) => {
        for (const sel of selectors) {
          const el = root.querySelector(sel);
          const t = (el?.textContent || "").trim();
          if (t) return t;
        }
        return "";
      };

      const statusFromClass = (match) => {
        const cls = (match.className || "").toLowerCase();
        if (cls.includes("not-started")) return "upcoming";
        if (cls.includes("live")) return "live";
        if (cls.includes("finished") || cls.includes("ended")) return "finished";
        return "unknown";
      };

      const toIsoFromUnix = (raw) => {
        const v = String(raw || "").trim();
        if (!/^\d{9,13}$/.test(v)) return "";
        const asNum = Number.parseInt(v, 10);
        if (!Number.isFinite(asNum) || asNum <= 0) return "";
        const ms = v.length > 10 ? asNum : asNum * 1000;
        try {
          const d = new Date(ms);
          const t = d.getTime();
          if (!Number.isFinite(t)) return "";
          return d.toISOString();
        } catch {
          return "";
        }
      };

      const cards = Array.from(document.querySelectorAll(".AY_Match, .match-container"));
      return cards
        .map((match) => {
          const isBenacer = (match.className || "").toLowerCase().includes("match-container");
          const teams = isBenacer
            ? Array.from(match.querySelectorAll(".right-team .team-name, .left-team .team-name, .team-name"))
              .map((e) => (e.textContent || "").trim())
              .filter(Boolean)
            : Array.from(match.querySelectorAll(".TM_Name"))
              .map((e) => (e.textContent || "").trim())
              .filter(Boolean);

          const allLinks = isBenacer
            ? (() => {
              const out = [];
              const holder = match.closest("a[href]");
              if (holder) out.push(holder.getAttribute("href") || "");
              out.push(...Array.from(match.querySelectorAll("a[href]")).map((a) => a.getAttribute("href") || ""));
              return out
                .filter(Boolean)
                .map((u) => toAbs(u))
                .filter(Boolean);
            })()
            : Array.from(match.querySelectorAll("a[href]"))
              .map((a) => a.getAttribute("href") || "")
              .filter(Boolean)
              .map((u) => toAbs(u))
              .filter(Boolean);

          const dataStart = (() => {
            if (isBenacer) {
              const fromDateAttr = (match.querySelector(".date")?.getAttribute("data-start") || "").trim();
              if (fromDateAttr) return fromDateAttr;
              const fromUnix = toIsoFromUnix(match.getAttribute("data-start-time"));
              if (fromUnix) return fromUnix;
            }
            return (
              (match.getAttribute("data-start") || "").trim() ||
              (match.querySelector(".MT_Time")?.getAttribute("data-start") || "").trim()
            );
          })();

          const statusText = isBenacer
            ? pickText(match, [".match-status-text", ".match-status", ".status"])
            : pickText(match, [".MT_Stat", ".match-status", ".status"]);
          const timeText = isBenacer
            ? pickText(match, ["#match-time", ".match-time", ".time"])
            : pickText(match, [".MT_Time", ".match-time", ".time"]);
          const channelText = isBenacer
            ? pickText(match, [".match-info li:nth-child(2) span", ".match-info li span", ".channel", ".ch"])
            : pickText(match, [".MT_Channel", ".TM_Channel", ".channel", ".ch"]);
          const statusKey = statusFromClass(match);

          const matchUrl = allLinks[0] || "";
          if (!teams[0] || !teams[1] || !matchUrl) return null;

          return {
            home_team: teams[0],
            away_team: teams[1],
            match_url: matchUrl,
            data_start: dataStart || null,
            status_text: statusText || null,
            status_key_dom: statusKey || "unknown",
            time_text: timeText || null,
            channel_text: channelText || null,
          };
        })
        .filter(Boolean);
    });

    const final = rows
      .map((r) => {
        const iso = toIsoFromDataStart(r.data_start);
        return {
          ...r,
          match_day: cairoDayFromIso(iso) || matchDayFromKey(dayKey),
        };
      })
      .filter((r) => r.home_team && r.away_team && r.match_url && r.match_day);

    if (final.length) {
      console.log(`🟡 ${sourceName} ${dayKey}: ${final.length} items`);
      if (DIAG) diagWrite(`${diagPrefix}/raw_${dayKey}.json`, JSON.stringify(final, null, 2));
      return final;
    }

    const httpFallback = await fetchAyMatchRowsFallback(url, dayKey);
    console.log(`🟡 ${sourceName} ${dayKey}: 0 (browser) -> ${httpFallback.length} (http fallback)`);
    if (DIAG) diagWrite(`${diagPrefix}/raw_${dayKey}.json`, JSON.stringify(httpFallback, null, 2));
    return httpFallback;
  } catch (e) {
    console.error(`⚠️ ${sourceName} list fail ${dayKey}:`, e.message);
    if (DIAG) diagWrite(`${diagPrefix}/errors_${dayKey}.txt`, String(e?.stack || e?.message || e));
    const httpFallback = await fetchAyMatchRowsFallback(url, dayKey);
    if (httpFallback.length) {
      console.log(`🟡 ${sourceName} ${dayKey}: recovered with http fallback (${httpFallback.length})`);
      return httpFallback;
    }
    return [];
  }
}

async function resolveStreamFromPage(page, pageUrl, { preferredHostHints = [] } = {}) {
  if (!pageUrl) return null;

  try {
    await page.goto(pageUrl, { waitUntil: "domcontentloaded", timeout: DEEP_TIMEOUT_MS });
    await page.waitForSelector("iframe, a[href], body", { timeout: 12000 }).catch(() => { });
    await page.waitForTimeout(900);

    const domUrls = await page
      .evaluate(() => {
        const urls = [];
        const push = (u) => {
          if (!u || typeof u !== "string") return;
          const s = u.trim();
          if (s) urls.push(s);
        };

        document.querySelectorAll("iframe[src], iframe[data-src]").forEach((el) => {
          push(el.getAttribute("src"));
          push(el.getAttribute("data-src"));
          try {
            push(el.src);
          } catch { }
        });

        document.querySelectorAll("a[href]").forEach((el) => {
          push(el.getAttribute("href"));
          try {
            push(el.href);
          } catch { }
        });

        document.querySelectorAll("video[src], source[src]").forEach((el) => {
          push(el.getAttribute("src"));
        });

        const scriptsText = Array.from(document.scripts)
          .map((s) => s.textContent || "")
          .join("\n");

        const found = scriptsText.match(/https?:\/\/[^"'`\s<>()]+/gi) || [];
        for (const u of found) push(u);

        return urls;
      })
      .catch(() => []);

    const candidates = Array.from(new Set(domUrls))
      .map((u) => normalizeUrl(u, pageUrl))
      .filter(Boolean)
      .filter((u) => u !== pageUrl && !isClearlyNonStreamUrl(u));

    const filtered = candidates.filter((u) => {
      try {
        const cu = new URL(u);
        const pu = new URL(pageUrl);
        const path = cu.pathname.toLowerCase().replace(/\/+$/, "") || "/";
        const leaf = path.replace(/^\/+/, "");

        if (path === "/" && !cu.search) return false;
        if (cu.hostname === pu.hostname && /^(matches(?:-(today|yesterday|tomorrow))?|category|tag|author)?$/i.test(leaf)) {
          return false;
        }
        return true;
      } catch {
        return true;
      }
    });

    if (!filtered.length) return null;

    // Prefer direct player endpoints over wrapper/article pages.
    const strongPlayerCandidates = filtered.filter((u) =>
      /\/albaplayer\/|\/alba\.php|\/playerv2\.php(\?|$)/i.test(String(u))
    );

    const pool = strongPlayerCandidates.length ? strongPlayerCandidates : filtered;
    const sorted = pool.sort(
      (a, b) => scoreWithHostPreference(b, preferredHostHints) - scoreWithHostPreference(a, preferredHostHints)
    );

    const best = sorted[0];
    if (!best) return null;
    if (scoreWithHostPreference(best, preferredHostHints) < -400) return null;
    if (!looksLikePlayerUrl(best)) return null;
    return best;
  } catch {
    return null;
  }
}

async function scrapeYalaDay(page, dayKey) {
  return scrapeAyMatchDay(page, {
    sourceName: "LIVEKORA",
    dayKey,
    url: YALA.dayUrl[dayKey],
    diagPrefix: "yala",
  });
}

function deriveYalaFallbackPlayerUrl(rawUrl) {
  const normalized = normalizeUrl(rawUrl, rawUrl);
  if (!normalized) return null;

  try {
    const u = new URL(normalized);
    const host = u.hostname.toLowerCase();
    const path = u.pathname.toLowerCase().replace(/^\/+|\/+$/g, "");

    if ((host === "a.sia-bth.net" || host.endsWith(".sia-bth.net")) && path && !path.includes("albaplayer")) {
      return `https://e.kooraxx.com/albaplayer/${path}/`;
    }

    if ((host === "e.kooraxx.com" || host.endsWith(".kooraxx.com")) && looksLikePlayerUrl(normalized)) {
      return normalized;
    }

    if (host === "pl.koooralive.click" || host.endsWith(".koooralive.click")) {
      if (path.includes("/albaplayer/") && looksLikePlayerUrl(normalized)) return normalized;
      if (path) return `${u.protocol}//${u.host}/albaplayer/${path.replace(/^\/+|\/+$/g, "")}/`;
    }
  } catch { }

  return null;
}

function normalizeYalaServer4UrlForPlayback(rawUrl) {
  const normalized = normalizeUrl(rawUrl, rawUrl);
  if (!normalized) return null;
  try {
    const u = new URL(normalized);
    const host = u.hostname.toLowerCase();
    const shouldForceHttp =
      host === "livekora.vip" ||
      host.endsWith(".livekora.vip") ||
      host === "koooralive.click" ||
      host.endsWith(".koooralive.click");
    if (!shouldForceHttp) return normalized;
    if (u.protocol === "http:") return normalized;
    u.protocol = "http:";
    return u.toString();
  } catch {
    return normalized;
  }
}

async function enrichYalaWithStreams(browser, rows) {
  if (!rows.length) return [];

  const limit = Math.min(CONCURRENCY, rows.length);
  const queue = rows.map((r, idx) => ({ r, idx }));
  const out = new Array(rows.length);

  const worker = async (workerId) => {
    const context = await browser.newContext({
      locale: "ar-EG",
      timezoneId: TZ,
      serviceWorkers: "block",
      extraHTTPHeaders: { "Accept-Language": "ar-EG,ar;q=0.9,en-US;q=0.8,en;q=0.7" },
      userAgent:
        "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/121.0.0.0 Safari/537.36",
      viewport: { width: 1280, height: 720 },
    });

    const page = await context.newPage();
    await applyAntiAds(context, page);

    while (queue.length) {
      const item = queue.shift();
      if (!item) break;

      const { r, idx } = item;
      console.log(`🟡 LIVEKORA [W${workerId}] (${idx + 1}/${rows.length}): ${r.home_team} vs ${r.away_team}`);

      const raw = normalizeUrl(r.match_url, r.match_url);
      let finalUrl = null;

      if (raw) {
        finalUrl = deriveYalaFallbackPlayerUrl(raw);

        if (!finalUrl) {
          const looksDirectPlayer = looksLikePlayerUrl(raw);
          if (looksDirectPlayer && !isClearlyNonStreamUrl(raw)) finalUrl = raw;
        }

        if (!finalUrl) {
          finalUrl = await resolveStreamFromPage(page, raw, {
            preferredHostHints: [
              "koooralive.click",
              "livekora.vip",
              "kooraxx.com",
              "a.sia-bth.net",
              "koora",
              "kora",
              "albaplayer",
              "pyxq.online",
            ],
          });
        }

        if (finalUrl && !looksLikePlayerUrl(finalUrl)) finalUrl = null;
      }

      out[idx] = { ...r, yala_stream_url: normalizeYalaServer4UrlForPlayback(finalUrl) };
    }

    await context.close();
  };

  await Promise.all(Array.from({ length: limit }, (_, i) => worker(i + 1)));
  return out.filter((x) => x && x.yala_stream_url);
}

async function scrapeTskoraDay(page, dayKey) {
  return scrapeAyMatchDay(page, {
    sourceName: "TSKORA",
    dayKey,
    url: TSKORA.dayUrl[dayKey],
    diagPrefix: "tskora",
  });
}

async function resolveAyStreamViaHttp(url, preferredHostHints = []) {
  if (!url) return null;
  try {
    const controller = new AbortController();
    const timeoutId = setTimeout(() => controller.abort(), HTTP_TIMEOUT_MS);
    const resp = await fetch(url, {
      method: "GET",
      headers: DEFAULT_HTTP_HEADERS,
      redirect: "follow",
      signal: controller.signal
    });
    clearTimeout(timeoutId);
    if (!resp.ok) return null;

    const html = await resp.text();
    const candidates = [];
    const srcMatches = html.matchAll(/(?:src|href)=["']([^"']+)["']/gi);
    for (const m of srcMatches) {
      if (m[1]) candidates.push(m[1]);
    }
    const scriptUrls = html.match(/https?:\/\/[^"'`\s<>()]+/gi) || [];
    candidates.push(...scriptUrls);

    const clean = candidates
      .map(u => normalizeUrl(u, url))
      .filter(Boolean)
      .filter(u => !isClearlyNonStreamUrl(u));

    // Filter for strong player hints
    const pool = clean.filter(u => looksLikePlayerUrl(u));

    if (pool.length) {
      return pool[0];
    }

    return null;
  } catch {
    return null;
  }
}

async function enrichTskoraWithStreams(browser, rows) {
  if (!rows.length) return [];

  const limit = Math.min(CONCURRENCY, rows.length);
  const queue = rows.map((r, idx) => ({ r, idx }));
  const out = new Array(rows.length);

  const worker = async (workerId) => {
    const context = await browser.newContext({
      locale: "ar-EG",
      timezoneId: TZ,
      serviceWorkers: "block",
      extraHTTPHeaders: { "Accept-Language": "ar-EG,ar;q=0.9,en-US;q=0.8,en;q=0.7" },
      userAgent:
        "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/121.0.0.0 Safari/537.36",
      viewport: { width: 1280, height: 720 },
    });

    const page = await context.newPage();
    await applyAntiAds(context, page);

    while (queue.length) {
      const item = queue.shift();
      if (!item) break;

      const { r, idx } = item;
      console.log(`🟠 TSKORA [W${workerId}] (${idx + 1}/${rows.length}): ${r.home_team} vs ${r.away_team}`);

      const raw = normalizeUrl(r.match_url, r.match_url);
      let finalUrl = null;

      if (raw) {
        // ⚡ HTTP Fast Path
        finalUrl = await resolveAyStreamViaHttp(raw, ["pyxq.online", "albaplayer", "koora", "kora"]);
        if (finalUrl) {
          dbg(`🟠 TSKORA fast-http: ${finalUrl}`);
        } else {
          // Browser fallback
          finalUrl = await resolveStreamFromPage(page, raw, {
            preferredHostHints: ["pyxq.online", "albaplayer", "koora", "kora"],
          });

          if (!finalUrl) {
            const fallback = pickTskoraStreamUrl(raw);
            finalUrl = looksLikePlayerUrl(fallback) ? fallback : null;
          }
        }
      }

      out[idx] = { ...r, tskora_stream_url: finalUrl };
    }

    await context.close();
  };

  await Promise.all(Array.from({ length: limit }, (_, i) => worker(i + 1)));
  return out.filter((x) => x && x.tskora_stream_url);
}

function pickTskoraStreamUrl(rawUrl) {
  const normalized = normalizeUrl(rawUrl, rawUrl);
  if (!normalized) return null;
  if (isClearlyNonStreamUrl(normalized)) return null;

  try {
    const u = new URL(normalized);
    const host = u.hostname.toLowerCase();
    const path = u.pathname.toLowerCase();
    const isPyxq = host === "p.pyxq.online" || host.endsWith(".pyxq.online");
    const isAlreadyPlayer = path.includes("/albaplayer/") || path.includes("/alba.php");

    if (isPyxq && !isAlreadyPlayer) {
      const slug = path.replace(/^\/+|\/+$/g, "");
      if (slug && /^[a-z0-9-]+$/i.test(slug)) {
        return `${u.protocol}//${u.host}/albaplayer/${slug}/`;
      }
    }
  } catch { }

  return normalized;
}

function parseOneKoraTeamsFromTitle(titleRaw) {
  const title = normalizeSpaces(titleRaw)
    .replace(/\s*-\s*ون كورة.*$/i, "")
    .replace(/\s*-\s*1kora.*$/i, "");

  if (!title) return null;

  const stripped = title.replace(/^(?:مشاهدة|نتيجة|موعد)\s+مباراة\s+/i, "");
  const m = stripped.match(
    /^(.+?)\s+و\s+(.+?)(?:\s+(?:الدوري|دورى|دوري|كأس|كاس|بطولة|فى|في|اليوم|مباشر)\b.*)?$/i
  );
  if (m) return { home_team: normalizeSpaces(m[1]), away_team: normalizeSpaces(m[2]) };

  const vsMatch = stripped.match(/^(.+?)\s+(?:ضد|VS|vs)\s+(.+)$/i);
  if (vsMatch) return { home_team: normalizeSpaces(vsMatch[1]), away_team: normalizeSpaces(vsMatch[2]) };

  return null;
}

function scoreOneKoraCandidate(url) {
  const normalized = normalizeUrl(url, url);
  if (!normalized) return -99999;
  if (isClearlyNonStreamUrl(normalized)) return -99999;

  let score = scoreCandidate(normalized);
  const s = normalized.toLowerCase();

  if (s.includes("albaplayer")) score += 550;
  if (s.includes("playerv2.php")) score += 600;
  if (s.includes("alkoora.live")) score += 350;
  if (s.includes("koora")) score += 120;
  if (s.includes("ahlamontada.com")) score += 50;
  if (s.includes("youtube.com/embed")) score -= 500;

  return score;
}

function looksLikeOneKoraArticleUrl(url) {
  const normalized = normalizeUrl(url, url);
  if (!normalized) return false;
  return /^https?:\/\/(?:www\.)?1kora\.com\/\d+\/?$/i.test(normalized);
}

async function scrapeOneKoraArticleList(page) {
  console.log(`\n🟣 1KORA list => ${ONEKORA.listUrl}`);

  try {
    await page.goto(ONEKORA.listUrl, { waitUntil: "domcontentloaded", timeout: LIST_TIMEOUT_MS });
    await page.waitForSelector("a[href], body", { timeout: 30000 });
    await page.waitForTimeout(1200);

    await diagShot(page, "onekora/list.png");
    if (DIAG) {
      try {
        diagWrite("onekora/list.html", (await page.content()).slice(0, 350000));
      } catch { }
    }

    const articleLinks = await page.evaluate(() => {
      const urls = [];
      const seen = new Set();
      for (const a of document.querySelectorAll("a[href]")) {
        const href = a.getAttribute("href") || "";
        let abs = "";
        try {
          abs = new URL(href, location.href).toString();
        } catch {
          abs = "";
        }
        if (!abs) continue;
        if (!/^https?:\/\/(?:www\.)?1kora\.com\/\d+\/?$/i.test(abs)) continue;
        if (seen.has(abs)) continue;
        seen.add(abs);
        urls.push(abs);
      }
      return urls;
    });

    const final = articleLinks.filter(looksLikeOneKoraArticleUrl).slice(0, ONEKORA.maxArticles);
    console.log(`🟣 1KORA articles: ${final.length}`);
    if (DIAG) diagWrite("onekora/article_links.json", JSON.stringify(final, null, 2));
    return final;
  } catch (e) {
    console.error("⚠️ 1KORA list error:", e.message);
    return [];
  }
}

async function resolveOneKoraArticle(page, articleUrl) {
  try {
    await page.goto(articleUrl, { waitUntil: "domcontentloaded", timeout: DEEP_TIMEOUT_MS, referer: ONEKORA.listUrl });
    await page.waitForSelector("h1, a[href], iframe, body", { timeout: 12000 }).catch(() => { });
    await page.waitForTimeout(800);

    const articleMeta = await page.evaluate(() => {
      const h1 = (document.querySelector("h1")?.textContent || "").trim();
      const title = (document.title || "").trim();
      return { h1, title };
    });

    const parsedTeams = parseOneKoraTeamsFromTitle(articleMeta.h1 || articleMeta.title || "");
    if (!parsedTeams?.home_team || !parsedTeams?.away_team) return null;

    const domUrls = await page
      .evaluate(() => {
        const urls = [];
        const push = (u) => {
          if (!u || typeof u !== "string") return;
          const s = u.trim();
          if (s) urls.push(s);
        };

        document.querySelectorAll("a[href], iframe[src], iframe[data-src], video[src], source[src]").forEach((el) => {
          push(el.getAttribute("href"));
          push(el.getAttribute("src"));
          push(el.getAttribute("data-src"));
        });

        const scriptsText = Array.from(document.scripts)
          .map((s) => s.textContent || "")
          .join("\n");
        const found = scriptsText.match(/https?:\/\/[^"'`\s<>()]+/gi) || [];
        for (const u of found) push(u);

        return urls;
      })
      .catch(() => []);

    const candidates = Array.from(new Set(domUrls))
      .map((u) => normalizeUrl(u, articleUrl))
      .filter(Boolean)
      .filter((u) => !hostMatches(u, ONEKORA.siteHost))
      .filter((u) => !isClearlyNonStreamUrl(u));

    if (!candidates.length) return null;

    candidates.sort((a, b) => scoreOneKoraCandidate(b) - scoreOneKoraCandidate(a));
    let best = candidates[0];
    if (!best) return null;

    const needsResolve =
      /ahlamontada\.com/i.test(best) ||
      /\/h\d+-page$/i.test(best) ||
      scoreOneKoraCandidate(best) < 120;

    if (needsResolve) {
      const resolved = await resolveFinalUrlViaBrowser(page.context(), best, { timeoutMs: 16000 });
      if (resolved && !isClearlyNonStreamUrl(resolved)) {
        best = normalizeUrl(resolved, resolved) || best;
      }
    }

    if (!best || scoreOneKoraCandidate(best) < -500) return null;

    return {
      ...parsedTeams,
      match_day: matchDayFromKey("today"),
      article_url: articleUrl,
      onekora_stream_url: best,
    };
  } catch (e) {
    dbg("⚠️ 1KORA article resolve failed:", articleUrl, e?.message || e);
    return null;
  }
}

async function resolveOneKoraArticleViaHttp(articleUrl) {
  if (!articleUrl) return null;
  try {
    const controller = new AbortController();
    const timeoutId = setTimeout(() => controller.abort(), HTTP_TIMEOUT_MS);
    const resp = await fetch(articleUrl, {
      method: "GET",
      headers: { ...DEFAULT_HTTP_HEADERS, Referer: ONEKORA.listUrl },
      redirect: "follow",
      signal: controller.signal
    });
    clearTimeout(timeoutId);
    if (!resp.ok) return null;

    const html = await resp.text();
    const h1 = (html.match(/<h1[^>]*>([\s\S]*?)<\/h1>/i) || [])[1];
    const title = (html.match(/<title>([\s\S]*?)<\/title>/i) || [])[1];
    const parsedTeams = parseOneKoraTeamsFromTitle(stripHtmlToText(h1 || title));

    if (!parsedTeams?.home_team || !parsedTeams?.away_team) return null;

    // Find links
    const candidates = [];
    const srcMatches = html.matchAll(/(?:src|href)=["']([^"']+)["']/gi);
    for (const m of srcMatches) { if (m[1]) candidates.push(m[1]); }
    const scriptUrls = html.match(/https?:\/\/[^"'`\s<>()]+/gi) || [];
    candidates.push(...scriptUrls);

    const clean = candidates
      .map(u => normalizeUrl(u, articleUrl))
      .filter(Boolean)
      .filter(u => !isClearlyNonStreamUrl(u))
      .filter(u => !hostMatches(u, ONEKORA.siteHost));

    clean.sort((a, b) => scoreOneKoraCandidate(b) - scoreOneKoraCandidate(a));
    const best = clean[0];

    if (!best || scoreOneKoraCandidate(best) < -500) return null;
    // Avoid complex resolves on HTTP path
    if (/ahlamontada\.com/i.test(best)) return null;

    return {
      ...parsedTeams,
      match_day: matchDayFromKey("today"),
      article_url: articleUrl,
      onekora_stream_url: best
    };
  } catch {
    return null;
  }
}

async function enrichOneKoraWithStreams(browser, articleUrls) {
  if (!articleUrls.length) return [];

  const limit = Math.min(CONCURRENCY, articleUrls.length);
  const queue = articleUrls.map((u, idx) => ({ u, idx }));
  const out = new Array(articleUrls.length);

  const worker = async (workerId) => {
    const context = await browser.newContext({
      locale: "ar-EG",
      timezoneId: TZ,
      serviceWorkers: "block",
      extraHTTPHeaders: { "Accept-Language": "ar-EG,ar;q=0.9,en-US;q=0.8,en;q=0.7" },
      userAgent:
        "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/121.0.0.0 Safari/537.36",
      viewport: { width: 1280, height: 720 },
    });

    const page = await context.newPage();
    await applyAntiAds(context, page);

    while (queue.length) {
      const item = queue.shift();
      if (!item) break;
      const { u, idx } = item;

      console.log(`🟣 1KORA [W${workerId}] (${idx + 1}/${articleUrls.length}): ${u}`);

      // ⚡ HTTP Fast Path
      let res = await resolveOneKoraArticleViaHttp(u);
      if (res) {
        dbg(`🟣 1KORA fast-http: ${res.onekora_stream_url}`);
        out[idx] = res;
      } else {
        // Fallback
        out[idx] = await resolveOneKoraArticle(page, u);
      }
    }

    await context.close();
  };

  await Promise.all(Array.from({ length: limit }, (_, i) => worker(i + 1)));
  return out.filter((x) => x && x.onekora_stream_url);
}

// ===================== Main =====================
async function startScraping() {
  console.log(
    "🚀 بدء السكرابر (bein-live) + Server2 (SIIIR) + Server3 (LIVEHD77) + Server4 (LIVEKORA) + Server5 (TSKORA) + Server6 (1KORA) ..."
  );
  console.log(`⚙️ day scope: ${SCRAPE_DAY_SCOPE_RAW} => [${ACTIVE_DAY_KEYS.join(", ")}]`);

  diagTouch();
  resetTeamNameAliasPatchMetrics();

  const browser = await chromium.launch({
    headless: HEADLESS,
    args: ["--disable-blink-features=AutomationControlled", "--no-sandbox", "--disable-dev-shm-usage"],
  });

  const listContext = await browser.newContext({
    locale: "ar-EG",
    timezoneId: TZ,
    serviceWorkers: "block",
    extraHTTPHeaders: { "Accept-Language": "ar-EG,ar;q=0.9,en-US;q=0.8,en;q=0.7" },
    userAgent:
      "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/121.0.0.0 Safari/537.36",
    viewport: { width: 1280, height: 720 },
  });

  const page = await listContext.newPage();
  await applyAntiAds(listContext, page);

  try {
    // 1) bein-live schedule
    const all = [];
    let usedPrimarySiiirFallback = false;
    const isolationStats = createServerIsolationStats();
    for (const d of ACTIVE_DAYS) {
      let rows = [];
      try {
        rows = await scrapeOneDay(page, d.key, d.url);
      } catch (e) {
        console.error(`⚠️ فشل سحب ${d.key}:`, e.message);
        if (DIAG) diagWrite(`errors/${d.key}.txt`, String(e?.stack || e?.message || e));
      }

      if (!rows.length && PRIMARY_FALLBACK_SIIIR_DAY_URL[d.key]) {
        const fallbackUrl = PRIMARY_FALLBACK_SIIIR_DAY_URL[d.key];
        console.warn(`⚠️ primary fallback active (${d.key}): ${fallbackUrl}`);
        const fallbackRows = await fetchAyMatchRowsFallback(fallbackUrl, d.key);
        rows = convertAyFallbackRowsToListRows(fallbackRows);
        if (rows.length) usedPrimarySiiirFallback = true;
      }

      all.push(...rows.map((r) => ({ ...r, _day_key: d.key })));
    }

    if (!all.length) {
      console.warn("[warn] Primary schedule source returned 0 rows. Continuing with fallback schedule sources.");
    }

    const enriched = all.length ? await enrichWithDeepLinks(browser, all) : [];

    // 2) SIIIR lists + resolve iframe src
    const siiirListContext = await browser.newContext({
      locale: "ar-EG",
      timezoneId: TZ,
      serviceWorkers: "block",
      extraHTTPHeaders: { "Accept-Language": "ar-EG,ar;q=0.9,en-US;q=0.8,en;q=0.7" },
      userAgent:
        "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/121.0.0.0 Safari/537.36",
      viewport: { width: 1280, height: 720 },
    });
    const siiirListPage = await siiirListContext.newPage();
    await applyAntiAds(siiirListContext, siiirListPage);

    const siiirAll = [];
    for (const d of ACTIVE_DAYS) {
      try {
        const rows = await scrapeSiiirDay(siiirListPage, d.key);
        siiirAll.push(...rows);
      } catch (e) {
        console.error(`⚠️ SIIIR list fail ${d.key}:`, e.message);
        if (DIAG) diagWrite(`siiir/errors_${d.key}.txt`, String(e?.stack || e?.message || e));
      }
    }
    await siiirListPage.close().catch(() => { });
    await siiirListContext.close().catch(() => { });

    const siiirEnriched = await enrichSiiirWithPlayerUrls(browser, siiirAll);

    // map SIIIR by match key
    const siiirMap = new Map();
    for (const r of siiirEnriched) {
      if (!r.siiir_stream_url) continue;
      const k = keyOfTeams(r.match_day, r.home_team, r.away_team);
      if (!siiirMap.has(k)) siiirMap.set(k, r.siiir_stream_url);
    }

    // 3) LIVEHD77 list (today only) + resolve stream url
    const livehdListContext = await browser.newContext({
      locale: "ar-EG",
      timezoneId: TZ,
      serviceWorkers: "block",
      extraHTTPHeaders: { "Accept-Language": "ar-EG,ar;q=0.9,en-US;q=0.8,en;q=0.7" },
      userAgent:
        "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/121.0.0.0 Safari/537.36",
      viewport: { width: 1280, height: 720 },
    });
    const livehdListPage = await livehdListContext.newPage();
    await applyAntiAds(livehdListContext, livehdListPage);

    const livehdRows = await scrapeLivehdToday(livehdListPage);
    await livehdListPage.close().catch(() => { });
    await livehdListContext.close().catch(() => { });

    const livehdEnriched = await enrichLivehdWithStreams(browser, livehdRows);

    const livehdMap = new Map();
    for (const r of livehdEnriched) {
      if (!r.livehd_stream_url) continue;
      const k = keyOfTeams(r.match_day, r.home_team, r.away_team);
      if (!livehdMap.has(k)) livehdMap.set(k, r.livehd_stream_url);
    }

    // 4) LIVEKORA lists + resolve stream url (Server 4)
    let yalaEnriched = [];
    const yalaAll = [];
    const yalaDirectRows = [];
    const yalaDirectMap = new Map();
    const yalaMap = new Map();
    if (ENABLE_SERVER4_YALA) {
      const yalaListContext = await browser.newContext({
        locale: "ar-EG",
        timezoneId: TZ,
        serviceWorkers: "block",
        extraHTTPHeaders: { "Accept-Language": "ar-EG,ar;q=0.9,en-US;q=0.8,en;q=0.7" },
        userAgent:
          "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/121.0.0.0 Safari/537.36",
        viewport: { width: 1280, height: 720 },
      });
      const yalaListPage = await yalaListContext.newPage();
      await applyAntiAds(yalaListContext, yalaListPage);

      for (const d of ACTIVE_DAYS) {
        const dayUrl = YALA.dayUrl[d.key];
        if (!dayUrl) continue;
        try {
          const rows = await scrapeYalaDay(yalaListPage, d.key);
          yalaAll.push(...rows);
        } catch (e) {
          console.error(`⚠️ LIVEKORA list fail ${d.key}:`, e.message);
          if (DIAG) diagWrite(`yala/errors_${d.key}.txt`, String(e?.stack || e?.message || e));
        }
      }
      await yalaListPage.close().catch(() => { });
      await yalaListContext.close().catch(() => { });

      const directRows = yalaAll
        .map((r) => {
          const raw = normalizeUrl(r.match_url, r.match_url);
          let direct = deriveYalaFallbackPlayerUrl(raw);
          if (!direct && raw && looksLikePlayerUrl(raw) && !isClearlyNonStreamUrl(raw)) direct = raw;
          if (!direct || !looksLikePlayerUrl(direct)) return null;
          return { ...r, yala_stream_url: normalizeYalaServer4UrlForPlayback(direct) };
        })
        .filter(Boolean);
      yalaDirectRows.push(...directRows);

      for (const r of yalaDirectRows) {
        const k = keyOfTeams(r.match_day, r.home_team, r.away_team);
        if (!yalaDirectMap.has(k)) yalaDirectMap.set(k, r.yala_stream_url);
      }

      yalaEnriched = await enrichYalaWithStreams(browser, yalaAll);
      for (const r of yalaEnriched) {
        if (!r.yala_stream_url) continue;
        const k = keyOfTeams(r.match_day, r.home_team, r.away_team);
        if (!yalaMap.has(k)) yalaMap.set(k, r.yala_stream_url);
      }

      if (DIAG) {
        diagWrite(`yala/enriched_${Date.now()}.json`, JSON.stringify(yalaEnriched, null, 2));
        diagWrite(
          `yala/maps_${Date.now()}.json`,
          JSON.stringify(
            {
              yalaAll: yalaAll.length,
              yalaDirectRows: yalaDirectRows.length,
              yalaDirectMapSize: yalaDirectMap.size,
              yalaEnriched: yalaEnriched.length,
              yalaMapSize: yalaMap.size,
            },
            null,
            2
          )
        );
      }
    } else {
      console.log("⏭️ LIVEKORA source disabled (Server 4).");
    }

    // 5) TSKORA lists (Server 5)
    const tskoraContext = await browser.newContext({
      locale: "ar-EG",
      timezoneId: TZ,
      serviceWorkers: "block",
      extraHTTPHeaders: { "Accept-Language": "ar-EG,ar;q=0.9,en-US;q=0.8,en;q=0.7" },
      userAgent:
        "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/121.0.0.0 Safari/537.36",
      viewport: { width: 1280, height: 720 },
    });
    const tskoraPage = await tskoraContext.newPage();
    await applyAntiAds(tskoraContext, tskoraPage);

    const tskoraAll = [];
    for (const d of ACTIVE_DAYS) {
      try {
        const rows = await scrapeTskoraDay(tskoraPage, d.key);
        tskoraAll.push(...rows);
      } catch (e) {
        console.error(`⚠️ TSKORA list fail ${d.key}:`, e.message);
        if (DIAG) diagWrite(`tskora/errors_${d.key}.txt`, String(e?.stack || e?.message || e));
      }
    }
    await tskoraPage.close().catch(() => { });
    await tskoraContext.close().catch(() => { });

    const tskoraEnriched = await enrichTskoraWithStreams(browser, tskoraAll);
    const tskoraMap = new Map();
    for (const r of tskoraEnriched) {
      if (!r.tskora_stream_url) continue;
      const k = keyOfTeams(r.match_day, r.home_team, r.away_team);
      if (!tskoraMap.has(k)) tskoraMap.set(k, r.tskora_stream_url);
    }

    // 6) 1KORA articles + resolve stream url (Server 6)
    const oneKoraListContext = await browser.newContext({
      locale: "ar-EG",
      timezoneId: TZ,
      serviceWorkers: "block",
      extraHTTPHeaders: { "Accept-Language": "ar-EG,ar;q=0.9,en-US;q=0.8,en;q=0.7" },
      userAgent:
        "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/121.0.0.0 Safari/537.36",
      viewport: { width: 1280, height: 720 },
    });
    const oneKoraListPage = await oneKoraListContext.newPage();
    await applyAntiAds(oneKoraListContext, oneKoraListPage);
    const oneKoraArticles = await scrapeOneKoraArticleList(oneKoraListPage);
    await oneKoraListPage.close().catch(() => { });
    await oneKoraListContext.close().catch(() => { });

    const oneKoraEnriched = await enrichOneKoraWithStreams(browser, oneKoraArticles);
    const oneKoraMap = new Map();
    for (const r of oneKoraEnriched) {
      if (!r.onekora_stream_url) continue;
      const k = keyOfTeams(r.match_day, r.home_team, r.away_team);
      if (!oneKoraMap.has(k)) oneKoraMap.set(k, r.onekora_stream_url);
    }

    const { rows: scheduleSeedRows, stats: scheduleSeedStats } = buildScheduleSeedRows({
      primaryRows: enriched,
      siiirRows: siiirAll,
      livehdRows,
      livekoraRows: yalaAll,
      tskoraRows: tskoraAll,
      onekoraRows: oneKoraEnriched,
    });

    if (!scheduleSeedRows.length) {
      console.log("⚠️ no schedule rows could be built from any source.");
      if (DIAG) {
        diagWrite(
          "summary.json",
          JSON.stringify(
            {
              note: "no schedule rows from all sources",
              schedule_seed_stats: scheduleSeedStats,
            },
            null,
            2
          )
        );
      }
      return;
    }

    // 7) Normalize schedule seed rows + attach servers 2..7
    const normalizedByKey = new Map();
    for (const m of scheduleSeedRows) {
      const isoFromAttr = toIsoFromDataStart(m.data_start);
      const match_day = m.match_day || matchDayFromKey(m._day_key) || cairoDayFromIso(isoFromAttr);
      const match_start = isoFromAttr || null;

      const statusTextRaw = String(m.deep_status_text || m.status_text || "").trim();
      let statusKey = pickKnownStatusKey(m.deep_status_key_dom, m.status_key_dom);
      if (statusKey === "unknown") statusKey = statusKeyFromText(statusTextRaw);

      if (statusKey === "unknown") {
        if (m._day_key === "yesterday") statusKey = "finished";
        else if (m._day_key === "tomorrow") statusKey = "upcoming";
        else statusKey = "unknown";
      }

      const homeScoreRaw = m.deep_home_score_raw ?? m.home_score_raw;
      const awayScoreRaw = m.deep_away_score_raw ?? m.away_score_raw;
      let home_score = statusKey === "upcoming" ? null : parseScore(homeScoreRaw);
      let away_score = statusKey === "upcoming" ? null : parseScore(awayScoreRaw);
      if (statusKey !== "upcoming" && (home_score === null || away_score === null)) {
        const pairFromStatus = extractScorePairFromText(statusTextRaw);
        if (pairFromStatus) {
          home_score = pairFromStatus.home;
          away_score = pairFromStatus.away;
        }
      }
      if (statusKey !== "upcoming" && (home_score === null || away_score === null)) {
        // Do not infer scores from kickoff time text (e.g. 05:25).
      }
      if (
        statusKey === "unknown" &&
        home_score !== null &&
        away_score !== null &&
        m._day_key !== "tomorrow"
      ) {
        statusKey =
          m._day_key === "yesterday" || isLikelyFinishedByTime(match_start)
            ? "finished"
            : "live";
      }

      const match_time =
        statusKey === "upcoming"
          ? m.time_text || prettyTimeFromIso(match_start) || "-"
          : prettyTimeFromIso(match_start) || m.time_text || "-";

      const finalStreamUrl = m.match_url || m.deep_stream_url;
      const match_key = keyOfTeams(match_day, m.home_team, m.away_team);
      const primaryServer1 = validateServerUrlBySlot(1, finalStreamUrl, {
        stats: isolationStats,
        reason: "extract_server1_invalid",
        matchKey: match_key,
        stage: "extract",
      });

      // Server 2 (SIIIR)
      let server2 = siiirMap.get(match_key) || null;
      if (!server2) {
        const directSiiirServer2 = [m.match_url, m.deep_stream_url]
          .map((u) => normalizeUrl(u, m.match_url || m.deep_stream_url || ""))
          .find((u) => u && /\/playerv2\.php(\?|$)/i.test(String(u)));
        if (directSiiirServer2) server2 = directSiiirServer2;
      }
      if (server2 && !/\/playerv2\.php(\?|$)/i.test(String(server2))) server2 = null;
      server2 = validateServerUrlBySlot(2, server2, {
        stats: isolationStats,
        reason: "extract_server2_invalid",
        matchKey: match_key,
        stage: "extract",
      });

      // Server 3 (LIVEHD77)
      let server3 = livehdMap.get(match_key) || null;
      if (!server3) {
        server3 = findLivehdFallbackUrl(livehdEnriched, {
          matchDay: match_day,
          homeTeam: m.home_team,
          awayTeam: m.away_team,
        });
      }
      server3 = normalizeLivehdServer3Url(server3);
      if (
        server3 &&
        (!/^https?:\/\//i.test(String(server3)) ||
          isImageUrl(String(server3)) ||
          isMediaAssetUrl(String(server3)) ||
          isAdHost(String(server3)) ||
          isAdultUrl(String(server3)) ||
          /livehd77\.pro\/(liive|matches-today|category|author|tag)\//i.test(String(server3)))
      ) {
        server3 = null;
      }
      server3 = validateServerUrlBySlot(3, server3, {
        stats: isolationStats,
        reason: "extract_server3_invalid",
        matchKey: match_key,
        stage: "extract",
      });

      // Server 4 (LIVEKORA), Server 5 (TSKORA), Server 6 (1KORA), Server 7 (reserved)
      let server4 = yalaMap.get(match_key) || yalaDirectMap.get(match_key) || null;
      if (!server4) {
        server4 =
          findYalaFallbackUrl(yalaEnriched, {
            matchDay: match_day,
            homeTeam: m.home_team,
            awayTeam: m.away_team,
          }) ||
          findYalaFallbackUrl(yalaDirectRows, {
            matchDay: match_day,
            homeTeam: m.home_team,
            awayTeam: m.away_team,
          }) ||
          null;
      }
      server4 = normalizeYalaServer4UrlForPlayback(server4);
      if (server4 && !looksLikePlayerUrl(server4)) server4 = null;
      server4 = validateServerUrlBySlot(4, server4, {
        stats: isolationStats,
        reason: "extract_server4_invalid",
        matchKey: match_key,
        stage: "extract",
      });

      const server5 = validateServerUrlBySlot(5, tskoraMap.get(match_key) || null, {
        stats: isolationStats,
        reason: "extract_server5_invalid",
        matchKey: match_key,
        stage: "extract",
      });
      const server6 = validateServerUrlBySlot(6, oneKoraMap.get(match_key) || null, {
        stats: isolationStats,
        reason: "extract_server6_invalid",
        matchKey: match_key,
        stage: "extract",
      });
      const server7 = null;

      // Strict isolation: each server keeps its own URL, no cross-server dedup
      normalizedByKey.set(match_key, {
        match_key,
        home_team: m.home_team,
        away_team: m.away_team,
        home_logo: m.home_logo,
        away_logo: m.away_logo,
        stream_url: primaryServer1,
        stream_url_2: server2,
        stream_url_3: server3,
        stream_url_4: server4,
        stream_url_5: server5,
        stream_url_6: server6,
        stream_url_7: server7,
        match_day,
        match_start: match_start || null,
        match_time,
        home_score,
        away_score,
        status_key: statusKey,
        status_text: statusTextRaw || null,
      });
    }

    const normalized = Array.from(normalizedByKey.values());
    const finalRows = normalized.filter(
      (r) =>
        r.match_key &&
        r.match_day &&
        r.home_team &&
        r.away_team &&
        (r.stream_url || r.stream_url_2 || r.stream_url_3 || r.stream_url_4 || r.stream_url_5 || r.stream_url_6)
    );

    if (!finalRows.length) {
      console.log("⚠️ لا توجد بيانات صالحة للإدخال.");
      if (DIAG) diagWrite("summary.json", JSON.stringify({ note: "no valid rows" }, null, 2));
      return;
    }

    const daysToRefresh = [matchDayFromKey("yesterday"), matchDayFromKey("today"), matchDayFromKey("tomorrow")].filter(Boolean);
    const todayDay = matchDayFromKey("today");
    const primaryServer1Degraded = usedPrimarySiiirFallback || !all.length;

    const existing = await fetchExistingForDays(daysToRefresh);
    const { mergedRows: mergedRowsRaw, droppedMatchKeys: existingCollapsedDroppedKeys = [] } = mergeWithExisting({
      newRows: finalRows,
      existingRows: existing,
      allowSiiirFallbackRows: usedPrimarySiiirFallback,
      dropPrimaryOnlyRows: primaryServer1Degraded,
      preserveFutureRows: PRESERVE_FUTURE_ROWS,
      todayDay,
      isolationStats,
    });
    let mergedRows = mergedRowsRaw.map((row) =>
      sanitizeRowBySlotContract(row, {
        stats: isolationStats,
        stage: "post_merge_pre_rpc",
        matchKey: row?.match_key || null,
      })
    );
    let droppedPrimaryOnlyRows = 0;
    if (primaryServer1Degraded) {
      const before = mergedRows.length;
      mergedRows = mergedRows.filter((row) => !isPrimaryOnlyRow(row));
      droppedPrimaryOnlyRows = before - mergedRows.length;
      if (droppedPrimaryOnlyRows > 0) {
        console.log(`🧹 dropped primary-only rows while server1 degraded: ${droppedPrimaryOnlyRows}`);
      }
    }

    if (!mergedRows.length) {
      console.log("⚠️ no rows left after primary-only cleanup.");
      if (DIAG) {
        diagWrite(
          "summary.json",
          JSON.stringify(
            {
              note: "no rows left after primary-only cleanup",
              primary_server1_degraded: primaryServer1Degraded,
              dropped_primary_only_rows: droppedPrimaryOnlyRows,
            },
            null,
            2
          )
        );
      }
      return;
    }

    // Soft dedupe: merge duplicates caused by minor team-name drift (typos/transliteration).
    // Conservative: requires same match_day + strong team match, plus kickoff proximity when available.
    const softDeduped = softDedupeMatchRows(mergedRows, { isolationStats, stage: "post_merge_soft_dedupe" });
    const softDedupDroppedKeys = Array.isArray(softDeduped.droppedMatchKeys) ? softDeduped.droppedMatchKeys : [];
    const aliasPatchStats = getTeamNameAliasPatchMetrics();
    const existingCollapseDroppedCount = Array.isArray(existingCollapsedDroppedKeys) ? existingCollapsedDroppedKeys.length : 0;
    console.log(`[merge] existing_collapse_dropped_keys: ${existingCollapseDroppedCount}`);
    console.log(`[merge] alias_patch_merges: ${aliasPatchStats.alias_patch_merges}`);
    if (softDeduped.dropped > 0) {
      console.log(`[merge] soft-deduped duplicates: ${softDeduped.dropped}`);
    }
    mergedRows = softDeduped.rows;

    const livekoraServer4Samples = collectSlotUrlSamples(mergedRows, "stream_url_4", 6);
    const livekoraLeaks = collectLivekoraLeakSamples(mergedRows, { limit: 6 });

    if (DIAG) {
      diagWrite("final_rows.json", JSON.stringify(mergedRows, null, 2));
      diagWrite(
        "summary.json",
        JSON.stringify(
          {
            ts: new Date().toISOString(),
            daysToRefresh,
            count: mergedRows.length,
            used_primary_siiir_fallback: usedPrimarySiiirFallback,
            primary_server1_degraded: primaryServer1Degraded,
            dropped_primary_only_rows: droppedPrimaryOnlyRows,
            seed_rows_count: scheduleSeedRows.length,
            seed_source_stats: scheduleSeedStats,
            seed_primary_rows_count: enriched.length,
            siiir_count: siiirEnriched.length,
            livehd_count: livehdEnriched.length,
            yala_count: yalaEnriched.length,
            tskora_count: tskoraEnriched.length,
            onekora_count: oneKoraEnriched.length,
            isolation_reject_server2: isolationStats.isolation_reject_server2,
            isolation_reject_server3: isolationStats.isolation_reject_server3,
            isolation_reject_server4: isolationStats.isolation_reject_server4,
            isolation_reject_samples: isolationStats.rejection_samples.slice(0, 12),
            alias_patch_merges: aliasPatchStats.alias_patch_merges,
            existing_collapse_dropped_keys: existingCollapseDroppedCount,
            livekora_server4_samples: livekoraServer4Samples,
            livekora_outside_server4_samples: livekoraLeaks,
          },
          null,
          2
        )
      );
    }

    console.log(`\n🔁 تحديث ذري عبر RPC: ${RPC_NAME}`);
    console.log(`📌 أيام التحديث: ${daysToRefresh.join(" , ")}`);
    console.log(`⬆️ صفوف نهائية بعد الدمج: ${mergedRows.length}`);
    console.log(`🟣 primary siiir fallback used: ${usedPrimarySiiirFallback}`);
    console.log(`🔎 primary server1 degraded: ${primaryServer1Degraded}`);
    console.log(`🧹 dropped primary-only rows: ${droppedPrimaryOnlyRows}`);
    console.log("📍 schedule seed sources:", scheduleSeedStats);
    console.log("🧱 isolation counters:", {
      isolation_reject_server2: isolationStats.isolation_reject_server2,
      isolation_reject_server3: isolationStats.isolation_reject_server3,
      isolation_reject_server4: isolationStats.isolation_reject_server4,
    });
    console.log("🧪 livekora sample in stream_url_4:", livekoraServer4Samples);
    console.log("merge patch counters:", {
      alias_patch_merges: aliasPatchStats.alias_patch_merges,
      existing_collapse_dropped_keys: existingCollapseDroppedCount,
    });
    if (livekoraLeaks.length) {
      console.warn("⚠️ livekora URL outside stream_url_4 detected:", livekoraLeaks);
    } else {
      console.log("✅ isolation check: livekora appears only in stream_url_4.");
    }
    console.log(`🗂️ جدول: ${TABLE_NAME}`);

    console.log("🧪 payload row sample:", {
      match_key: mergedRows?.[0]?.match_key,
      stream_url: mergedRows?.[0]?.stream_url,
      stream_url_2: mergedRows?.[0]?.stream_url_2,
      stream_url_3: mergedRows?.[0]?.stream_url_3,
      stream_url_4: mergedRows?.[0]?.stream_url_4,
      stream_url_5: mergedRows?.[0]?.stream_url_5,
      stream_url_6: mergedRows?.[0]?.stream_url_6,
      stream_url_7: mergedRows?.[0]?.stream_url_7,
      home_logo: mergedRows?.[0]?.home_logo,
      away_logo: mergedRows?.[0]?.away_logo,
    });


    const rpcRes = await supabase.rpc(RPC_NAME, {
      days: daysToRefresh,
      rows: mergedRows,
    });

    if (rpcRes.error) {
      console.error("❌ RPC Error:", rpcRes.error.message);
      if (DIAG) diagWrite("rpc_error.txt", rpcRes.error.message);
      return;
    }

    // Remove merged-away duplicates from DB so they don't keep showing in the UI.
    // RPC likely upserts by match_key and may not delete old keys, so we cleanup explicitly.
    const droppedKeysUniq = Array.from(
      new Set(
        [...(softDedupDroppedKeys || []), ...(existingCollapsedDroppedKeys || [])]
          .map((k) => String(k || "").trim())
          .filter(Boolean)
      )
    );
    const final_deleted_duplicate_keys = droppedKeysUniq.length;
    console.log(`[merge] final_deleted_duplicate_keys: ${final_deleted_duplicate_keys}`);
    if (droppedKeysUniq.length) {
      if (droppedKeysUniq.length > 120) {
        console.warn(`[merge] too many dropped keys (${droppedKeysUniq.length}); skipping delete to be safe.`);
        if (DIAG) {
          diagWrite(
            `post_rpc/soft_dedupe_dropped_keys_${Date.now()}.json`,
            JSON.stringify(droppedKeysUniq.slice(0, 200), null, 2)
          );
        }
      } else {
        const delRes = await supabase.from(TABLE_NAME).delete().in("match_key", droppedKeysUniq);
        if (delRes.error) {
          console.warn("[merge] failed to delete soft-deduped keys:", delRes.error.message);
          if (DIAG) diagWrite(`post_rpc/soft_dedupe_delete_error_${Date.now()}.txt`, delRes.error.message + "\n");
        } else {
          console.log(`[merge] deleted merged-duplicate rows: ${droppedKeysUniq.length}`);
        }
      }
    }

    const postRpc = await backfillDynamicMatchFields(mergedRows);
    if (postRpc.fail > 0) {
      console.error(`⚠️ post-RPC backfill partial: ok=${postRpc.ok}, fail=${postRpc.fail}`);
    } else {
      console.log(`🩹 post-RPC backfill: ${postRpc.ok} row(s) updated.`);
    }

    const cleanup = await cleanupOldFinishedRows({ olderThanDay: matchDayFromKey("yesterday") });
    if (!cleanup.skipped && !cleanup.error) {
      console.log(`🧽 cleanup old finished rows (< yesterday): ${cleanup.deleted}`);
    }

    console.log("✅ تم التحديث بنجاح (Server2..Server6 مفعلة، Server7 محجوز لحين تحديد المصدر).");
  } catch (err) {
    console.error("❌ فشل السكرابر:", err.message);
    if (DIAG) diagWrite("fatal_error.txt", String(err?.stack || err?.message || err));
    try {
      await page.screenshot({ path: "debug.png", fullPage: true });
      console.log("🧩 تم حفظ debug.png لفحص الصفحة.");
    } catch { }
  } finally {
    try {
      await page.close();
      await listContext.close();
    } catch { }
    await browser.close();
  }
}

startScraping();






