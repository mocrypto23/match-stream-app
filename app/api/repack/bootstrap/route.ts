import { NextResponse } from "next/server";
import { supabaseAdmin } from "../../_supabase";
import { getRuntimeRepackFlags } from "@/lib/repack-flags";
import { buildMatchR2Status } from "@/lib/r2-status";
import {
  noteRepackBootstrapOutcome,
  noteRepackBootstrapRequest,
  setRepackSeedRuntimeState,
  type RepackResolverState,
} from "@/lib/repack-runtime-state";
import {
  UI_SERVER_IDS,
  getSlotServerIdForUiServer,
  getSlotSourceUrlFromRow,
  isIngestCandidateAlignedWithSlotServer,
  isAllowedSourceForSlotServer,
  isValidHttpUrl,
  type SlotServerId,
  type UiServerId,
} from "@/lib/server-source-policy";
import { getServerCapability } from "@/lib/server-capabilities";
import { getServerStreamMode } from "@/lib/stream-mode";
import {
  resolveRepackIngestUrl,
  type RepackIngestMode,
  type RepackIngestResolverDiag,
  type RepackIngestResolution,
} from "@/lib/repack-ingest-resolver";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";
const DEFAULT_INGEST_USER_AGENT =
  "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/141.0.0.0 Safari/537.36";
const DUPLICATE_SIBLING_START_WINDOW_MS = 6 * 60 * 60 * 1000;

type BootstrapRequest = {
  matchId?: number;
  uiServers?: number[];
};

