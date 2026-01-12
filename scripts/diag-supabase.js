// ===============================
// File: scripts/diag-supabase.js
// ===============================
/**
 * Reads today's rows from Supabase and writes a diagnostic report under ./diag
 *
 * Usage:
 *   node scripts/diag-supabase.js
 *
 * Env:
 *   SUPABASE_URL, SUPABASE_KEY (required)
 *   TABLE_NAME (optional, default: match-stream-app)
 */

const fs = require("fs");
const path = require("path");
const { createClient } = require("@supabase/supabase-js");

const TZ = "Africa/Cairo";
const TABLE_NAME = process.env.TABLE_NAME || "match-stream-app";

function ensureDir(p) {
  try {
    fs.mkdirSync(p, { recursive: true });
  } catch {}
}

function diagRoot() {
  return path.join(process.cwd(), "diag");
}

function diagWrite(rel, content) {
  const root = diagRoot();
  ensureDir(root);
  const full = path.join(root, rel);
  ensureDir(path.dirname(full));
  fs.writeFileSync(full, typeof content === "string" ? content : JSON.stringify(content, null, 2));
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

function parseMs(iso) {
  if (!iso) return null;
  const d = new Date(iso);
  const t = d.getTime();
  return Number.isFinite(t) ? t : null;
}

function isLikelyLiveByTime(matchStartIso, nowMs) {
  const t = parseMs(matchStartIso);
  if (!t) return false;
  const fifteenMin = 15 * 60 * 1000;
  const sixH = 6 * 60 * 60 * 1000;
  return t <= nowMs + fifteenMin && t >= nowMs - sixH;
}

function toIsoNowInCairo() {
  const now = new Date();
  const ymd = ymdInTimeZone(now, TZ);
  const parts = new Intl.DateTimeFormat("en", {
    timeZone: TZ,
    hour: "2-digit",
    minute: "2-digit",
    hour12: false,
  }).formatToParts(now);

  const hh = parts.find((p) => p.type === "hour")?.value;
  const mm = parts.find((p) => p.type === "minute")?.value;
  const offsetGuess = "+02:00";
  if (!ymd || !hh || !mm) return now.toISOString();
  return `${ymd}T${hh}:${mm}:00${offsetGuess}`;
}

async function main() {
  const supabaseUrl = process.env.SUPABASE_URL;
  const supabaseKey = process.env.SUPABASE_KEY;

  if (!supabaseUrl || !supabaseKey) {
    console.error("❌ Missing SUPABASE_URL or SUPABASE_KEY");
    process.exit(1);
  }

  ensureDir(diagRoot());
  diagWrite("_touch.txt", `ok ${new Date().toISOString()}\n`);

  const supabase = createClient(supabaseUrl, supabaseKey);

  const todayKey = ymdInTimeZone(new Date(), TZ);
  const nowMs = Date.now();

  const { data, error } = await supabase
    .from(TABLE_NAME)
    .select(
      "home_team,away_team,match_day,match_start,match_time,home_score,away_score,stream_url,home_logo,away_logo"
    )
    .eq("match_day", todayKey);

  if (error) {
    diagWrite("supabase_error.txt", error.message);
    console.error("❌ Supabase read error:", error.message);
    process.exit(2);
  }

  const rows = Array.isArray(data) ? data : [];
  const enriched = rows.map((r) => {
    const startMs = parseMs(r.match_start);
    const hasScore = r.home_score !== null || r.away_score !== null;
    const likelyLive = isLikelyLiveByTime(r.match_start, nowMs);
    const futureBy = startMs ? startMs - nowMs : null;

    return {
      ...r,
      _diag: {
        hasScore,
        likelyLiveByTime: likelyLive,
        matchStartMs: startMs,
        futureMinutes: futureBy === null ? null : Math.round(futureBy / 60000),
      },
    };
  });

  const suspects = enriched.filter((r) => {
    const startMs = r._diag.matchStartMs;
    if (!startMs) return true;
    const isFuture = startMs > nowMs + 10 * 60 * 1000;
    const noScore = !r._diag.hasScore;
    return isFuture && noScore;
  });

  const summary = {
    ts: new Date().toISOString(),
    cairoToday: todayKey,
    cairoNowApprox: toIsoNowInCairo(),
    counts: {
      total: enriched.length,
      withScore: enriched.filter((r) => r._diag.hasScore).length,
      likelyLiveByTime: enriched.filter((r) => r._diag.likelyLiveByTime).length,
      suspectsFutureNoScore: suspects.length,
      nullStart: enriched.filter((r) => !r._diag.matchStartMs).length,
    },
    hints:
      "لو suspectsFutureNoScore كبيرة: السكراب على GitHub مش بيجيب score/status فبيفضل match_start وقت الجدول => الواجهة تعرض وقت فقط.",
  };

  diagWrite("supabase_today_rows.json", enriched);
  diagWrite("supabase_today_suspects.json", suspects);
  diagWrite("supabase_summary.json", summary);

  console.log("✅ Wrote Supabase diagnostics to ./diag");
  console.log(summary);
}

main().catch((e) => {
  try {
    ensureDir(diagRoot());
    diagWrite("supabase_fatal.txt", String(e?.stack || e?.message || e));
  } catch {}
  console.error("❌ Fatal:", e?.message || e);
  process.exit(3);
});
