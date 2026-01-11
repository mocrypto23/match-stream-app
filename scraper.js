const { chromium } = require("playwright");
const { createClient } = require("@supabase/supabase-js");

// خذهم من Environment Variables (مش من الكود)
const supabaseUrl = process.env.SUPABASE_URL;
const supabaseKey = process.env.SUPABASE_KEY;

if (!supabaseUrl || !supabaseKey) {
  console.error("❌ Missing SUPABASE_URL or SUPABASE_KEY in environment.");
  process.exit(1);
}

const supabase = createClient(supabaseUrl, supabaseKey);


const DAYS = [
  { key: "yesterday", url: "https://www.bein-live.com/matches-yesterday/" },
  { key: "today", url: "https://www.bein-live.com/matches-today_1/" },
  { key: "tomorrow", url: "https://www.bein-live.com/matches-tomorrow/" },
];

const TZ = "Africa/Cairo";

// YYYY-MM-DD ثابتة في أي بيئة (Node/Windows/…)
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
  // "2026-01-11 14:30+03:00" => "2026-01-11T14:30+03:00"
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
  const s = String(raw).trim();
  if (!s) return null;
  // خُد الأرقام فقط (حتى لو فيه رموز)
  const digits = s.replace(/[^\d]/g, "");
  if (!digits) return null;
  const n = parseInt(digits, 10);
  return Number.isFinite(n) ? n : null;
}

async function scrapeOneDay(page, dayKey, url) {
  console.log(`\n🔎 سحب: ${dayKey} => ${url}`);
  await page.goto(url, { waitUntil: "domcontentloaded", timeout: 60000 });

  // الصفحة أحيانًا تكون فاضية
  await page.waitForSelector(".AY_Match, .no-data__msg, body", { timeout: 30000 });

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

    const matches = Array.from(document.querySelectorAll(".AY_Match"));

    return matches
      .map((match) => {
        const teams = Array.from(match.querySelectorAll(".TM_Name")).map((e) =>
          (e.textContent || "").trim()
        );

        const imgs = Array.from(match.querySelectorAll(".TM_Logo img"));
        const a = match.querySelector("a[href]");

        const dataStart = (match.getAttribute("data-start") || "").trim();

        // وقت بديل (لو الموقع حاطط الوقت كنص بدل data-start)
        const timeText = pickText(match, [
          ".MT_Time",
          ".TM_Time",
          ".match-time",
          ".MatchTime",
          ".AY_Time",
        ]);

        // نتائج (غالبًا موجودة في yesterday)
        const goals = Array.from(match.querySelectorAll(".RS-goals")).map((g) =>
          (g.textContent || "").trim()
        );

        return {
          home_team: teams[0] || "",
          away_team: teams[1] || "",
          data_start: dataStart || null,
          time_text: timeText || null,
          home_logo: toAbs(pickLogo(imgs[0])),
          away_logo: toAbs(pickLogo(imgs[1])),
          stream_url: toAbs(a?.getAttribute("href") || ""),
          home_score_raw: goals[0] ?? null,
          away_score_raw: goals[1] ?? null,
        };
      })
      .filter((m) => m.home_team && m.away_team);
  });

  console.log(`📦 ${dayKey}: ${rows.length} مباراة`);
  return rows;
}

async function startScraping() {
  console.log("🚀 بدء السكرابر (أمس/اليوم/غد) ...");

  const browser = await chromium.launch({ headless: true });

  const context = await browser.newContext({
    locale: "ar-EG",
    timezoneId: TZ,
    extraHTTPHeaders: {
      "Accept-Language": "ar-EG,ar;q=0.9,en-US;q=0.8,en;q=0.7",
    },
    userAgent:
      "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/121.0.0.0 Safari/537.36",
    viewport: { width: 1280, height: 720 },
  });

  const page = await context.newPage();
  const all = [];

  try {
    for (const d of DAYS) {
      try {
        const rows = await scrapeOneDay(page, d.key, d.url);
        all.push(...rows.map((r) => ({ ...r, _day_key: d.key })));
      } catch (e) {
        console.error(`⚠️ فشل سحب ${d.key}:`, e.message);
      }
    }

    // توزيع حسب التبويب (للتأكد إن الأمس فعلاً دخل للـ all)
    const byKey = all.reduce((acc, r) => {
      acc[r._day_key] = (acc[r._day_key] || 0) + 1;
      return acc;
    }, {});
    console.log("\n🧾 raw by _day_key:", byKey);

    const normalized = all.map((m) => {
      const iso = toIsoFromDataStart(m.data_start);

      // match_day: دايمًا موجود (إما من iso أو من tab)
      const match_day = cairoDayFromIso(iso) || matchDayFromKey(m._day_key);

      const home_score = parseScore(m.home_score_raw);
      const away_score = parseScore(m.away_score_raw);

      // match_time: لو iso موجود نزبطه، غير كده نستخدم الوقت النصي لو موجود
      const match_time = iso ? prettyTimeFromIso(iso) : (m.time_text || "—");

      return {
        home_team: m.home_team,
        away_team: m.away_team,
        home_logo: m.home_logo,
        away_logo: m.away_logo,
        stream_url: m.stream_url,

        match_day,                 // TEXT/DATE YYYY-MM-DD
        match_start: iso || null,  // timestamptz (ممكن null خصوصًا أمس)
        match_time,                // نص عرض

        home_score,
        away_score,
      };
    });

    const finalRows = normalized.filter((r) => r.match_day);

    // توزيع قبل الإدخال (ده أهم سطرين)
    const byDay = finalRows.reduce((acc, r) => {
      acc[r.match_day] = (acc[r.match_day] || 0) + 1;
      return acc;
    }, {});
    console.log("📅 final by match_day:", byDay);
    console.log(`📦 finalRows total: ${finalRows.length}`);

    if (finalRows.length === 0) {
      console.log("⚠️ لا توجد بيانات صالحة للإدخال.");
      return;
    }

    const daysToRefresh = [
      matchDayFromKey("yesterday"),
      matchDayFromKey("today"),
      matchDayFromKey("tomorrow"),
    ].filter(Boolean);

    // امسح فقط الأيام المستهدفة
    const delRes = await supabase.from("match-stream-app").delete().in("match_day", daysToRefresh);
    if (delRes.error) console.error("❌ Delete Error:", delRes.error.message);

    const insRes = await supabase.from("match-stream-app").insert(finalRows);
    if (insRes.error) {
      console.error("❌ Insert Error:", insRes.error.message);
      return;
    }

    console.log("✅ تم تحديث قاعدة البيانات بنجاح.");
  } catch (err) {
    console.error("❌ فشل السكرابر:", err.message);
    try {
      await page.screenshot({ path: "debug.png", fullPage: true });
      console.log("🧩 تم حفظ debug.png لفحص الصفحة.");
    } catch {}
  } finally {
    await browser.close();
  }
}

startScraping();
