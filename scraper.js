// scraper.js
/**
 * Unified Scraper (Yesterday / Today / Tomorrow) + Deep Stream Link Extractor
 *
 * Permanent GitHub-safe fixes:
 * 1) Run-safe diagnostics (DIAG=1 always creates ./diag with a touch file).
 * 2) Strong LIVE detection (Arabic/English + DOM hints + score inference).
 * 3) If match inferred LIVE but listed time is future => fix match_start to now-30m.
 * 4) Merge guardrails use canonical, order-insensitive key to preserve live rows.
 * 5) ✅ NEW: On GitHub, list page may miss live status/score. We now extract status/score
 *          from the match page while doing deep extraction and use it as an override.
 * 6) ✅ NEW: Wait briefly for live bits on list page (polling) before evaluating.
 *
 * ENV:
 *  - SUPABASE_URL, SUPABASE_KEY (required)
 *  - TABLE_NAME (default: "match-stream-app")
 *  - RPC_NAME (default: "refresh_match_stream_app")
 *  - HEADLESS (default: 1)
 *  - DEBUG (default: 0)
 *  - DIAG (default: 0)   => when 1 writes ./diag/*
 *  - CONCURRENCY (default: 2)
 */

const { chromium } = require("playwright");
const { createClient } = require("@supabase/supabase-js");
const fs = require("fs");
const path = require("path");
require("dotenv").config({ path: ".env.local" });

// ===================== ENV =====================
const supabaseUrl = process.env.SUPABASE_URL;
const supabaseKey = process.env.SUPABASE_KEY;

const TABLE_NAME = process.env.TABLE_NAME || "match-stream-app";
const RPC_NAME = process.env.RPC_NAME || "refresh_match_stream_app";
const HEADLESS = (process.env.HEADLESS ?? "1") !== "0";
const DEBUG = (process.env.DEBUG ?? "0") === "1";
const DIAG = (process.env.DIAG ?? "0") === "1";
const CONCURRENCY = Math.max(1, parseInt(process.env.CONCURRENCY || "2", 10) || 2);

const LIST_TIMEOUT_MS = 60000;
const DEEP_TIMEOUT_MS = 45000;

const TZ = "Africa/Cairo";

const DAYS = [
  { key: "yesterday", url: "https://www.bein-live.com/matches-yesterday/" },
  { key: "today", url: "https://www.bein-live.com/matches-today_1/" },
  { key: "tomorrow", url: "https://www.bein-live.com/matches-tomorrow/" },
];

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

// ===================== Diagnostics Helpers =====================
function dbg(...args) {
  if (DEBUG) console.log(...args);
}

function ensureDir(p) {
  try {
    fs.mkdirSync(p, { recursive: true });
  } catch {}
}

function diagRoot() {
  return path.join(process.cwd(), "diag");
}

// IMPORTANT: always create a file when DIAG=1 so artifact is never empty.
function diagTouch() {
  if (!DIAG) return;
  try {
    const dir = diagRoot();
    ensureDir(dir);
    fs.writeFileSync(
      path.join(dir, "_touch.txt"),
      `ok ${new Date().toISOString()} headless=${HEADLESS} node=${process.version}\n`
    );
  } catch {}
}

function diagWrite(rel, content) {
  if (!DIAG) return;
  try {
    const dir = diagRoot();
    ensureDir(dir);
    const full = path.join(dir, rel);
    ensureDir(path.dirname(full));
    fs.writeFileSync(full, content ?? "");
  } catch {}
}

async function diagShot(page, rel) {
  if (!DIAG) return;
  try {
    const dir = diagRoot();
    ensureDir(dir);
    const full = path.join(dir, rel);
    ensureDir(path.dirname(full));
    await page.screenshot({ path: full, fullPage: true });
  } catch {}
}

// Create diag marker as early as possible
diagTouch();

if (!supabaseUrl || !supabaseKey) {
  console.error("❌ Missing SUPABASE_URL or SUPABASE_KEY in environment.");
  process.exit(1);
}

const supabase = createClient(supabaseUrl, supabaseKey);

// ===================== URL Helpers =====================
function isJunkCandidateUrl(url) {
  if (!url) return true;
  const u = String(url).toLowerCase();
  return (
    /\.(css|js|png|jpg|jpeg|gif|svg|woff|woff2|ttf|eot|ico|json)(\?.*)?$/.test(u) ||
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

// --- Stealth-ish init ---
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
    } catch {}
  });
}

