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

type BootstrapRequest = {
  matchId?: number;
  uiServers?: number[];
};

type MatchSeedRow = {
  id: number;
  match_start?: string | null;
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

function localAgentUrl(pathname: string) {
  const port = Number.parseInt(String(process.env.REPACK_AGENT_PORT || "3400"), 10) || 3400;
  const bind = String(process.env.REPACK_AGENT_BIND || "127.0.0.1").trim() || "127.0.0.1";
  return `http://${bind}:${port}${pathname}`;
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
    .select("id,match_start,status_key,stream_url,stream_url_2,stream_url_3,stream_url_4")
    .eq("id", matchId)
    .maybeSingle();
  return {
    data: (data || null) as MatchSeedRow | null,
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

function buildIngestHeaders(sourceUrl: string) {
  const referer = isValidHttpUrl(sourceUrl) ? sourceUrl : "";
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
  const requestOrigin = (() => {
    try {
      return new URL(req.url).origin;
    } catch {
      return "";
    }
  })();

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
    const sourceUrl = String(getSlotSourceUrlFromRow(row, slotServer) || "").trim();

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
      requestOrigin,
      referrerUrl: sourceUrl,
      timeoutMs: Number.parseInt(String(process.env.REPACK_RESOLVE_TIMEOUT_MS || "8000"), 10) || 8000,
      maxCandidates: Number.parseInt(String(process.env.REPACK_RESOLVE_MAX_CANDIDATES || "16"), 10) || 16,
    });

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

    const upstream = await postSeedToAgent({
      matchId,
      serverId: slotServer,
      sourceUrl,
      sourceCandidate: ingest.ingestUrl,
      ingestUrl: ingest.ingestUrl,
      ingestMode: ingest.mode,
      ingestVerified: ingest.resolver.resolverState === "ok",
      ingestHeaders: buildIngestHeaders(sourceUrl),
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
