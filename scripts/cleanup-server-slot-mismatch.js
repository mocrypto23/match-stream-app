/* eslint-disable @typescript-eslint/no-require-imports */
/**
 * One-time cleanup for server-slot isolation mismatches.
 *
 * Usage:
 *   node scripts/cleanup-server-slot-mismatch.js          # dry run
 *   node scripts/cleanup-server-slot-mismatch.js --apply  # write nulls to mismatched slots
 *
 * Env:
 *   SUPABASE_URL, SUPABASE_KEY (required)
 *   TABLE_NAME (optional, default: match-stream-app)
 */

const fs = require("fs");
const path = require("path");
const { createClient } = require("@supabase/supabase-js");
require("dotenv").config({ path: ".env.local" });

const TABLE_NAME = process.env.TABLE_NAME || "match-stream-app";
const PAGE_SIZE = 1000;

const SLOT_FIELDS = [
  { slot: 2, field: "stream_url_2" },
  { slot: 3, field: "stream_url_3" },
  { slot: 4, field: "stream_url_4" },
  { slot: 5, field: "stream_url_5" },
  { slot: 6, field: "stream_url_6" },
];

const SLOT_DOMAIN_WHITELIST = Object.freeze({
  2: ["siiir.tv", "yallashot.us", "aleynoxitram.sbs"],
  3: ["livehd77.pro", "alkoora.live"],
  4: ["livekora.vip", "koooralive.click", "kooraxx.com", "sia-bth.net"],
  5: ["tskoralive.com", "pyxq.online"],
  6: ["1kora.com", "ahlamontada.com"],
});

function ensureDir(dirPath) {
  try {
    fs.mkdirSync(dirPath, { recursive: true });
  } catch {}
}