async function applyAntiAds(context, page) {
  if (page.__antiAdsApplied) return;
  page.__antiAdsApplied = true;

  await applyStealth(page);

  page.on("dialog", async (d) => {
    try {
      await d.dismiss();
    } catch {}
  });

  await page.addInitScript((adHosts) => {
    try {
      const isBad = (host) => adHosts.some((h) => host === h || host.endsWith("." + h));

      const origOpen = window.open.bind(window);
      window.open = function (url, name, features) {
        try {
          if (url) {
            const abs = new URL(String(url), location.href);
            const host = abs.hostname.toLowerCase();
            if (isBad(host)) return null;
          }
        } catch {}
        return origOpen(url, name, features);
      };

      window.alert = () => {};
      window.confirm = () => false;
      window.prompt = () => null;

      Object.defineProperty(window, "onbeforeunload", {
        get() {
          return null;
        },
        set() {},
      });
    } catch {}
  }, AD_HOSTS);

  await page.route("**/*", (route) => {
    const req = route.request();
    const url = req.url();
    const type = req.resourceType();

    if (isAdHost(url)) return route.abort();
    if (["image", "font"].includes(type)) return route.abort();

    return route.continue();
  });
}

// ===================== Time / Parse Helpers =====================
function normalizeDigits(input) {
  if (input === null || input === undefined) return "";
  const s = String(input);
  const map = {
    "٠": "0","١": "1","٢": "2","٣": "3","٤": "4",
    "٥": "5","٦": "6","٧": "7","٨": "8","٩": "9",
    "۰": "0","۱": "1","۲": "2","۳": "3","۴": "4",
    "۵": "5","۶": "6","۷": "7","۸": "8","۹": "9",
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

function hmInTimeZone(date, timeZone) {
  const parts = new Intl.DateTimeFormat("en", {
    timeZone,
    hour: "2-digit",
    minute: "2-digit",
    hour12: false,
  }).formatToParts(date);

  const hh = parts.find((p) => p.type === "hour")?.value;
  const mm = parts.find((p) => p.type === "minute")?.value;
  if (!hh || !mm) return null;
  return { hh, mm };
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

function parseScore(raw) {
  if (raw === null || raw === undefined) return null;
  const s = normalizeDigits(String(raw)).trim();
  if (!s) return null;
  const digits = s.replace(/[^\d]/g, "");
  if (!digits) return null;
  const n = parseInt(digits, 10);
  return Number.isFinite(n) ? n : null;
}

function cairoOffsetForDay(matchDayYmd) {
  try {
    const noonUtc = new Date(`${matchDayYmd}T12:00:00Z`);
    const parts = new Intl.DateTimeFormat("en-US", {
      timeZone: TZ,
      timeZoneName: "shortOffset",
      hour: "2-digit",
      minute: "2-digit",
    }).formatToParts(noonUtc);

    const tzPart = parts.find((p) => p.type === "timeZoneName")?.value || "";
    const m = tzPart.match(/GMT([+-])(\d{1,2})(?::?(\d{2}))?/i);
    if (!m) return "+02:00";

    const sign = m[1];
    const hh = String(m[2]).padStart(2, "0");
    const mm = String(m[3] || "00").padStart(2, "0");
    return `${sign}${hh}:${mm}`;
  } catch {
    return "+02:00";
  }
}

function isoFromMatchDayAndTimeText(matchDayYmd, timeTextRaw) {
  if (!matchDayYmd || !timeTextRaw) return null;

  const t0 = normalizeDigits(String(timeTextRaw))
    .replace(/\u200f|\u200e/g, "")
    .trim();
  if (!t0) return null;

  const t = t0.toLowerCase();
  const m = t.match(/(\d{1,2})\s*[:٫.]\s*(\d{2})/);
  if (!m) return null;

  let hh = parseInt(m[1], 10);
  const mm = parseInt(m[2], 10);
  if (!Number.isFinite(hh) || !Number.isFinite(mm)) return null;

  const isPM = t.includes("pm") || t.includes("م") || t.includes("مس") || t.includes("مساء");
  const isAM = t.includes("am") || t.includes("ص") || t.includes("صب") || t.includes("صباح");

  if (isPM && hh < 12) hh += 12;
  if (isAM && hh === 12) hh = 0;

  if (hh < 0 || hh > 23 || mm < 0 || mm > 59) return null;

  const offset = cairoOffsetForDay(matchDayYmd);
  const HH = String(hh).padStart(2, "0");
  const MM = String(mm).padStart(2, "0");
  return `${matchDayYmd}T${HH}:${MM}:00${offset}`;
}

function isoFromDateInCairo(date) {
  const ymd = ymdInTimeZone(date, TZ);
  const hm = hmInTimeZone(date, TZ);
  if (!ymd || !hm) return null;
  const offset = cairoOffsetForDay(ymd);
  return `${ymd}T${hm.hh}:${hm.mm}:00${offset}`;
}

function statusKeyFromText(statusText) {
  const s0 = String(statusText || "").trim();
  if (!s0) return "unknown";
  const s = s0.toLowerCase();

  if (s0.includes("جارية") || s0.includes("مباشر") || s0.includes("الآن")) return "live";
  if (s0.includes("انتهت") || s0.includes("انتهى") || s0.includes("نهاية")) return "finished";

  if (/\blive\b|\bnow\b|in progress|kick ?off/i.test(s)) return "live";
  if (/\bft\b|full ?time|\bended\b|\bfinished\b|\bfinal\b/i.test(s)) return "finished";

  return "upcoming";
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
  } catch {}
  return /^https?:\/\//i.test(u) ? u : null;
}

function scoreCandidate(u) {
  if (!u) return -99999;
  const s = u.toLowerCase();

  if (isJunkCandidateUrl(s)) return -99999;
  if (s === "about:blank") return -9999;
  if (isAdHost(s) || s.includes("googleads") || s.includes("doubleclick")) return -5000;
  if (BOT_HINTS.some((h) => s.includes(h))) return -4000;

  let score = 0;
  if (s.includes("albaplayer")) score += 250;
  if (s.includes("kora-live")) score += 200;
  if (s.includes("m3u8")) score += 300;
  if (s.includes("embed")) score += 80;
  if (s.includes("player")) score += 60;
  if (s.includes("iframe")) score += 40;
  if (s.includes("live")) score += 20;

  if (s.includes("bein-live.com") && s.includes("match")) score -= 120;

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
    const count = await page.locator(".AY_Match").count().catch(() => 0);

    if (count > 0 && count === last) stableFor += 400;
    else stableFor = 0;

    last = count;
    if (count > 0 && stableFor >= settleMs) return count;

    await page.waitForTimeout(400);
  }
  return last;
}

// ✅ NEW: wait for scores/status to appear (GitHub often slower / delayed)
async function waitForLiveBits(page, maxWaitMs = 9000) {
  const start = Date.now();
  while (Date.now() - start < maxWaitMs) {
    const ok = await page
      .evaluate(() => {
        const root = document.body;
        if (!root) return false;
        const matches = Array.from(document.querySelectorAll(".AY_Match")).slice(0, 30);
        if (!matches.length) return false;

        const kw = ["جارية", "مباشر", "الآن", "انتهت", "انتهى", "LIVE", "FT", "Finished", "Ended"];
        const hasGoals = !!document.querySelector(".AY_Match .RS-goals");
        if (hasGoals) return true;

        for (const m of matches) {
          const t = (m.textContent || "").trim();
          if (!t) continue;
          for (const k of kw) {
            if (t.toLowerCase().includes(String(k).toLowerCase())) return true;
          }
        }
        return false;
      })
      .catch(() => false);

    if (ok) return true;
    await page.waitForTimeout(450);
  }
  return false;
}

// ===================== Scrape List =====================
async function scrapeOneDay(page, dayKey, url) {
  console.log(`\n🔎 سحب: ${dayKey} => ${url}`);

  if (DIAG) diagWrite(`list/${dayKey}.url.txt`, url + "\n");

  await page.goto(url, { waitUntil: "domcontentloaded", timeout: LIST_TIMEOUT_MS });
  await page.waitForSelector(".AY_Match, .no-data__msg, body", { timeout: 30000 });

  await page.waitForTimeout(900);
  const stableCount = await waitForStableMatchCount(page, 20000, 1400);
  dbg(`   📌 Stable match count: ${stableCount}`);

  try {
    await page.mouse.wheel(0, 1400);
    await page.waitForTimeout(700);
  } catch {}

  // ✅ NEW: extra wait for delayed live bits
  await waitForLiveBits(page, 9000);

  await diagShot(page, `list/${dayKey}.png`);
  if (DIAG) {
    try {
      const html = await page.content();
      diagWrite(`list/${dayKey}.html`, html.slice(0, 350000));
    } catch {}
  }

  try {
    const bodyText = await page.evaluate(() => (document.body?.innerText || "").slice(0, 4000));
    const lower = (bodyText || "").toLowerCase();
    if (BOT_HINTS.some((h) => lower.includes(h))) {
      console.error("⚠️ BOT/Challenge hints detected on list page (runner may be blocked).");
      if (DIAG) diagWrite(`list/${dayKey}.body.txt`, bodyText);
    }
  } catch {}

  const rows = await page.evaluate(() => {
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

    const findStatusText = (match) => {
      const direct = pickText(match, [
        ".MT_Status",
        ".match-status",
        ".MatchStatus",
        ".RS-status",
        ".status",
        ".State",
        ".state",
        ".live",
        ".finished",
        ".ended",
      ]);
      if (direct) return direct;

      const keywords = ["جارية", "الآن", "مباشر", "انتهت", "انتهى", "نهاية", "LIVE", "FT", "Finished", "Ended"];
      const nodes = Array.from(match.querySelectorAll("span,div,button,strong,em"));
      for (const n of nodes) {
        const t = (n.textContent || "").trim();
        if (!t) continue;
        if (t.length > 40) continue;
        const tl = t.toLowerCase();
        if (keywords.some((k) => tl.includes(String(k).toLowerCase()))) return t;
      }
      return "";
    };

    const findStatusHint = (match) => {
      const hasLive =
        !!match.querySelector(".live, .is-live, .Live, [class*='live'], [class*='Live']") ||
        !!match.querySelector("[data-status*='live'], [aria-label*='live'], [title*='live']");

      const hasFinished =
        !!match.querySelector(".finished, .ended, .Finished, [class*='finish'], [class*='end']") ||
        !!match.querySelector("[data-status*='finish'], [data-status*='end']");

      if (hasLive) return "live";
      if (hasFinished) return "finished";
      return "";
    };

    const findScorePair = (match) => {
      const goals = Array.from(match.querySelectorAll(".RS-goals")).map((g) => (g.textContent || "").trim());
      if (goals.length >= 2 && (goals[0] || goals[1])) {
        return { home: goals[0] || null, away: goals[1] || null, hasAny: true };
      }

      const scoreText = pickText(match, [
        ".RS-score",
        ".RS-Score",
        ".MT_Score",
        ".MatchScore",
        ".match-score",
        ".score",
        "[class*='score']",
        "[class*='Score']",
      ]);

      const m1 = scoreText.match(/(\d+)\s*[-:]\s*(\d+)/);
      if (m1) return { home: m1[1], away: m1[2], hasAny: true };

      const allText = (match.textContent || "").replace(/\s+/g, " ").trim();
      const m2 = allText.match(/(\d+)\s*[-:]\s*(\d+)/);
      if (m2) return { home: m2[1], away: m2[2], hasAny: true };

      return { home: null, away: null, hasAny: false };
    };

    const matches = Array.from(document.querySelectorAll(".AY_Match"));

    return matches
      .map((match) => {
        const teams = Array.from(match.querySelectorAll(".TM_Name")).map((e) => (e.textContent || "").trim());

        const imgs = Array.from(match.querySelectorAll(".TM_Logo img"));
        const a = match.querySelector("a[href]");

        const dataStart = (match.getAttribute("data-start") || "").trim();
        const timeText = pickText(match, [".MT_Time", ".TM_Time", ".match-time", ".MatchTime", ".AY_Time"]);

        const statusText = findStatusText(match);
        const statusHint = findStatusHint(match);
        const scorePair = findScorePair(match);

        const matchUrl = toAbs(a?.getAttribute("href") || "");

        return {
          home_team: teams[0] || "",
          away_team: teams[1] || "",
          data_start: dataStart || null,
          time_text: timeText || null,
          status_text: statusText || null,
          status_hint: statusHint || null,
          has_score_hint: !!scorePair.hasAny,
          home_logo: toAbs(pickLogo(imgs[0])),
          away_logo: toAbs(pickLogo(imgs[1])),
          match_url: matchUrl || null,
          home_score_raw: scorePair.home,
          away_score_raw: scorePair.away,
        };
      })
      .filter((m) => m.home_team && m.away_team && m.match_url);
  });

  console.log(`📦 ${dayKey}: ${rows.length} مباراة`);

  if (DIAG) diagWrite(`rows/raw_${dayKey}.json`, JSON.stringify(rows, null, 2));

  return rows;
}

// ===================== Deep Match Details =====================
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

      const findStatusText = (root) => {
        const direct = pickText(root, [
          ".MT_Status",
          ".match-status",
          ".MatchStatus",
          ".RS-status",
          ".status",
          ".State",
          ".state",
          ".live",
          ".finished",
          ".ended",
        ]);
        if (direct) return direct;

        const keywords = ["جارية", "الآن", "مباشر", "انتهت", "انتهى", "نهاية", "LIVE", "FT", "Finished", "Ended"];
        const nodes = Array.from(root.querySelectorAll("span,div,button,strong,em,i,b"));
        for (const n of nodes) {
          const t = (n.textContent || "").trim();
          if (!t) continue;
          if (t.length > 50) continue;
          const tl = t.toLowerCase();
          if (keywords.some((k) => tl.includes(String(k).toLowerCase()))) return t;
        }

        const ttl = (document.title || "").trim();
        if (keywords.some((k) => ttl.toLowerCase().includes(String(k).toLowerCase()))) return ttl;

        return "";
      };

      const findStatusHint = (root) => {
        const hasLive =
          !!root.querySelector(".live, .is-live, .Live, [class*='live'], [class*='Live']") ||
          !!root.querySelector("[data-status*='live'], [aria-label*='live'], [title*='live']");

        const hasFinished =
          !!root.querySelector(".finished, .ended, .Finished, [class*='finish'], [class*='end']") ||
          !!root.querySelector("[data-status*='finish'], [data-status*='end']");

        if (hasLive) return "live";
        if (hasFinished) return "finished";
        return "";
      };

      const findScorePair = (root) => {
        const goals = Array.from(root.querySelectorAll(".RS-goals")).map((g) => (g.textContent || "").trim());
        if (goals.length >= 2 && (goals[0] || goals[1])) {
          return { home: goals[0] || null, away: goals[1] || null, hasAny: true };
        }

        const scoreText = pickText(root, [
          ".RS-score",
          ".RS-Score",
          ".MT_Score",
          ".MatchScore",
          ".match-score",
          ".score",
          "[class*='score']",
          "[class*='Score']",
          "[class*='goals']",
          "[class*='Goals']",
        ]);

        const m1 = scoreText.match(/(\d+)\s*[-:]\s*(\d+)/);
        if (m1) return { home: m1[1], away: m1[2], hasAny: true };

        const ttl = (document.title || "").replace(/\s+/g, " ").trim();
        const m2 = ttl.match(/(\d+)\s*[-:]\s*(\d+)/);
        if (m2) return { home: m2[1], away: m2[2], hasAny: true };

        const bodyText = (root.textContent || "").replace(/\s+/g, " ").trim();
        const m3 = bodyText.match(/(\d+)\s*[-:]\s*(\d+)/);
        if (m3) return { home: m3[1], away: m3[2], hasAny: true };

        return { home: null, away: null, hasAny: false };
      };

      const root = document.body || document.documentElement;
      const statusText = findStatusText(root);
      const statusHint = findStatusHint(root);
      const scorePair = findScorePair(root);

      return {
        status_text: statusText || null,
        status_hint: statusHint || null,
        home_score_raw: scorePair.home,
        away_score_raw: scorePair.away,
        has_score_hint: !!scorePair.hasAny,
      };
    })
    .catch(() => ({
      status_text: null,
      status_hint: null,
      home_score_raw: null,
      away_score_raw: null,
      has_score_hint: false,
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
    } catch {}
  };

  const onPopup = async (p) => {
    try {
      await p.waitForLoadState("domcontentloaded", { timeout: 3000 }).catch(() => {});
      const u = p.url();
      if (u) candidates.add(u);
    } catch {}
    try {
      await p.close();
    } catch {}
  };

  const onCtxPage = async (p) => {
    if (p === page) return;
    try {
      await p.waitForLoadState("domcontentloaded", { timeout: 3000 }).catch(() => {});
      const u = p.url();
      if (u) candidates.add(u);
    } catch {}
    try {
      await p.close();
    } catch {}
  };

  page.on("request", onReq);
  page.on("popup", onPopup);
  ctx.on("page", onCtxPage);

  try {
    await page.goto(matchUrl, { waitUntil: "domcontentloaded", timeout: DEEP_TIMEOUT_MS });
    await page.waitForTimeout(1700);

    // First meta pass
    let meta = await extractMatchMetaFromDom(page);

    // Try to trigger server/embed (often needed to reveal iframes/urls)
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
    } catch {}

    // Collect URLs from DOM
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
    } catch {}

    // Second meta pass (after potential JS updates)
    await page.waitForTimeout(1200);
    const meta2 = await extractMatchMetaFromDom(page);
    meta = {
      status_text: meta2.status_text || meta.status_text,
      status_hint: meta2.status_hint || meta.status_hint,
      home_score_raw: meta2.home_score_raw ?? meta.home_score_raw,
      away_score_raw: meta2.away_score_raw ?? meta.away_score_raw,
      has_score_hint: meta2.has_score_hint || meta.has_score_hint,
    };

    const cleanUrls = Array.from(candidates)
      .map((u) => normalizeUrl(u, matchUrl))
      .filter((u) => u && !isJunkCandidateUrl(u) && !isAdHost(u) && u !== matchUrl);

    const best = pickBestUrl(cleanUrls);
    dbg(`   🎯 Best Link for ${matchUrl}: ${best || "None"}`);

    return {
      deep_stream_url: best || null,
      deep_status_text: meta.status_text || null,
      deep_status_hint: meta.status_hint || null,
      deep_home_score_raw: meta.home_score_raw ?? null,
      deep_away_score_raw: meta.away_score_raw ?? null,
      deep_has_score_hint: !!meta.has_score_hint,
    };
  } catch (e) {
    dbg(`   ⚠️ Deep error: ${e.message}`);
    return { deep_stream_url: null };
  } finally {
    try {
      page.off("request", onReq);
    } catch {}
    try {
      page.off("popup", onPopup);
    } catch {}
    try {
      ctx.off("page", onCtxPage);
    } catch {}
  }
}

