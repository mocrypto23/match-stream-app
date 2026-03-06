#!/usr/bin/env node
"use strict";
/* eslint-disable @typescript-eslint/no-require-imports */

const path = require("path");
const dotenv = require("dotenv");
const { createClient } = require("@supabase/supabase-js");

dotenv.config({ path: path.join(process.cwd(), ".env.local") });

const TABLE = "match-stream-app";

function nowIso() {
  return new Date().toISOString();
}

function toInt(raw, fallback, min = Number.MIN_SAFE_INTEGER) {
  const n = Number.parseInt(String(raw || "").trim(), 10);
  if (!Number.isFinite(n)) return fallback;
  return Math.max(min, n);
}

function toBool(raw, fallback = false) {
  const v = String(raw || "").trim().toLowerCase();
  if (!v) return fallback;
  return v === "1" || v === "true" || v === "yes" || v === "on";
}

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, Math.max(0, ms)));
}

function getCairoDayKey(offsetDays = 0) {
  const base = new Date(Date.now() + offsetDays * 24 * 60 * 60 * 1000);
  return new Intl.DateTimeFormat("en-CA", {
    timeZone: "Africa/Cairo",
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
  }).format(base);
}

function parseMatchStartMs(raw) {
  const value = String(raw || "").trim();
  if (!value) return null;
  const ms = new Date(value).getTime();
  return Number.isFinite(ms) ? ms : null;
}

function computeWindowState(matchStartMs, config, nowMs = Date.now()) {
  const startAtMs = Number.isFinite(matchStartMs) ? Number(matchStartMs) : null;
  if (!startAtMs) return { inWindow: false, openAtMs: null, closeAtMs: null };
  const openAtMs = startAtMs - config.prematchOpenMs;
  const closeAtMs = startAtMs + config.matchDurationMs + config.postmatchGraceMs;
  return {
    inWindow: nowMs >= openAtMs && nowMs <= closeAtMs,
    openAtMs,
    closeAtMs,
  };
}

function normalizeOrigin(raw) {
  const value = String(raw || "").trim();
  if (!value) return "http://127.0.0.1:3000";
  return value.replace(/\/+$/, "");
}

function normalizeOptionalUrl(raw) {
  const value = String(raw || "").trim();
  if (!value) return "";
  return value.replace(/\/+$/, "");
}

function isValidHttpUrl(raw) {
  const value = String(raw || "").trim();
  if (!value) return false;
  try {
    const u = new URL(value);
    return u.protocol === "http:" || u.protocol === "https:";
  } catch {
    return false;
  }
}

function createSupabaseClientFromEnv() {
  const url = normalizeOptionalUrl(process.env.SUPABASE_URL || process.env.NEXT_PUBLIC_SUPABASE_URL);
  const key = String(
    process.env.SUPABASE_KEY ||
      process.env.SUPABASE_SERVICE_ROLE_KEY ||
      process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY ||
      ""
  ).trim();
  if (!url || !key) return null;
  try {
    return createClient(url, key, { auth: { persistSession: false } });
  } catch {
    return null;
  }
}

function log(level, message, extra = {}) {
  const payload = { ts: nowIso(), level, message, ...extra };
  process.stdout.write(`${JSON.stringify(payload)}\n`);
}

async function fetchJson(url, timeoutMs, init = {}) {
  const controller = new AbortController();
  const timeoutId = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const response = await fetch(url, {
      ...init,
      cache: "no-store",
      redirect: "follow",
      signal: controller.signal,
      headers: {
        accept: "application/json,*/*",
        ...(init.headers || {}),
      },
    });
    const text = await response.text();
    let body = null;
    try {
      body = text ? JSON.parse(text) : null;
    } catch {
      body = { raw: text };
    }
    return {
      ok: response.ok,
      status: response.status,
      body,
    };
  } catch (error) {
    return {
      ok: false,
      status: 0,
      body: {
        error: error instanceof Error ? error.message : String(error),
      },
    };
  } finally {
    clearTimeout(timeoutId);
  }
}