function normalizeUrl(raw, baseUrl) {
  if (!raw) return null;
  let value = String(raw).trim();
  if (!value || /^(javascript:|data:)/i.test(value)) return null;

  if (value.startsWith("//")) value = "https:" + value;
  if (value.startsWith("/")) {
    try {
      value = new URL(value, baseUrl).toString();
    } catch {
      return null;
    }
  }

  try {
    if (!/^https?:\/\//i.test(value)) value = new URL(value, baseUrl).toString();
  } catch {}

  return /^https?:\/\//i.test(value) ? value : null;
}

function hostMatchesAnyHint(hostname, hints) {
  if (!hostname) return false;
  const host = String(hostname).toLowerCase().trim();
  return (hints || []).some((hintRaw) => {
    const hint = String(hintRaw || "").toLowerCase().trim();
    if (!hint) return false;
    return host === hint || host.endsWith("." + hint);
  });
}

function looksLikePlayerUrl(url) {
  const s = String(url || "").toLowerCase();
  if (!/^https?:\/\//i.test(s)) return false;
  return /\/albaplayer\/|\/alba\.php|\/playerv2\.php(\?|$)|\/embed|\/player|\/tv\//i.test(s);
}

function validateServerUrlBySlot(slot, rawUrl) {
  const normalized = normalizeUrl(rawUrl, rawUrl);
  if (!normalized) return { ok: false, reason: "invalid_url", normalized: null };

  try {
    const parsed = new URL(normalized);
    const host = parsed.hostname.toLowerCase();
    const pathWithQuery = `${parsed.pathname}${parsed.search}`;

    if (slot === 2) {
      if (!/\/playerv2\.php(\?|$)/i.test(pathWithQuery)) {
        return { ok: false, reason: "server2_requires_playerv2", normalized };
      }
      return { ok: true, reason: null, normalized };
    }

    if (slot === 3) {
      if (!hostMatchesAnyHint(host, SLOT_DOMAIN_WHITELIST[3])) {
        return { ok: false, reason: "server3_requires_livehd_domain", normalized };
      }
      if (!looksLikePlayerUrl(normalized)) {
        return { ok: false, reason: "server3_requires_player_url", normalized };
      }
      return { ok: true, reason: null, normalized };
    }

    if (slot === 4) {
      if (!hostMatchesAnyHint(host, SLOT_DOMAIN_WHITELIST[4])) {
        return { ok: false, reason: "server4_requires_livekora_domain", normalized };
      }
      if (!looksLikePlayerUrl(normalized)) {
        return { ok: false, reason: "server4_requires_player_url", normalized };
      }
      return { ok: true, reason: null, normalized };
    }

    if (slot === 5) {
      if (!hostMatchesAnyHint(host, SLOT_DOMAIN_WHITELIST[5])) {
        return { ok: false, reason: "server5_requires_tskora_domain", normalized };
      }
      const isTskoraPage = hostMatchesAnyHint(host, ["tskoralive.com"]);
      if (!isTskoraPage && !looksLikePlayerUrl(normalized)) {
        return { ok: false, reason: "server5_requires_player_url", normalized };
      }
      return { ok: true, reason: null, normalized };
    }

    if (slot === 6) {
      if (!hostMatchesAnyHint(host, SLOT_DOMAIN_WHITELIST[6])) {
        return { ok: false, reason: "server6_requires_1kora_domain", normalized };
      }
      return { ok: true, reason: null, normalized };
    }
  } catch {
    return { ok: false, reason: "invalid_url", normalized: null };
  }

  return { ok: false, reason: "unsupported_slot", normalized };
}

async function fetchAllRows(supabase) {
  const rows = [];
  let from = 0;
  while (true) {
    const to = from + PAGE_SIZE - 1;
    const { data, error } = await supabase
      .from(TABLE_NAME)
      .select("id,match_key,stream_url_2,stream_url_3,stream_url_4,stream_url_5,stream_url_6")
      .order("id", { ascending: true })
      .range(from, to);

    if (error) throw new Error(error.message);
    const chunk = Array.isArray(data) ? data : [];
    rows.push(...chunk);
    if (chunk.length < PAGE_SIZE) break;
    from += PAGE_SIZE;
  }
  return rows;
}

async function main() {
  const supabaseUrl = process.env.SUPABASE_URL;
  const supabaseKey = process.env.SUPABASE_KEY;
  if (!supabaseUrl || !supabaseKey) {
    throw new Error("Missing SUPABASE_URL or SUPABASE_KEY");
  }

  const applyMode = process.argv.includes("--apply");
  const supabase = createClient(supabaseUrl, supabaseKey);
  const rows = await fetchAllRows(supabase);

  const updatesByRowId = new Map();
  const report = [];

  for (const row of rows) {
    const payload = {};
    for (const slotMeta of SLOT_FIELDS) {
      const { slot, field } = slotMeta;
      const oldUrl = row[field];
      if (!oldUrl) continue;
      const verdict = validateServerUrlBySlot(slot, oldUrl);
      if (verdict.ok) continue;

      payload[field] = null;
      report.push({
        row_id: row.id,
        match_key: row.match_key || null,
        slot: field,
        old_url: oldUrl,
        reason: verdict.reason || "slot_mismatch",
      });
    }
    if (Object.keys(payload).length) updatesByRowId.set(row.id, payload);
  }

  const updateEntries = Array.from(updatesByRowId.entries());
  let updated = 0;
  let updateFailures = 0;

  if (applyMode && updateEntries.length) {
    for (const [rowId, payload] of updateEntries) {
      const { error } = await supabase.from(TABLE_NAME).update(payload).eq("id", rowId);
      if (error) {
        updateFailures += 1;
        report.push({
          row_id: rowId,
          slot: "update",
          old_url: null,
          reason: `update_failed:${error.message}`,
        });
        continue;
      }
      updated += 1;
    }
  }

  const diagDir = path.join(process.cwd(), "diag");
  ensureDir(diagDir);
  const ts = new Date().toISOString().replace(/[:.]/g, "-");
  const reportPath = path.join(diagDir, `server_slot_cleanup_${ts}.json`);
  fs.writeFileSync(
    reportPath,
    JSON.stringify(
      {
        ts: new Date().toISOString(),
        table: TABLE_NAME,
        mode: applyMode ? "apply" : "dry_run",
        scanned_rows: rows.length,
        mismatch_count: report.filter((r) => r.slot !== "update").length,
        rows_to_update: updateEntries.length,
        rows_updated: updated,
        update_failures: updateFailures,
        report,
      },
      null,
      2
    )
  );

  console.log(`mode=${applyMode ? "apply" : "dry_run"}`);
  console.log(`scanned_rows=${rows.length}`);
  console.log(`mismatches=${report.filter((r) => r.slot !== "update").length}`);
  console.log(`rows_to_update=${updateEntries.length}`);
  console.log(`rows_updated=${updated}`);
  console.log(`update_failures=${updateFailures}`);
  console.log(`report=${reportPath}`);
}

main().catch((err) => {
  console.error("cleanup failed:", err?.message || err);
  process.exit(1);
});