// ===================== Worker pool =====================
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
      extraHTTPHeaders: {
        "Accept-Language": "ar-EG,ar;q=0.9,en-US;q=0.8,en;q=0.7",
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
function canonTeamName(v) {
  let s = normalizeDigits(String(v || "")).trim();
  s = s.replace(/[\u064B-\u0652\u0670\u0640]/g, "");
  s = s
    .replace(/[إأآ]/g, "ا")
    .replace(/ى/g, "ي")
    .replace(/ة/g, "ه")
    .replace(/ؤ/g, "و")
    .replace(/ئ/g, "ي");
  s = s.replace(/[^\p{L}\p{N}]+/gu, "");
  return s.toLowerCase();
}

function keyOfRow(r) {
  const day = String(r.match_day || "").toLowerCase();
  const a = canonTeamName(r.home_team);
  const b = canonTeamName(r.away_team);
  const pair = [a, b].sort().join("__");
  return `${day}||${pair}`;
}

function parseMs(iso) {
  if (!iso) return null;
  const d = new Date(iso);
  const t = d.getTime();
  return Number.isFinite(t) ? t : null;
}

// likely live = started within last 6 hours (or starting within next 15 minutes)
function isLikelyLiveRow(r, nowMs) {
  const t = parseMs(r.match_start);
  if (!t) return false;
  const fifteenMin = 15 * 60 * 1000;
  const sixH = 6 * 60 * 60 * 1000;
  return t <= nowMs + fifteenMin && t >= nowMs - sixH;
}

function isWeakStreamUrl(u) {
  if (!u) return true;
  const s = String(u).toLowerCase();
  if (s.includes("bein-live.com") && s.includes("match")) return true;
  const goodHints = ["m3u8", "embed", "player", "iframe", "albaplayer", "kora-live"];
  return !goodHints.some((h) => s.includes(h));
}

async function fetchExistingForDays(days) {
  const { data, error } = await supabase
    .from(TABLE_NAME)
    .select("home_team,away_team,home_logo,away_logo,stream_url,match_day,match_start,match_time,home_score,away_score")
    .in("match_day", days);

  if (error) {
    console.error("⚠️ Could not read existing rows for merge:", error.message);
    return [];
  }
  return Array.isArray(data) ? data : [];
}

function mergeWithExisting({ newRows, existingRows }) {
  const nowMs = Date.now();

  const existingMap = new Map();
  for (const r of existingRows) existingMap.set(keyOfRow(r), r);

  const mergedMap = new Map();

  let preservedMissingLive = 0;
  let preservedLiveOverride = 0;

  for (const r of newRows) {
    const k = keyOfRow(r);
    const old = existingMap.get(k);

    let out = { ...r };

    if (old) {
      if (isWeakStreamUrl(out.stream_url) && !isWeakStreamUrl(old.stream_url)) {
        out.stream_url = old.stream_url;
      }

      const oldLikelyLive = isLikelyLiveRow(old, nowMs);
      const newT = parseMs(out.match_start);

      if (oldLikelyLive && newT && newT > nowMs + 30 * 60 * 1000) {
        out.match_start = old.match_start;
        out.match_time = old.match_time || out.match_time;
        preservedLiveOverride++;
      }

      if ((!out.match_start || !parseMs(out.match_start)) && old.match_start) {
        out.match_start = old.match_start;
        out.match_time = old.match_time || out.match_time;
      }
    }

    mergedMap.set(k, out);
  }

  for (const old of existingRows) {
    const k = keyOfRow(old);
    if (mergedMap.has(k)) continue;

    if (isLikelyLiveRow(old, nowMs)) {
      mergedMap.set(k, old);
      preservedMissingLive++;
    }
  }

  return { mergedRows: Array.from(mergedMap.values()), preservedMissingLive, preservedLiveOverride };
}

// ===================== Main =====================
async function startScraping() {
  console.log("🚀 بدء السكرابر (أمس/اليوم/غد) + استخراج رابط البث ...");

  diagTouch();
  if (DIAG) {
    diagWrite(
      "meta.json",
      JSON.stringify(
        {
          ts: new Date().toISOString(),
          headless: HEADLESS,
          node: process.version,
          concurrency: CONCURRENCY,
          tz: TZ,
        },
        null,
        2
      )
    );
  }

  const browser = await chromium.launch({
    headless: HEADLESS,
    args: ["--disable-blink-features=AutomationControlled", "--no-sandbox", "--disable-dev-shm-usage"],
  });

  const listContext = await browser.newContext({
    locale: "ar-EG",
    timezoneId: TZ,
    serviceWorkers: "block",
    extraHTTPHeaders: {
      "Accept-Language": "ar-EG,ar;q=0.9,en-US;q=0.8,en;q=0.7",
    },
    userAgent:
      "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/121.0.0.0 Safari/537.36",
    viewport: { width: 1280, height: 720 },
  });

  const page = await listContext.newPage();
  await applyAntiAds(listContext, page);

  try {
    const all = [];
    for (const d of DAYS) {
      try {
        const rows = await scrapeOneDay(page, d.key, d.url);
        all.push(...rows.map((r) => ({ ...r, _day_key: d.key })));
      } catch (e) {
        console.error(`⚠️ فشل سحب ${d.key}:`, e.message);
        if (DIAG) diagWrite(`errors/${d.key}.txt`, String(e?.stack || e?.message || e));
      }
    }

    if (!all.length) {
      console.log("⚠️ لم يتم العثور على مباريات.");
      if (DIAG) diagWrite("summary.json", JSON.stringify({ note: "no matches found" }, null, 2));
      return;
    }

    const enriched = await enrichWithDeepLinks(browser, all);

    const normalized = enriched.map((m) => {
      const isoFromAttr = toIsoFromDataStart(m.data_start);
      const match_day = cairoDayFromIso(isoFromAttr) || matchDayFromKey(m._day_key);

      const isoFromVisibleTime = isoFromMatchDayAndTimeText(match_day, m.time_text);

      let match_start =
        m._day_key === "today" && isoFromVisibleTime
          ? isoFromVisibleTime
          : isoFromAttr || isoFromVisibleTime || null;

      // ✅ Override status/score from deep (match page) when available
      const statusTextRaw = m.deep_status_text || m.status_text;
      const statusHintRaw = m.deep_status_hint || m.status_hint;

      const homeScoreRaw = m.deep_home_score_raw ?? m.home_score_raw;
      const awayScoreRaw = m.deep_away_score_raw ?? m.away_score_raw;
      const hasScoreHintRaw = !!(m.deep_has_score_hint || m.has_score_hint);

      const home_score = parseScore(homeScoreRaw);
      const away_score = parseScore(awayScoreRaw);

      const hasAnyScore = (home_score !== null || away_score !== null) || hasScoreHintRaw;

      const textKey = statusKeyFromText(statusTextRaw);
      const hintKey = statusKeyFromText(statusHintRaw);
      let statusKey = textKey !== "unknown" ? textKey : hintKey;

      const now = new Date();
      const nowMs = now.getTime();
      const startDate = match_start ? new Date(match_start) : null;
      const startMs = startDate && !Number.isNaN(startDate.getTime()) ? startDate.getTime() : null;

      // If we have any score hints TODAY and time is far in the future => treat as LIVE
      if (m._day_key === "today" && hasAnyScore && startMs && startMs > nowMs + 10 * 60 * 1000) {
        statusKey = "live";
      }

      if (statusKey === "live") {
        const bad = !startMs || startMs > nowMs + 5 * 60 * 1000;
        if (bad) {
          const fix = new Date(nowMs - 30 * 60 * 1000);
          match_start = isoFromDateInCairo(fix) || match_start;
        }
      }

      if (statusKey === "finished") {
        const bad = !startMs || startMs > nowMs;
        if (bad) {
          const fix = new Date(nowMs - 3 * 60 * 60 * 1000);
          match_start = isoFromDateInCairo(fix) || match_start;
        }
      }

      const match_time = match_start ? prettyTimeFromIso(match_start) : m.time_text || "—";
      const finalStreamUrl = m.deep_stream_url || m.match_url;

      return {
        home_team: m.home_team,
        away_team: m.away_team,
        home_logo: m.home_logo,
        away_logo: m.away_logo,
        stream_url: finalStreamUrl,
        match_day,
        match_start: match_start || null,
        match_time,
        home_score,
        away_score,
      };
    });

    const finalRows = normalized.filter((r) => r.match_day && r.home_team && r.away_team && r.stream_url);

    if (!finalRows.length) {
      console.log("⚠️ لا توجد بيانات صالحة للإدخال.");
      if (DIAG) diagWrite("summary.json", JSON.stringify({ note: "no valid rows" }, null, 2));
      return;
    }

    const daysToRefresh = [
      matchDayFromKey("yesterday"),
      matchDayFromKey("today"),
      matchDayFromKey("tomorrow"),
    ].filter(Boolean);

    const existing = await fetchExistingForDays(daysToRefresh);
    const { mergedRows, preservedMissingLive, preservedLiveOverride } = mergeWithExisting({
      newRows: finalRows,
      existingRows: existing,
    });

    const weakCount = mergedRows.filter((r) => isWeakStreamUrl(r.stream_url)).length;

    const nowMs = Date.now();
    const oldLive = existing.filter((r) => isLikelyLiveRow(r, nowMs)).length;
    const newLive = mergedRows.filter((r) => isLikelyLiveRow(r, nowMs)).length;

    if (oldLive > 0 && newLive === 0) {
      console.error(`❌ Guardrail triggered: live rows dropped to 0 (oldLive=${oldLive}). Skip update.`);
      if (DIAG) diagWrite("guardrail_live_drop.json", JSON.stringify({ oldLive, newLive }, null, 2));
      return;
    }

    const todayKey = matchDayFromKey("today");
    const oldToday = existing.filter((r) => r.match_day === todayKey).length;
    const newToday = mergedRows.filter((r) => r.match_day === todayKey).length;

    if (oldToday >= 6 && newToday < Math.floor(oldToday * 0.5)) {
      console.error(`❌ Guardrail triggered: today rows dropped too much (old=${oldToday}, new=${newToday}). Skip update.`);
      if (DIAG) diagWrite("guardrail_today_drop.json", JSON.stringify({ oldToday, newToday }, null, 2));
      return;
    }

    if (DIAG) {
      diagWrite("final_rows.json", JSON.stringify(mergedRows, null, 2));
      diagWrite(
        "summary.json",
        JSON.stringify(
          {
            ts: new Date().toISOString(),
            daysToRefresh,
            counts: {
              oldToday,
              newToday,
              oldLive,
              newLive,
              weakCount,
              preservedMissingLive,
              preservedLiveOverride,
            },
          },
          null,
          2
        )
      );
    }

    console.log(
      `\n🧠 Merge Guardrails: preserved_missing_live=${preservedMissingLive}, preserved_live_time_override=${preservedLiveOverride}, weak_stream_urls_after_merge=${weakCount}`
    );
    console.log(`\n🔁 تحديث ذري عبر RPC: ${RPC_NAME}`);
    console.log(`📌 أيام التحديث: ${daysToRefresh.join(" , ")}`);
    console.log(`⬆️ صفوف نهائية بعد الدمج: ${mergedRows.length}`);
    console.log(`🗂️ جدول: ${TABLE_NAME}`);

    const rpcRes = await supabase.rpc(RPC_NAME, {
      days: daysToRefresh,
      rows: mergedRows,
    });

    if (rpcRes.error) {
      console.error("❌ RPC Error:", rpcRes.error.message);
      if (DIAG) diagWrite("rpc_error.txt", rpcRes.error.message);
      return;
    }

    console.log("✅ تم التحديث بنجاح (GitHub-safe).");
  } catch (err) {
    console.error("❌ فشل السكرابر:", err.message);
    if (DIAG) diagWrite("fatal_error.txt", String(err?.stack || err?.message || err));
    try {
      await page.screenshot({ path: "debug.png", fullPage: true });
      console.log("🧩 تم حفظ debug.png لفحص الصفحة.");
    } catch {}
  } finally {
    try {
      await page.close();
      await listContext.close();
    } catch {}
    await browser.close();
  }
}

startScraping();