async function mapLimit(items, limit, handler) {
  const safeLimit = Math.max(1, limit);
  const out = new Array(items.length);
  let nextIndex = 0;

  async function worker() {
    while (true) {
      const idx = nextIndex;
      nextIndex += 1;
      if (idx >= items.length) return;
      try {
        out[idx] = await handler(items[idx], idx);
      } catch (error) {
        out[idx] = {
          ok: false,
          status: 0,
          body: {
            error: error instanceof Error ? error.message : String(error),
          },
        };
      }
    }
  }

  await Promise.all(Array.from({ length: Math.min(safeLimit, items.length) }, () => worker()));
  return out;
}

async function fetchMatchesForDays(origin, timeoutMs) {
  const days = [getCairoDayKey(-1), getCairoDayKey(0), getCairoDayKey(1)];
  const all = new Map();
  for (const day of days) {
    const res = await fetchJson(`${origin}/api/matches?day=${encodeURIComponent(day)}`, timeoutMs);
    if (!res.ok || !Array.isArray(res.body)) continue;
    for (const row of res.body) {
      const id = Number.parseInt(String(row?.id || ""), 10);
      if (!Number.isFinite(id) || id <= 0) continue;
      all.set(id, row);
    }
  }
  return Array.from(all.values());
}

async function fetchMatchesForDaysViaSupabase(supabase) {
  const days = [getCairoDayKey(-1), getCairoDayKey(0), getCairoDayKey(1)];
  const all = new Map();
  for (const day of days) {
    const { data, error } = await supabase
      .from(TABLE)
      .select("id,match_day,match_start,status_key,stream_url,stream_url_2,stream_url_3,stream_url_4")
      .eq("match_day", day)
      .order("match_start", { ascending: true, nullsFirst: false })
      .order("id", { ascending: true })
      .limit(500);
    if (error || !Array.isArray(data)) continue;
    for (const row of data) {
      const id = Number.parseInt(String(row?.id || ""), 10);
      if (!Number.isFinite(id) || id <= 0) continue;
      all.set(id, row);
    }
  }
  return Array.from(all.values());
}

function getUiServersForMatch(row) {
  const servers = [];
  if (isValidHttpUrl(row?.stream_url_4)) servers.push(1);
  if (isValidHttpUrl(row?.stream_url_2)) servers.push(2);
  if (isValidHttpUrl(row?.stream_url_3)) servers.push(3);
  if (isValidHttpUrl(row?.stream_url)) servers.push(4);
  return servers;
}

function pickTargetMatches(matches, config, nowMs) {
  return matches
    .map((row) => {
      const matchId = Number.parseInt(String(row?.id || ""), 10);
      const status = String(row?.status_key || "").trim().toLowerCase();
      const matchStartMs = parseMatchStartMs(row?.match_start);
      const windowState = computeWindowState(matchStartMs, config, nowMs);
      const uiServers = getUiServersForMatch(row);
      return {
        matchId,
        status,
        matchStartMs,
        inWindow: windowState.inWindow,
        uiServers,
      };
    })
    .filter((row) => Number.isFinite(row.matchId) && row.matchId > 0 && row.inWindow && row.uiServers.length > 0)
    .sort((a, b) => {
      const rank = (status) => {
        if (status === "live") return 3;
        if (status === "upcoming") return 2;
        if (status === "finished") return 1;
        return 0;
      };
      const rankDelta = rank(b.status) - rank(a.status);
      if (rankDelta !== 0) return rankDelta;
      const aStart = Number.isFinite(a.matchStartMs) ? a.matchStartMs : Number.MAX_SAFE_INTEGER;
      const bStart = Number.isFinite(b.matchStartMs) ? b.matchStartMs : Number.MAX_SAFE_INTEGER;
      return aStart - bStart;
    });
}