type MatchSeedRow = {
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

type ResolverSummary = RepackIngestResolverDiag;

type BootstrapServerResult = {
  uiServer: UiServerId;
  slotServer: SlotServerId;
  accepted: boolean;
  reason: string;
  statusCode: number;
  sourceUrl: string | null;
  resolver: ResolverSummary;
  ingest: {
    mode: RepackIngestMode;
    reason: string;
    ingestUrl: string | null;
  };
  probeEvidence: RepackIngestResolution["probeEvidence"];
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

function areSiblingKickoffsClose(left: MatchSeedRow, right: MatchSeedRow) {
  const leftMs = matchStartMs(left.match_start);
  const rightMs = matchStartMs(right.match_start);
  if (leftMs === null || rightMs === null) return true;
  return Math.abs(leftMs - rightMs) <= DUPLICATE_SIBLING_START_WINDOW_MS;
}

function extractDayKeyFromRow(row: MatchSeedRow) {
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

function countPresentStreams(row: MatchSeedRow) {
  const urls = [row.stream_url, row.stream_url_2, row.stream_url_3, row.stream_url_4];
  return urls.reduce((n, u) => (isValidHttpUrl(u) ? n + 1 : n), 0);
}

function mergeMissingStreams(base: MatchSeedRow, donor: MatchSeedRow) {
  const next: MatchSeedRow = { ...base };
  if (!isValidHttpUrl(next.stream_url) && isValidHttpUrl(donor.stream_url)) next.stream_url = donor.stream_url;
  if (!isValidHttpUrl(next.stream_url_2) && isValidHttpUrl(donor.stream_url_2)) next.stream_url_2 = donor.stream_url_2;
  if (!isValidHttpUrl(next.stream_url_3) && isValidHttpUrl(donor.stream_url_3)) next.stream_url_3 = donor.stream_url_3;
  if (!isValidHttpUrl(next.stream_url_4) && isValidHttpUrl(donor.stream_url_4)) next.stream_url_4 = donor.stream_url_4;
  if (!next.match_start && donor.match_start) next.match_start = donor.match_start;
  if (!next.match_day && donor.match_day) next.match_day = donor.match_day;
  if (!next.status_key && donor.status_key) next.status_key = donor.status_key;
  return next;
}

async function fetchSeedRowsByDayKey(dayKey: string) {
  const safeDayKey = String(dayKey || "").trim();
  if (!/^\d{4}-\d{2}-\d{2}$/.test(safeDayKey)) return [] as MatchSeedRow[];
  const { data, error } = await supabaseAdmin
    .from("match-stream-app")
    .select("id,match_key,home_team,away_team,match_start,match_day,status_key,stream_url,stream_url_2,stream_url_3,stream_url_4")
    .like("match_key", `${safeDayKey}||%`)
    .limit(300);
  if (error || !Array.isArray(data)) return [] as MatchSeedRow[];
  return data as MatchSeedRow[];
}

async function enrichSeedRowWithDuplicateSiblingStreams(row: MatchSeedRow) {
  const currentPair = buildUnorderedTeamPairKey(row.home_team, row.away_team);
  const currentLoosePair = buildUnorderedTeamPairKey(row.home_team, row.away_team, { stripGeo: true });
  if (!currentPair && !currentLoosePair) return row;
  const sameDayRows = await fetchSeedRowsByDayKey(extractDayKeyFromRow(row));
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

async function maybeHydrateSlotSourceUrl(slotServer: SlotServerId, rawSourceUrl: string) {
  const sourceUrl = String(rawSourceUrl || "").trim();
  if (!sourceUrl || !isValidHttpUrl(sourceUrl)) return sourceUrl;
  if (slotServer !== 1) return sourceUrl;

  let isBeinMatchPage = false;
  try {
    const u = new URL(sourceUrl);
    const host = u.hostname.toLowerCase();
    const pathname = String(u.pathname || "").toLowerCase();
    isBeinMatchPage = (host === "bein-live.com" || host.endsWith(".bein-live.com")) && pathname.includes("/matches/");
  } catch {}
  if (!isBeinMatchPage) return sourceUrl;

  // Keep bein rows anchored to the original match page. Jumping early to an embedded
  // alba/player host makes the slot look like it is borrowing another family and loses
  // the strongest referrer/origin context that the downstream resolver/proxy needs.
  return sourceUrl;
}

function localAgentUrl(pathname: string) {
  const port = Number.parseInt(String(process.env.REPACK_AGENT_PORT || "3400"), 10) || 3400;
  const bind = String(process.env.REPACK_AGENT_BIND || "127.0.0.1").trim() || "127.0.0.1";
  return `http://${bind}:${port}${pathname}`;
}

function resolveInternalPlayerOrigin(req: Request) {
  const configuredInternal = String(
    process.env.REPACK_INTERNAL_PLAYER_ORIGIN || process.env.INTERNAL_APP_ORIGIN || ""
  ).trim();
  if (configuredInternal && isValidHttpUrl(configuredInternal)) return configuredInternal.replace(/\/+$/, "");

  const appPort = Number.parseInt(String(process.env.PORT || "3000"), 10) || 3000;
  const localhostOrigin = `http://127.0.0.1:${appPort}`;
  if (isValidHttpUrl(localhostOrigin)) return localhostOrigin;

  const configuredPublic = String(process.env.REPACK_PLAYER_ORIGIN || "").trim();
  if (configuredPublic && isValidHttpUrl(configuredPublic)) return configuredPublic.replace(/\/+$/, "");

  try {
    const reqOrigin = new URL(req.url).origin;
    if (isValidHttpUrl(reqOrigin)) return reqOrigin.replace(/\/+$/, "");
  } catch {}

  return "";
}

async function readJson(req: Request) {
  try {
    return (await req.json()) as BootstrapRequest;
  } catch {
    return {} as BootstrapRequest;
  }
}

function sanitizeUiServers(raw: unknown) {
  const values = Array.isArray(raw) ? raw : [];
  const accepted = new Set<UiServerId>();
  for (const item of values) {
    const n = Number.parseInt(String(item), 10);
    if (n === 1 || n === 2 || n === 3 || n === 4) accepted.add(n);
  }
  return accepted.size ? Array.from(accepted) : [...UI_SERVER_IDS];
}

function fallbackResolver(reason: string, resolverState: RepackResolverState = "unknown"): ResolverSummary {
  return {
    stage: "done",
    candidatesFound: 0,
    candidatesProbed: 0,
    selectedCandidate: null,
    selectedKind: "none",
    rejectReason: reason,
    resolverState,
  };
}

async function fetchMatchSeedRow(matchId: number) {
  const { data, error } = await supabaseAdmin
    .from("match-stream-app")
    .select("id,match_key,home_team,away_team,match_start,match_day,status_key,stream_url,stream_url_2,stream_url_3,stream_url_4")
    .eq("id", matchId)
    .maybeSingle();
  const enriched = data ? await enrichSeedRowWithDuplicateSiblingStreams(data as MatchSeedRow) : null;
  return {
    data: (enriched || null) as MatchSeedRow | null,
    error: (error || null) as { message?: string } | null,
  };
}

async function postSeedToAgent(payload: {
  matchId: number;
  serverId: number;
  sourceUrl: string;
  sourceCandidate: string;
  ingestUrl: string;
  ingestMode: RepackIngestMode;
  ingestVerified: boolean;
  ingestHeaders: {
    referer?: string;
    origin?: string;
    "user-agent"?: string;
  };
  probeEvidence: RepackIngestResolution["probeEvidence"];
  matchStatus: string;
  matchStart: string;
}) {
  const controller = new AbortController();
  const timeoutId = setTimeout(() => controller.abort(), 3400);
  try {
    const upstream = await fetch(localAgentUrl("/seed"), {
      method: "POST",
      cache: "no-store",
      signal: controller.signal,
      headers: {
        "content-type": "application/json",
      },
      body: JSON.stringify(payload),
    });
    const text = await upstream.text();
    let parsed: unknown = null;
    try {
      parsed = text ? JSON.parse(text) : null;
    } catch {
      parsed = { raw: text };
    }
    return {
      ok: upstream.ok,
      status: upstream.status,
      body: parsed as Record<string, unknown> | null,
    };
  } catch (error: unknown) {
    const message = error instanceof Error ? error.message : String(error);
    return {
      ok: false,
      status: 503,
      body: {
        accepted: false,
        reason: "repack-agent-unreachable",
        error: message,
      } as Record<string, unknown>,
    };
  } finally {
    clearTimeout(timeoutId);
  }
}

function extractEmbedProxyReferrer(rawUrl: string) {
  if (!isValidHttpUrl(rawUrl)) return "";
  try {
    const u = new URL(rawUrl);
    if (!String(u.pathname || "").toLowerCase().includes("/api/embed-proxy")) return "";
    const ref = String(u.searchParams.get("ref") || "").trim();
    if (isValidHttpUrl(ref)) return ref;
    const target = String(u.searchParams.get("url") || "").trim();
    if (isValidHttpUrl(target)) return target;
    return "";
  } catch {
    return "";
  }
}

function buildIngestHeaders(input: {
  sourceUrl: string;
  ingestUrl: string;
  probePlaylistUrl?: string | null;
  probeReferrerUrl?: string | null;
}) {
  const referer =
    [
      isValidHttpUrl(String(input.probeReferrerUrl || "").trim()) ? String(input.probeReferrerUrl || "").trim() : "",
      isValidHttpUrl(String(input.probePlaylistUrl || "").trim()) ? String(input.probePlaylistUrl || "").trim() : "",
      extractEmbedProxyReferrer(input.ingestUrl),
      isValidHttpUrl(input.sourceUrl) ? input.sourceUrl : "",
    ].find(Boolean) || "";
  const origin = (() => {
    if (!referer) return "";
    try {
      return new URL(referer).origin;
    } catch {
      return "";
    }
  })();
  return {
    referer: referer || undefined,
    origin: origin || undefined,
    "user-agent": DEFAULT_INGEST_USER_AGENT,
  };
}

export async function POST(req: Request) {
  noteRepackBootstrapRequest();
  const payload = await readJson(req);
  const matchId = toInt(payload.matchId);
  if (!Number.isFinite(matchId) || matchId <= 0) {
    return NextResponse.json({ ok: false, error: "invalid-match-id" }, { status: 400 });
  }
  const resolverRequestOrigin = resolveInternalPlayerOrigin(req);

  const mode = getServerStreamMode();
  const repackFlags = getRuntimeRepackFlags();
  const { data: row, error } = await fetchMatchSeedRow(matchId);
  if (error) return NextResponse.json({ ok: false, error: String(error.message || "db-error") }, { status: 500 });
  if (!row) return NextResponse.json({ ok: false, error: "match-not-found" }, { status: 404 });

  const uiServers = sanitizeUiServers(payload.uiServers);
  const results: BootstrapServerResult[] = [];

  const pushResult = (input: BootstrapServerResult) => {
    const resolverState = input.resolver.resolverState || "unknown";
    const resolveReason = String(input.resolver.rejectReason || input.ingest.reason || input.reason || "unknown").trim();
    setRepackSeedRuntimeState(matchId, input.slotServer, {
      accepted: input.accepted,
      reason: String(input.reason || "unknown").trim() || "unknown",
      statusCode: Number(input.statusCode || 0),
      resolverState,
      resolveReason,
      ingestMode: String(input.ingest.mode || "none"),
      ingestUrl: input.ingest.ingestUrl || null,
    });
    noteRepackBootstrapOutcome({
      accepted: input.accepted,
      reason: input.reason,
      resolverState,
    });
    results.push(input);
  };

  for (const uiServer of uiServers) {
    const slotServer = getSlotServerIdForUiServer(uiServer);
    const rawSourceUrl = String(getSlotSourceUrlFromRow(row, slotServer) || "").trim();
    const sourceUrl = await maybeHydrateSlotSourceUrl(slotServer, rawSourceUrl);

    if (mode !== "r2_strict") {
      pushResult({
        uiServer,
        slotServer,
        accepted: false,
        reason: "mode-not-r2-strict",
        statusCode: 202,
        sourceUrl: sourceUrl || null,
        resolver: fallbackResolver("mode-not-r2-strict"),
        ingest: {
          mode: "none",
          reason: "mode-not-r2-strict",
          ingestUrl: null,
        },
        probeEvidence: null,
      });
      continue;
    }

    if (!sourceUrl || !isValidHttpUrl(sourceUrl)) {
      pushResult({
        uiServer,
        slotServer,
        accepted: false,
        reason: "missing-source",
        statusCode: 202,
        sourceUrl: sourceUrl || null,
        resolver: fallbackResolver("missing-source", "missing-source"),
        ingest: {
          mode: "none",
          reason: "missing-source",
          ingestUrl: null,
        },
        probeEvidence: null,
      });
      continue;
    }

    if (!isAllowedSourceForSlotServer(slotServer, sourceUrl)) {
      pushResult({
        uiServer,
        slotServer,
        accepted: false,
        reason: "source-not-allowed",
        statusCode: 202,
        sourceUrl,
        resolver: fallbackResolver("source-not-allowed"),
        ingest: {
          mode: "none",
          reason: "source-not-allowed",
          ingestUrl: null,
        },
        probeEvidence: null,
      });
      continue;
    }

    const capability = getServerCapability(slotServer);
    if (!capability?.repackEligible) {
      pushResult({
        uiServer,
        slotServer,
        accepted: false,
        reason: "server-not-eligible",
        statusCode: 202,
        sourceUrl,
        resolver: fallbackResolver("server-not-eligible"),
        ingest: {
          mode: "none",
          reason: "server-not-eligible",
          ingestUrl: null,
        },
        probeEvidence: null,
      });
      continue;
    }

    if (!repackFlags.enabled) {
      pushResult({
        uiServer,
        slotServer,
        accepted: false,
        reason: "repack-disabled",
        statusCode: 202,
        sourceUrl,
        resolver: fallbackResolver("repack-disabled"),
        ingest: {
          mode: "none",
          reason: "repack-disabled",
          ingestUrl: null,
        },
        probeEvidence: null,
      });
      continue;
    }

    if (!repackFlags.repackServers.has(slotServer) || repackFlags.forceDisableServers.has(slotServer)) {
      pushResult({
        uiServer,
        slotServer,
        accepted: false,
        reason: "server-flag-disabled",
        statusCode: 202,
        sourceUrl,
        resolver: fallbackResolver("server-flag-disabled"),
        ingest: {
          mode: "none",
          reason: "server-flag-disabled",
          ingestUrl: null,
        },
        probeEvidence: null,
      });
      continue;
    }

    const ingest = await resolveRepackIngestUrl({
      sourceUrl,
      requestOrigin: resolverRequestOrigin,
      referrerUrl: sourceUrl,
      timeoutMs: Math.max(8000, Number.parseInt(String(process.env.REPACK_RESOLVE_TIMEOUT_MS || "10000"), 10) || 10000),
      maxCandidates: Math.min(
        24,
        Math.max(16, Number.parseInt(String(process.env.REPACK_RESOLVE_MAX_CANDIDATES || "16"), 10) || 16)
      ),
      allowCandidate: ({ candidateUrl, referrerUrl }) =>
        isIngestCandidateAlignedWithSlotServer({
          slotServerId: slotServer,
          sourceUrl,
          ingestUrl: candidateUrl,
          probeReferrerUrl: referrerUrl,
          probePlaylistUrl: candidateUrl,
        }),
    });

    if (ingest.resolver.resolverState !== "ok") {
      const rejectReason = `invalid-ingest-url:${ingest.reason}`;
      pushResult({
        uiServer,
        slotServer,
        accepted: false,
        reason: rejectReason,
        statusCode: 202,
        sourceUrl,
        resolver: ingest.resolver,
        ingest: {
          mode: ingest.mode,
          reason: ingest.reason,
          ingestUrl: ingest.ingestUrl || null,
        },
        probeEvidence: ingest.probeEvidence,
      });
      continue;
    }

    if (!ingest.ingestUrl || !isValidHttpUrl(ingest.ingestUrl)) {
      const rejectReason = `invalid-ingest-url:${ingest.reason}`;
      pushResult({
        uiServer,
        slotServer,
        accepted: false,
        reason: rejectReason,
        statusCode: 202,
        sourceUrl,
        resolver: ingest.resolver,
        ingest: {
          mode: ingest.mode,
          reason: ingest.reason,
          ingestUrl: ingest.ingestUrl || null,
        },
        probeEvidence: ingest.probeEvidence,
      });
      continue;
    }

    const alignedIngest = isIngestCandidateAlignedWithSlotServer({
      slotServerId: slotServer,
      sourceUrl,
      ingestUrl: ingest.ingestUrl,
      probeReferrerUrl: ingest.probeEvidence?.referrerUrl || null,
      probePlaylistUrl: ingest.probeEvidence?.playlistUrl || null,
    });
    if (!alignedIngest) {
      pushResult({
        uiServer,
        slotServer,
        accepted: false,
        reason: "ingest-source-mismatch",
        statusCode: 202,
        sourceUrl,
        resolver: {
          ...ingest.resolver,
          rejectReason: "ingest-source-mismatch",
          resolverState: "probe-failed",
        },
        ingest: {
          mode: ingest.mode,
          reason: "ingest-source-mismatch",
          ingestUrl: ingest.ingestUrl,
        },
        probeEvidence: ingest.probeEvidence,
      });
      continue;
    }

    const upstream = await postSeedToAgent({
      matchId,
      serverId: slotServer,
      sourceUrl,
      sourceCandidate: ingest.ingestUrl,
      ingestUrl: ingest.ingestUrl,
      ingestMode: ingest.mode,
      ingestVerified: ingest.resolver.resolverState === "ok",
      ingestHeaders: buildIngestHeaders({
        sourceUrl,
        ingestUrl: ingest.ingestUrl,
        probePlaylistUrl: ingest.probeEvidence?.playlistUrl || null,
        probeReferrerUrl: ingest.probeEvidence?.referrerUrl || null,
      }),
      probeEvidence: ingest.probeEvidence,
      matchStatus: String(row.status_key || ""),
      matchStart: String(row.match_start || ""),
    });

    const accepted = Boolean(upstream.body?.accepted);
    const reason = String(upstream.body?.reason || (accepted ? "ok" : "seed-rejected"));

    pushResult({
      uiServer,
      slotServer,
      accepted,
      reason,
      statusCode: upstream.status,
      sourceUrl,
      resolver: ingest.resolver,
      ingest: {
        mode: ingest.mode,
        reason: ingest.reason,
        ingestUrl: ingest.ingestUrl,
      },
      probeEvidence: ingest.probeEvidence,
    });
  }

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
    results,
    r2Status,
  });
}
