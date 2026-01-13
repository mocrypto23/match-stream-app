// scraper.js
/**
  * Unified Scraper (Yesterday / Today / Tomorrow) + Deep Stream Link Extractor
 * + SIIIR.TV (Server 2) extractor
 *
 * Adds:
 * - stream_url_2..5 support (currently fills stream_url_2 from siiir.tv)
 *
 * ENV:
 *  - SUPABASE_URL, SUPABASE_KEY (required)
 *  - TABLE_NAME (default: "match-stream-app")
 *  - RPC_NAME (default: "refresh_match_stream_app")
 *  - HEADLESS (default: 1)
 *  - DEBUG (default: 0)
 *  - DIAG (default: 0)
 *  - CONCURRENCY (default: 2)
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

const LIST_TIMEOUT_MS = 60000;
const DEEP_TIMEOUT_MS = 45000;

const TZ = "Africa/Cairo";

const DAYS = [
  { key: "yesterday", url: "https://www.bein-live.com/matches-yesterday/" },
  { key: "today", url: "https://www.bein-live.com/matches-today_1/" },
  { key: "tomorrow", url: "https://www.bein-live.com/matches-tomorrow/" },
];

// SIIIR source (Server 2)
const SIIIR = {
  dayUrl: {
    yesterday: "https://w4.siiir.tv/yesterday-matches/",
    today: "https://w4.siiir.tv/today-matches/",
    tomorrow: "https://w4.siiir.tv/tomorrow-matches/",
  },
};

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

diagTouch();

const supabase = createClient(supabaseUrl, supabaseKey);

// ===================== URL Helpers =====================
function isJunkCandidateUrl(url) {
  if (!url) return true;
  const u = String(url).toLowerCase();
  return (
/\.(css|js|png|jpg|jpeg|gif|svg|webp|avif|woff|woff2|ttf|eot|ico|json|map)(\?.*)?$/.test(u) ||
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
    try {
      const req = route.request();
      const url = req.url();
      if (isAdHost(url)) return route.abort();
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
  return Number.isFinite(n) && n >= 0 && n <= 30;
}

function parseScore(raw) {
  if (raw === null || raw === undefined) return null;
  const s = normalizeDigits(String(raw)).trim();
  if (!/^\d{1,2}$/.test(s)) return null;
  const n = parseInt(s, 10);
  if (!isValidGoalNumber(n)) return null;
  return n;
}

function parseMs(iso) {
  if (!iso) return null;
  const d = new Date(iso);
  const t = d.getTime();
  return Number.isFinite(t) ? t : null;
}

function statusKeyFromText(statusText) {
  const s0 = String(statusText || "").trim();
  if (!s0) return "unknown";
  const s = s0.toLowerCase();

  if (/لم\s*تبدأ|not started|upcoming|scheduled/i.test(s0)) return "upcoming";
  if (s0.includes("جارية") || s0.includes("مباشر") || s0.includes("الآن")) return "live";
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
    const count = await page.locator(".AY_Match").count().catch(() => 0);

    if (count > 0 && count === last) stableFor += 400;
    else stableFor = 0;

    last = count;
    if (count > 0 && stableFor >= settleMs) return count;

    await page.waitForTimeout(400);
  }
  return last;
}

// ===================== Scrape List (bein-live) =====================
async function scrapeOneDay(page, dayKey, url) {
  console.log(`\n🔎 سحب: ${dayKey} => ${url}`);

  if (DIAG) diagWrite(`list/${dayKey}.url.txt`, url + "\n");

  await page.goto(url, { waitUntil: "domcontentloaded", timeout: LIST_TIMEOUT_MS });
  await page.waitForSelector(".AY_Match, .no-data__msg, body", { timeout: 30000 });

  await page.waitForTimeout(900);
  await waitForStableMatchCount(page, 20000, 1400);

  try {
    await page.mouse.wheel(0, 1400);
    await page.waitForTimeout(700);
  } catch {}

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

    const getResultVisibility = (match) => {
      const res = match.querySelector(".MT_Result");
      if (!res) return "missing";
      const st = (res.getAttribute("style") || "").toLowerCase();
      if (st.includes("display") && st.includes("none")) return "hidden";
      try {
        const cs = window.getComputedStyle(res);
        if (cs && cs.display === "none") return "hidden";
      } catch {}
      return "visible";
    };

    const strictParseGoal = (t) => {
      const s = String(t || "").trim();
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

      const scoreText = pickText(match, [".RS-score", ".RS-Score", ".MT_Score", ".MatchScore", ".match-score", ".score"]);
      const m1 = scoreText.match(/(\d{1,2})\s*[-:]\s*(\d{1,2})/);
      if (m1) {
        const a = strictParseGoal(m1[1]);
        const b = strictParseGoal(m1[2]);
        if (a !== null && b !== null) return { home: String(a), away: String(b), hasAny: true };
      }

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

        const statText = pickText(match, [".MT_Stat"]);
        const classStatus = statusFromClass(match);

        let statusKey = classStatus || "unknown";
        if (statusKey === "unknown" && statText) {
          const t = statText.toLowerCase();
          if (t.includes("لم") && (t.includes("تبدأ") || t.includes("تبدا") || t.includes("يبدأ") || t.includes("يبدا")))
            statusKey = "upcoming";
          else if (t.includes("جارية") || t.includes("مباشر") || t.includes("الآن"))
            statusKey = "live";
          else if (t.includes("انتهت") || t.includes("انتهى") || t.includes("نهاية"))
            statusKey = "finished";
        }

        if (statusKey === "unknown" && DAY_KEY === "yesterday") statusKey = "finished";
        if (statusKey === "unknown" && DAY_KEY === "tomorrow") statusKey = "upcoming";

        const matchUrl = toAbs(a?.getAttribute("href") || "");
        const scorePair = findScorePair(match, statusKey);

        return {
          home_team: teams[0] || "",
          away_team: teams[1] || "",
          data_start: dataStart || null,
          time_text: timeText || null,
          status_text: statText || null,
          status_key_dom: statusKey,
          result_visibility: getResultVisibility(match),
          has_score_hint: !!scorePair.hasAny,
          home_logo: toAbs(pickLogo(imgs[0])),
          away_logo: toAbs(pickLogo(imgs[1])),
          match_url: matchUrl || null,
          home_score_raw: scorePair.home,
          away_score_raw: scorePair.away,
        };
      })
      .filter((m) => m.home_team && m.away_team && m.match_url);
  }, dayKey);

  console.log(`📦 ${dayKey}: ${rows.length} مباراة`);

  if (DIAG) diagWrite(`rows/raw_${dayKey}.json`, JSON.stringify(rows, null, 2));

  return rows;
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

      const m = document.querySelector(".AY_Match");
      const cls = (m?.className || "").toLowerCase();
      let classStatus = "";
      if (cls.includes("not-started")) classStatus = "upcoming";
      else if (cls.includes("live")) classStatus = "live";
      else if (cls.includes("finished") || cls.includes("ended")) classStatus = "finished";

      let statusKey = classStatus || "unknown";
      if (statusKey === "unknown" && statText) {
        const t = statText.toLowerCase();
        if (t.includes("لم") && (t.includes("تبدأ") || t.includes("تبدا") || t.includes("يبدأ") || t.includes("يبدا"))) statusKey = "upcoming";
        else if (t.includes("جارية") || t.includes("مباشر") || t.includes("الآن")) statusKey = "live";
        else if (t.includes("انتهت") || t.includes("انتهى") || t.includes("نهاية")) statusKey = "finished";
      }

      const strictParseGoal = (x) => {
        const s = String(x || "").trim();
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
          const scoreText = pickText(root, [".RS-score", ".RS-Score", ".MT_Score", ".MatchScore", ".match-score", ".score"]);
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
    } catch {}

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
      .filter((u) => u && !isJunkCandidateUrl(u) && !isAdHost(u) && u !== matchUrl);

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
    } catch {}
    try {
      page.off("popup", onPopup);
    } catch {}
    try {
      ctx.off("page", onCtxPage);
    } catch {}
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
  } catch {}

  await diagShot(page, `siiir/list_${dayKey}.png`);
  if (DIAG) {
    try {
      diagWrite(`siiir/list_${dayKey}.html`, (await page.content()).slice(0, 350000));
    } catch {}
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
      return { ...r, match_day };
    })
    .filter((r) => r.home_team && r.away_team && r.match_page_url && r.match_day);

  console.log(`🟣 SIIIR ${dayKey}: ${final.length} items`);
  if (DIAG) diagWrite(`siiir/raw_${dayKey}.json`, JSON.stringify(final, null, 2));
  return final;
}

/**
 * ✅ أهم تعديل:
 * صفحات hard/*.html?match=7 بتولد playerv2.php بالـ JS (وممكن الدومين مختلف)
 * فنستخرج match + host + key من scripts ونبني الرابط يدويًا.
 */