async function runCycle(config) {
  const startedAt = Date.now();
  const matches = config.supabase
    ? await fetchMatchesForDaysViaSupabase(config.supabase)
    : await fetchMatchesForDays(config.origin, config.httpTimeoutMs);
  const targets = pickTargetMatches(matches, config, Date.now()).slice(0, config.maxMatches);

  if (!targets.length) {
    log("info", "prewarm cycle skip", { reason: "no-targets" });
    return;
  }

  const responses = await mapLimit(targets, config.concurrency, async (item) => {
    return fetchJson(`${config.origin}/api/repack/bootstrap`, config.httpTimeoutMs, {
      method: "POST",
      headers: {
        "content-type": "application/json",
      },
      body: JSON.stringify({
        matchId: item.matchId,
        uiServers: item.uiServers,
      }),
    });
  });

  let accepted = 0;
  let rejected = 0;
  const rejectReasons = {};

  for (const response of responses) {
    const results = Array.isArray(response?.body?.results) ? response.body.results : [];
    for (const item of results) {
      if (item?.accepted) {
        accepted += 1;
        continue;
      }
      rejected += 1;
      const reason = String(item?.reason || "unknown");
      rejectReasons[reason] = (rejectReasons[reason] || 0) + 1;
    }
  }

  log("info", "prewarm cycle done", {
    matchesFetched: matches.length,
    targets: targets.length,
    accepted,
    rejected,
    rejectReasons,
    durationMs: Date.now() - startedAt,
  });
}

function loadConfig() {
  const prematchOpenMinutes = toInt(process.env.REPACK_PREMATCH_OPEN_WINDOW_MINUTES, 30, 0);
  const matchDurationMinutes = toInt(process.env.REPACK_MATCH_DURATION_MINUTES, 180, 1);
  const postmatchGraceMinutes = toInt(process.env.REPACK_POSTMATCH_GRACE_MINUTES, 15, 0);

  return {
    enabled: toBool(process.env.REPACK_PREWARM_ENABLED, true),
    intervalMs: toInt(process.env.REPACK_PREWARM_INTERVAL_MS, 60_000, 10_000),
    concurrency: toInt(process.env.REPACK_PREWARM_CONCURRENCY, 6, 1),
    maxMatches: toInt(process.env.REPACK_PREWARM_MAX_MATCHES, 50, 1),
    httpTimeoutMs: toInt(process.env.REPACK_PREWARM_HTTP_TIMEOUT_MS, 8_000, 1000),
    origin: normalizeOrigin(
      process.env.REPACK_PREWARM_ORIGIN ||
        process.env.REPACK_INTERNAL_ORIGIN ||
        process.env.NEXT_PUBLIC_APP_ORIGIN ||
        "http://127.0.0.1:3000"
    ),
    prematchOpenMs: prematchOpenMinutes * 60 * 1000,
    matchDurationMs: matchDurationMinutes * 60 * 1000,
    postmatchGraceMs: postmatchGraceMinutes * 60 * 1000,
    supabase: createSupabaseClientFromEnv(),
  };
}

async function main() {
  const config = loadConfig();
  let stopped = false;

  const stop = (signal) => {
    stopped = true;
    log("info", "prewarm stopping", { signal });
  };
  process.on("SIGINT", stop);
  process.on("SIGTERM", stop);

  log("info", "prewarm started", {
    enabled: config.enabled,
    intervalMs: config.intervalMs,
    concurrency: config.concurrency,
    maxMatches: config.maxMatches,
    origin: config.origin,
    supabaseDirect: !!config.supabase,
  });

  while (!stopped) {
    if (!config.enabled) {
      log("info", "prewarm disabled", { nextCheckMs: config.intervalMs });
      await sleep(config.intervalMs);
      continue;
    }

    try {
      await runCycle(config);
    } catch (error) {
      log("error", "prewarm cycle failed", {
        error: error instanceof Error ? error.message : String(error),
      });
    }
    await sleep(config.intervalMs);
  }
}

main().catch((error) => {
  const message = error instanceof Error ? error.stack || error.message : String(error);
  process.stderr.write(`[repack-prewarm] fatal: ${message}\n`);
  process.exit(1);
});
