import { NextResponse } from "next/server";

import { supabaseAdmin } from "@/app/api/_supabase";
import { resolveInternalPlayerOrigin } from "@/lib/repack-ingest-gateway";
import { pickRuntimeAdapter } from "@/lib/repack-runtime-adapters";
import {
  getSlotSourceUrlFromRow,
  isAllowedSourceForSlotServer,
  isValidHttpUrl,
  type SlotServerId,
} from "@/lib/server-source-policy";

type MatchRow = {
  id: number;
  match_key?: string | null;
  home_team?: string | null;
  away_team?: string | null;
  match_start?: string | null;
  match_day?: string | null;
  status_key?: string | null;
  stream_url?: string | null;
  stream_url_2?: string | null;
  stream_url_3?: string | null;
  stream_url_4?: string | null;
};

function toInt(raw: unknown) {
  const value = Number.parseInt(String(raw ?? ""), 10);
  return Number.isFinite(value) ? value : NaN;
}

function normalizeTeamNameForCompare(value: unknown) {
  return String(value || "")
    .toLowerCase()
    .replace(/[\u064b-\u065f\u0670\u0610-\u061a]/g, "")
    .replace(/[\u0623\u0625\u0622]/g, "\u0627")
    .replace(/\u0649/g, "\u064a")
    .replace(/\u0624/g, "\u0648")
    .replace(/\u0626/g, "\u064a")
    .replace(/\u0629/g, "\u0647")
    .replace(/[^a-z0-9\u0600-\u06ff]+/g, "");
}

function normalizeTeamAliasForCompare(value: unknown, opts?: { stripGeo?: boolean }) {
  let s = normalizeTeamNameForCompare(value);
  if (!s) return "";
  s = s
    .replace(/^(?:\u0646\u0627\u062f\u064a|\u0641\u0631\u064a\u0642|\u0627\u0644\u0634\u0628\u0627\u0628|\u0633\u064a\u062f\u0627\u062a|\u0627\u0644\u0631\u064a\u0627\u0636\u064a|\u0627\u0644\u0631\u064a\u0627\u0636\u064a\u0647|\u0645\u0646\u062a\u062e\u0628)/, "")
    .replace(/(?:club|fc|sc|u\d{1,2}|women|youth)$/g, "");
  if (opts?.stripGeo) {
    s = s.replace(
      /(?:\u0627\u0644\u0633\u0639\u0648\u062f\u064a|\u0627\u0644\u0645\u0635\u0631\u064a|\u0627\u0644\u0627\u0645\u0627\u0631\u0627\u062a\u064a|\u0627\u0644\u0625\u0645\u0627\u0631\u0627\u062a\u064a|\u0627\u0644\u0645\u063a\u0631\u0628\u064a|\u0627\u0644\u062c\u0632\u0627\u0626\u0631\u064a|\u0627\u0644\u0642\u0637\u0631\u064a|\u0627\u0644\u0643\u0648\u064a\u062a\u064a|\u0627\u0644\u0628\u062d\u0631\u064a\u0646\u064a|\u0627\u0644\u0639\u0645\u0627\u0646\u064a|\u0627\u0644\u0639\u0631\u0627\u0642\u064a|\u0627\u0644\u0633\u0648\u0631\u064a|\u0627\u0644\u0627\u0631\u062f\u0646\u064a|\u0627\u0644\u0623\u0631\u062f\u0646\u064a|\u0627\u0644\u0644\u0628\u0646\u0627\u0646\u064a|\u0627\u0644\u0644\u064a\u0628\u064a|\u0627\u0644\u062a\u0648\u0646\u0633\u064a|\u0627\u0644\u0641\u0644\u0633\u0637\u064a\u0646\u064a|\u0627\u0644\u0645\u0648\u0631\u064a\u062a\u0627\u0646\u064a)$/g,
      ""
    );
  }
  return s.trim();
}

function buildUnorderedTeamPairKey(home: unknown, away: unknown, opts?: { stripGeo?: boolean }) {
  const a = normalizeTeamAliasForCompare(home, opts);
  const b = normalizeTeamAliasForCompare(away, opts);
  if (!a || !b) return "";
  return [a, b].sort().join("|");
}

function matchStartMs(raw: unknown) {
  const value = typeof raw === "string" ? raw : "";
  if (!value) return null as number | null;
  const ms = new Date(value).getTime();
  return Number.isFinite(ms) ? ms : null;
}

function areSiblingKickoffsClose(left: MatchRow, right: MatchRow) {
  const leftMs = matchStartMs(left.match_start);
  const rightMs = matchStartMs(right.match_start);
  if (leftMs === null || rightMs === null) return true;
  return Math.abs(leftMs - rightMs) <= 6 * 60 * 60 * 1000;
}

