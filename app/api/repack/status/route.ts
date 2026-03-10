import { NextResponse } from "next/server";
import { supabaseAdmin } from "../../_supabase";
import { getRuntimeRepackFlags } from "@/lib/repack-flags";
import { buildMatchR2Status } from "@/lib/r2-status";
import { listRepackSeedRuntimeStateForMatch } from "@/lib/repack-runtime-state";
import { getServerStreamMode } from "@/lib/stream-mode";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";
const DUPLICATE_SIBLING_START_WINDOW_MS = 6 * 60 * 60 * 1000;

type MatchStatusRow = {
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
  if (/^(?:\u0627\u0644\u0646\u062c\u0645\u0627\u0644\u0627\u062d\u0645\u0631|\u0633\u0631\u0641\u064a\u0646\u0627\u0632\u0641\u064a\u0632\u062f\u0627|redstar(?:belgrade)?|crvenazvezda)$/i.test(s)) {
    return "redstarbelgrade";
  }
  if (/^(?:\u063a\u0644\u0637\u0647\u0633\u0631\u0627\u064a|\u062c\u0627\u0644\u0627\u062a\u0627\u0633\u0631\u0627\u064a|galatasaray)$/i.test(s)) {
    return "galatasaray";
  }
  if (
    /^(?:\u064a\u0627\u063a\u064a\u0644\u0648\u0646\u064a\u0627\u0628\u064a\u0627\u0648\u064a\u0633\u062a\u0648\u0643|\u064a\u0627\u063a\u064a\u0644\u0648\u0646\u064a\u0627\u0628\u064a\u0627\u0648\u064a\u0633\u062a\u0648\u0643|\u062c\u0627\u063a\u064a\u0644\u0648\u0646\u064a\u0627\u0628\u064a\u0627\u0644\u064a\u0633\u062a\u0648\u0643|\u062c\u0627\u062c\u064a\u0644\u0648\u0646\u064a\u0627\u0628\u064a\u0627\u0644\u064a\u0633\u062a\u0648\u0643|\u0628\u064a\u0627\u0644\u064a\u0633\u062a\u0648\u0643|\u0628\u064a\u0627\u0648\u064a\u0633\u062a\u0648\u0643|jagiellonia(?:bialystok)?|bialystok)$/i.test(
      s
    )
  ) {
    return "jagielloniabialystok";
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

function areSiblingKickoffsClose(left: MatchStatusRow, right: MatchStatusRow) {
  const leftMs = matchStartMs(left.match_start);
  const rightMs = matchStartMs(right.match_start);
  if (leftMs === null || rightMs === null) return true;
  return Math.abs(leftMs - rightMs) <= DUPLICATE_SIBLING_START_WINDOW_MS;
}

function extractDayKeyFromRow(row: MatchStatusRow) {
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

function countPresentStreams(row: MatchStatusRow) {
  const urls = [row.stream_url, row.stream_url_2, row.stream_url_3, row.stream_url_4];
  return urls.reduce((n, u) => (/^https?:\/\//i.test(String(u || "")) ? n + 1 : n), 0);
}

function mergeMissingStreams(base: MatchStatusRow, donor: MatchStatusRow) {
  const next: MatchStatusRow = { ...base };
  if (!/^https?:\/\//i.test(String(next.stream_url || "")) && /^https?:\/\//i.test(String(donor.stream_url || ""))) next.stream_url = donor.stream_url;
  if (!/^https?:\/\//i.test(String(next.stream_url_2 || "")) && /^https?:\/\//i.test(String(donor.stream_url_2 || ""))) next.stream_url_2 = donor.stream_url_2;
  if (!/^https?:\/\//i.test(String(next.stream_url_3 || "")) && /^https?:\/\//i.test(String(donor.stream_url_3 || ""))) next.stream_url_3 = donor.stream_url_3;
  if (!/^https?:\/\//i.test(String(next.stream_url_4 || "")) && /^https?:\/\//i.test(String(donor.stream_url_4 || ""))) next.stream_url_4 = donor.stream_url_4;
  if (!next.match_start && donor.match_start) next.match_start = donor.match_start;
  if (!next.match_day && donor.match_day) next.match_day = donor.match_day;
  if (!next.status_key && donor.status_key) next.status_key = donor.status_key;
  return next;
}

async function fetchStatusRowsByDayKey(dayKey: string) {
  const safeDayKey = String(dayKey || "").trim();
  if (!/^\d{4}-\d{2}-\d{2}$/.test(safeDayKey)) return [] as MatchStatusRow[];
  const { data, error } = await supabaseAdmin
    .from("match-stream-app")
    .select("id,match_key,home_team,away_team,match_start,match_day,status_key,stream_url,stream_url_2,stream_url_3,stream_url_4")
    .like("match_key", `${safeDayKey}||%`)
    .limit(300);
  if (error || !Array.isArray(data)) return [] as MatchStatusRow[];
  return data as MatchStatusRow[];
}

async function enrichStatusRowWithDuplicateSiblingStreams(row: MatchStatusRow) {
  const currentPair = buildUnorderedTeamPairKey(row.home_team, row.away_team);
  const currentLoosePair = buildUnorderedTeamPairKey(row.home_team, row.away_team, { stripGeo: true });
  if (!currentPair && !currentLoosePair) return row;
  const sameDayRows = await fetchStatusRowsByDayKey(extractDayKeyFromRow(row));
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

async function fetchMatchStatusRow(matchId: number) {
  const { data, error } = await supabaseAdmin
    .from("match-stream-app")
    .select("id,match_key,home_team,away_team,match_start,match_day,status_key,stream_url,stream_url_2,stream_url_3,stream_url_4")
    .eq("id", matchId)
    .maybeSingle();
  const enriched = data ? await enrichStatusRowWithDuplicateSiblingStreams(data as MatchStatusRow) : null;
  return {
    data: (enriched || null) as MatchStatusRow | null,
    error: (error || null) as { message?: string } | null,
  };
}

export async function GET(req: Request) {
  const url = new URL(req.url);
  const matchId = toInt(url.searchParams.get("matchId"));
  if (!Number.isFinite(matchId) || matchId <= 0) {
    return NextResponse.json({ ok: false, error: "invalid-match-id" }, { status: 400 });
  }

  const { data: row, error } = await fetchMatchStatusRow(matchId);
  if (error) return NextResponse.json({ ok: false, error: String(error.message || "db-error") }, { status: 500 });
  if (!row) return NextResponse.json({ ok: false, error: "match-not-found" }, { status: 404 });

  const mode = getServerStreamMode();
  const repackFlags = getRuntimeRepackFlags();
  const r2Status = await buildMatchR2Status({
    mode,
    matchId,
    row,
    repackBaseUrl: repackFlags.publicBaseUrl,
  });

  return NextResponse.json({
    ok: true,
    mode,
    matchId,
    r2Status,
    seedRuntime: listRepackSeedRuntimeStateForMatch(matchId),
  });
}