async function deriveSiiirPlayerV2Url(page) {
  let pageUrl = "";
  try {
    pageUrl = page.url();
  } catch {
    pageUrl = "";
  }
  if (!pageUrl) return null;

  try {
    const u = new URL(pageUrl);

    // لو بالفعل playerv2
    if (u.pathname.toLowerCase().includes("playerv2.php")) return pageUrl;

    // match param من URL (hard?match=5 أو match=match5)
    let matchId = u.searchParams.get("match");
    matchId = normalizeDigits(matchId || "").trim();
    matchId = matchId.replace(/^match/i, ""); // match7 => 7
    if (!/^\d{1,5}$/.test(matchId)) return null;

    const scriptsText = await page
      .evaluate(() => Array.from(document.scripts).map((s) => s.textContent || "").join("\n"))
      .catch(() => "");

    if (!scriptsText) return null;

    // host: أي دومين بيستضيف playerv2.php
    const hostMatch =
      scriptsText.match(/https:\/\/([^\/\s"'`]+)\/playerv2\.php/i) ||
      scriptsText.match(/playerurl\s*[:=]\s*["'`]?https:\/\/([^\/\s"'`]+)\/playerv2\.php/i) ||
      scriptsText.match(/src\s*[:=]\s*["'`]?https:\/\/([^\/\s"'`]+)\/playerv2\.php/i);

    const host = (hostMatch?.[1] || "").trim();
    if (!host) return null;

    // key: عدة أشكال
    const keyMatch =
      scriptsText.match(/\bkey\s*=\s*["'`]?([A-Za-z0-9]+)\b/i) ||
      scriptsText.match(/\bkey\s*:\s*["'`]?([A-Za-z0-9]+)\b/i) ||
      scriptsText.match(/&key=([^&"'`\s]+)\b/i);

    const key = (keyMatch?.[1] || "").trim();
    if (!key) return null;

    return `https://${host}/playerv2.php?match=match${encodeURIComponent(matchId)}&key=${encodeURIComponent(key)}`;
  } catch {
    return null;
  }
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
      } catch {}

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
            try { push(f.src); } catch {}
          });

          document.querySelectorAll("a[href]").forEach((a) => {
            push(a.getAttribute("href"));
            try { push(a.href); } catch {}
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
      .filter((u) => u && !isAdHost(u) && !isJunkCandidateUrl(u) && u !== matchPageUrl);

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
    try { page.off("request", onReq); } catch {}
    try { page.off("popup", onPopup); } catch {}
    try { ctx.off("page", onCtxPage); } catch {}
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

function keyOfTeams(matchDay, home, away) {
  const day = String(matchDay || "").toLowerCase();
  const a = canonTeamName(home);
  const b = canonTeamName(away);
  const pair = [a, b].sort().join("__");
  return `${day}||${pair}`;
}

function keyOfRow(r) {
  // لو match_key موجود استخدمه (أفضل وأثبت)
  if (r && r.match_key) return String(r.match_key);
  return keyOfTeams(r.match_day, r.home_team, r.away_team);
}


function isWeakStreamUrl(u) {
  if (!u) return true;
  const s = String(u).toLowerCase();

  // أي لينك بين-لايف ماتش ضعيف
  if (s.includes("bein-live.com") && s.includes("match")) return true;

  // ✅ hard wrapper غير موثوق داخل iframe => اعتبره ضعيف
  if (s.includes("/hard/") && s.includes("aleynoxitram.sbs")) return true;

  // ✅ أقوى شيء لServer2 هو playerv2
  if (s.includes("playerv2.php")) return false;

  // باقي المؤشرات المقبولة (سيرفرات أخرى)
  const goodHints = ["m3u8", "embed", "player", "iframe", "albaplayer", "kora-live"];
  return !goodHints.some((h) => s.includes(h));
}


function preferExistingUrl(newUrl, oldUrl) {
  if (!newUrl && oldUrl) return oldUrl;
  if (newUrl && !oldUrl) return newUrl;
  if (!newUrl && !oldUrl) return null;
  if (isWeakStreamUrl(newUrl) && !isWeakStreamUrl(oldUrl)) return oldUrl;
  return newUrl;
}

async function fetchExistingForDays(days) {
  const { data, error } = await supabase
    .from(TABLE_NAME)
    .select(
  "match_key,home_team,away_team,home_logo,away_logo,stream_url,stream_url_2,stream_url_3,stream_url_4,stream_url_5,match_day,match_start,match_time,home_score,away_score"
)

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

  for (const r of newRows) {
    const k = keyOfRow(r);
    const old = existingMap.get(k);

    let out = { ...r };

    if (old) {
      // Server 1
      out.stream_url = preferExistingUrl(out.stream_url, old.stream_url);

      // Servers 2..5 (preserve if new scrape missing)
      out.stream_url_2 = preferExistingUrl(out.stream_url_2, old.stream_url_2);
      out.stream_url_3 = preferExistingUrl(out.stream_url_3, old.stream_url_3);
      out.stream_url_4 = preferExistingUrl(out.stream_url_4, old.stream_url_4);
      out.stream_url_5 = preferExistingUrl(out.stream_url_5, old.stream_url_5);

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

      const newHS = typeof out.home_score === "number" ? out.home_score : null;
      const newAS = typeof out.away_score === "number" ? out.away_score : null;
      const oldHS = typeof old.home_score === "number" ? old.home_score : null;
      const oldAS = typeof old.away_score === "number" ? old.away_score : null;

      const oldHasScore = oldHS !== null || oldAS !== null;
      const newHasScore = newHS !== null || newAS !== null;

      if (!newHasScore && oldHasScore) {
        out.home_score = oldHS;
        out.away_score = oldAS;
      }
    }

    mergedMap.set(k, out);
  }

  return { mergedRows: Array.from(mergedMap.values()) };
}

// ===================== Main =====================
async function startScraping() {
  console.log("🚀 بدء السكرابر (bein-live) + Server2 (SIIIR) ...");

  diagTouch();

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
    for (const d of DAYS) {
      try {
        const rows = await scrapeSiiirDay(siiirListPage, d.key);
        siiirAll.push(...rows);
      } catch (e) {
        console.error(`⚠️ SIIIR list fail ${d.key}:`, e.message);
        if (DIAG) diagWrite(`siiir/errors_${d.key}.txt`, String(e?.stack || e?.message || e));
      }
    }
    await siiirListPage.close().catch(() => {});
    await siiirListContext.close().catch(() => {});

    const siiirEnriched = await enrichSiiirWithPlayerUrls(browser, siiirAll);

    // map SIIIR by match key
    const siiirMap = new Map();
    for (const r of siiirEnriched) {
      if (!r.siiir_stream_url) continue;
      const k = keyOfTeams(r.match_day, r.home_team, r.away_team);
      if (!siiirMap.has(k)) siiirMap.set(k, r.siiir_stream_url);
    }

    // 3) Normalize bein-live rows
    const normalized = enriched.map((m) => {
  const isoFromAttr = toIsoFromDataStart(m.data_start);
  const match_day = cairoDayFromIso(isoFromAttr) || matchDayFromKey(m._day_key);

  let match_start = isoFromAttr || null;

  const statusKeyDom = (m.deep_status_key_dom || m.status_key_dom || "unknown").toLowerCase();
  const statusTextRaw = m.deep_status_text || m.status_text || "";
  let statusKey = statusKeyDom !== "unknown" ? statusKeyDom : statusKeyFromText(statusTextRaw);

  if (statusKey === "unknown") {
    if (m._day_key === "yesterday") statusKey = "finished";
    else if (m._day_key === "tomorrow") statusKey = "upcoming";
    else statusKey = "unknown";
  }

  const homeScoreRaw = m.deep_home_score_raw ?? m.home_score_raw;
  const awayScoreRaw = m.deep_away_score_raw ?? m.away_score_raw;
  const home_score = statusKey === "upcoming" ? null : parseScore(homeScoreRaw);
  const away_score = statusKey === "upcoming" ? null : parseScore(awayScoreRaw);

  const match_time =
    statusKey === "upcoming"
      ? (m.time_text || prettyTimeFromIso(match_start) || "—")
      : (prettyTimeFromIso(match_start) || m.time_text || "—");

  const finalStreamUrl = m.deep_stream_url || m.match_url;

  // ✅ مفتاح ثابت للماتش (اليوم + الفريقين) — ده اللي هيمنع تغيّر الـ id لاحقًا
  const match_key = keyOfTeams(match_day, m.home_team, m.away_team);

  // Server 2 attach (SIIIR)
let server2 = siiirMap.get(match_key) || null;

// ✅ Server2 لازم يكون playerv2 فقط
if (server2 && !/\/playerv2\.php(\?|$)/i.test(String(server2))) {
  server2 = null;
}

  return {
    // ✅ لازم يتبعت مع الصف للـ RPC
    match_key,

    home_team: m.home_team,
    away_team: m.away_team,
    home_logo: m.home_logo,
    away_logo: m.away_logo,
    stream_url: finalStreamUrl,
    stream_url_2: server2,
    stream_url_3: null,
    stream_url_4: null,
    stream_url_5: null,
    match_day,
    match_start: match_start || null,
    match_time,
    home_score,
    away_score,
  };
});


const finalRows = normalized.filter((r) => r.match_key && r.match_day && r.home_team && r.away_team && r.stream_url);

    if (!finalRows.length) {
      console.log("⚠️ لا توجد بيانات صالحة للإدخال.");
      if (DIAG) diagWrite("summary.json", JSON.stringify({ note: "no valid rows" }, null, 2));
      return;
    }

    const daysToRefresh = [matchDayFromKey("yesterday"), matchDayFromKey("today"), matchDayFromKey("tomorrow")].filter(Boolean);

    const existing = await fetchExistingForDays(daysToRefresh);
    const { mergedRows } = mergeWithExisting({ newRows: finalRows, existingRows: existing });

    if (DIAG) {
      diagWrite("final_rows.json", JSON.stringify(mergedRows, null, 2));
      diagWrite(
        "summary.json",
        JSON.stringify(
          { ts: new Date().toISOString(), daysToRefresh, count: mergedRows.length, siiir_count: siiirEnriched.length },
          null,
          2
        )
      );
    }

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

    console.log("✅ تم التحديث بنجاح (Server2=SIIIR).");
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