function extractDayKeyFromRow(row: MatchRow) {
  const matchDay = String(row.match_day || "").trim();
  if (/^\d{4}-\d{2}-\d{2}$/.test(matchDay)) return matchDay;
  const key = String(row.match_key || "");
  const fromKey = key.split("||")[0] || "";
  if (/^\d{4}-\d{2}-\d{2}$/.test(fromKey)) return fromKey;
  if (row.match_start) {
    return new Date(row.match_start).toLocaleDateString("en-CA", { timeZone: "Africa/Cairo" });
  }
  return new Date().toLocaleDateString("en-CA", { timeZone: "Africa/Cairo" });
}

function countPresentStreams(row: MatchRow) {
  const urls = [row.stream_url, row.stream_url_2, row.stream_url_3, row.stream_url_4];
  return urls.reduce((n, u) => (isValidHttpUrl(u) ? n + 1 : n), 0);
}

function mergeMissingStreams(base: MatchRow, donor: MatchRow) {
  const next: MatchRow = { ...base };
  if (!isValidHttpUrl(next.stream_url) && isValidHttpUrl(donor.stream_url)) next.stream_url = donor.stream_url;
  if (!isValidHttpUrl(next.stream_url_2) && isValidHttpUrl(donor.stream_url_2)) next.stream_url_2 = donor.stream_url_2;
  if (!isValidHttpUrl(next.stream_url_3) && isValidHttpUrl(donor.stream_url_3)) next.stream_url_3 = donor.stream_url_3;
  if (!isValidHttpUrl(next.stream_url_4) && isValidHttpUrl(donor.stream_url_4)) next.stream_url_4 = donor.stream_url_4;
  if (!next.match_start && donor.match_start) next.match_start = donor.match_start;
  if (!next.match_day && donor.match_day) next.match_day = donor.match_day;
  if (!next.status_key && donor.status_key) next.status_key = donor.status_key;
  return next;
}

async function fetchMatchRowsByDayKey(dayKey: string) {
  const safeDayKey = String(dayKey || "").trim();
  if (!/^\d{4}-\d{2}-\d{2}$/.test(safeDayKey)) return [] as MatchRow[];
  const { data, error } = await supabaseAdmin
    .from("match-stream-app")
    .select("id,match_key,home_team,away_team,match_start,match_day,status_key,stream_url,stream_url_2,stream_url_3,stream_url_4")
    .like("match_key", `${safeDayKey}||%`)
    .limit(300);
  if (error || !Array.isArray(data)) return [] as MatchRow[];
  return data as MatchRow[];
}

async function enrichMatchRowWithDuplicateSiblingStreams(row: MatchRow) {
  const currentPair = buildUnorderedTeamPairKey(row.home_team, row.away_team);
  const currentLoosePair = buildUnorderedTeamPairKey(row.home_team, row.away_team, { stripGeo: true });
  if (!currentPair && !currentLoosePair) return row;
  const sameDayRows = await fetchMatchRowsByDayKey(extractDayKeyFromRow(row));
  if (!sameDayRows.length) return row;

  const siblings = sameDayRows
    .filter((candidate) => Number(candidate.id) !== Number(row.id))
    .filter((candidate) => {
      if (!areSiblingKickoffsClose(row, candidate)) return false;
      const strictPair = buildUnorderedTeamPairKey(candidate.home_team, candidate.away_team);
      if (currentPair && strictPair && strictPair === currentPair) return true;
      const loosePair = buildUnorderedTeamPairKey(candidate.home_team, candidate.away_team, { stripGeo: true });
      return !!(currentLoosePair && loosePair && loosePair === currentLoosePair);
    });
  if (!siblings.length) return row;

  const donor = siblings.sort((a, b) => {
    const streamDelta = countPresentStreams(b) - countPresentStreams(a);
    if (streamDelta !== 0) return streamDelta;
    const startA = a.match_start ? new Date(a.match_start).getTime() : 0;
    const startB = b.match_start ? new Date(b.match_start).getTime() : 0;
    if (startB !== startA) return startB - startA;
    return Number(b.id || 0) - Number(a.id || 0);
  })[0];
  if (!donor) return row;
  return mergeMissingStreams(row, donor);
}

function isSlotServerId(value: number): value is SlotServerId {
  return value === 1 || value === 2 || value === 3 || value === 4;
}

async function fetchMatchRow(matchId: number) {
  const { data, error } = await supabaseAdmin
    .from("match-stream-app")
    .select("id,match_key,home_team,away_team,match_start,match_day,status_key,stream_url,stream_url_2,stream_url_3,stream_url_4")
    .eq("id", matchId)
    .maybeSingle();
  const enriched = data ? await enrichMatchRowWithDuplicateSiblingStreams(data as MatchRow) : null;
  return {
    data: (enriched || null) as MatchRow | null,
    error: (error || null) as { message?: string } | null,
  };
}

async function resolveRuntimeManifestForRequest(req: Request) {
  const url = new URL(req.url);
  const matchId = toInt(url.searchParams.get("matchId"));
  const slotServer = toInt(url.searchParams.get("slotServer"));
  const waitForMediaSequence = toInt(url.searchParams.get("waitForMediaSequence"));
  const waitTimeoutMs = toInt(url.searchParams.get("waitTimeoutMs"));
  const forceRefresh = String(url.searchParams.get("forceRefresh") || "").trim() === "1";
  const allowRotate = String(url.searchParams.get("allowRotate") || "1").trim() !== "0";
  if (!Number.isFinite(matchId) || matchId <= 0) {
    return NextResponse.json({ ok: false, error: "invalid-match-id" }, { status: 400 });
  }
  if (!Number.isFinite(slotServer) || !isSlotServerId(slotServer)) {
    return NextResponse.json({ ok: false, error: "invalid-slot-server" }, { status: 400 });
  }

  const internalOrigin = resolveInternalPlayerOrigin(req);
  const { data, error } = await fetchMatchRow(matchId);
  if (error) return NextResponse.json({ ok: false, error: String(error.message || "db-error") }, { status: 500 });
  if (!data) return NextResponse.json({ ok: false, error: "match-not-found" }, { status: 404 });

  const sourceUrl = String(getSlotSourceUrlFromRow(data, slotServer) || "").trim();
  if (!sourceUrl || !isValidHttpUrl(sourceUrl)) {
    return NextResponse.json({ ok: false, error: "missing-source" }, { status: 502 });
  }
  if (!isAllowedSourceForSlotServer(slotServer, sourceUrl)) {
    return NextResponse.json({ ok: false, error: "source-not-allowed" }, { status: 502 });
  }

  const adapter = pickRuntimeAdapter({
    sourceUrl,
    slotServer,
    internalOrigin,
  });
  const resolved = await adapter.currentManifest(
    {
      sourceUrl,
      slotServer,
      internalOrigin,
    },
    {
      waitForMediaSequence: Number.isFinite(waitForMediaSequence) ? waitForMediaSequence : null,
      waitTimeoutMs: Number.isFinite(waitTimeoutMs) ? waitTimeoutMs : null,
      forceRefresh,
      allowRotate,
    }
  );
  const runtimePeek = adapter.peekStatus({
    sourceUrl,
    slotServer,
    internalOrigin,
  });

  if (resolved.ok) {
    return new Response(resolved.manifestBody, {
      status: 200,
      headers: {
        "content-type": "application/vnd.apple.mpegurl; charset=utf-8",
        "cache-control": "no-store, no-cache, must-revalidate, max-age=0",
        "x-repack-gateway": "1",
        "x-repack-session-manifest": "1",
        "x-repack-session-owned": "1",
        "x-repack-slot-server": String(slotServer),
        "x-repack-source-url": sourceUrl,
        "x-repack-upstream-url": resolved.targetUrl,
        "x-repack-upstream-final-url": resolved.finalUrl,
        "x-repack-extractor": "embed-session",
        "x-repack-runtime-adapter": resolved.adapterKind,
        "x-repack-runtime-current-source": resolved.currentSource,
        "x-repack-runtime-media-sequence": String(resolved.mediaSequence ?? ""),
        "x-repack-runtime-target-duration": String(resolved.targetDurationSec || 0),
        "x-repack-runtime-refreshed": resolved.refreshed ? "1" : "0",
        "x-repack-runtime-rotated": resolved.rotated ? "1" : "0",
        "x-repack-runtime-path": runtimePeek.runtimePath || "",
        "x-repack-runtime-source-count": String(runtimePeek.sourceCount || 0),
        "x-repack-runtime-source-index": String(runtimePeek.sourceIndex ?? ""),
        "x-repack-runtime-tab-index": String(runtimePeek.tabIndex ?? ""),
        "x-repack-runtime-watchdog-state": runtimePeek.watchdogState || "",
        "x-repack-runtime-last-refresh-reason": runtimePeek.lastRefreshReason || "",
        "x-repack-runtime-last-rotate-reason": runtimePeek.lastRotateReason || "",
        "x-repack-extractor-candidates-found": String(resolved.candidatesFound),
        "x-repack-extractor-candidates-tried": String(resolved.candidatesTried),
      },
    });
  }

  return NextResponse.json(
    {
      ok: false,
      error: `embed-session-${resolved.error || "resolution-failed"}`,
      extractor: {
        mode: "embed-session",
        adapter: resolved.adapterKind,
        playbackUrl: resolved.playbackUrl || null,
        currentSource: resolved.currentSource || null,
        mediaSequence: resolved.mediaSequence,
        targetDurationSec: resolved.targetDurationSec || 0,
        refreshed: resolved.refreshed,
        rotated: resolved.rotated,
        candidatesFound: resolved.candidatesFound,
        candidatesTried: resolved.candidatesTried,
        runtimePath: runtimePeek.runtimePath || null,
        sourceCount: runtimePeek.sourceCount || 0,
        sourceIndex: runtimePeek.sourceIndex,
        tabIndex: runtimePeek.tabIndex,
        watchdogState: runtimePeek.watchdogState || "",
        lastRefreshReason: runtimePeek.lastRefreshReason || "",
        lastRotateReason: runtimePeek.lastRotateReason || "",
      },
    },
    { status: 502 }
  );
}

export async function handleRuntimeSessionManifestRequest(req: Request) {
  return resolveRuntimeManifestForRequest(req);
}
