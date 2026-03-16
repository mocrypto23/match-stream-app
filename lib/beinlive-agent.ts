import { buildBeinlivePublicPlaylistUrl } from "@/lib/beinlive-provider";
import { bootstrapR2MirrorAgent, readR2MirrorAgentStatus } from "@/lib/r2-mirror-agent";
import type { BeinliveAgentStatus, BeinliveStatus } from "@/lib/beinlive-types";
import type { LivekoraMatchRow } from "@/lib/livekora-match";

function nowIso() {
  return new Date().toISOString();
}

export async function readBeinliveAgentStatus(matchId: number) {
  return (await readR2MirrorAgentStatus("beinlive", matchId)) as BeinliveAgentStatus | null;
}

export async function bootstrapBeinliveAgent(input: {
  matchId: number;
  sourceUrl: string;
  ingestUrl: string;
}) {
  return await bootstrapR2MirrorAgent({
    provider: "beinlive",
    publicPathPrefix: "beinlive",
    matchId: input.matchId,
    sourceUrl: input.sourceUrl,
    ingestUrl: input.ingestUrl,
  });
}

export async function buildBeinliveStatus(input: {
  matchId: number;
  row: LivekoraMatchRow;
  sourceUrl: string | null;
}) {
  const sourceUrl = String(input.sourceUrl || "").trim() || null;
  if (!sourceUrl) {
    return {
      provider: "beinlive",
      mode: "r2",
      matchId: input.matchId,
      sourceUrl: null,
      state: "down",
      playlistUrl: null,
      reason: "missing-source",
      currentSource: null,
      updatedAt: nowIso(),
      label: "bein-live",
      order: 2,
      phase: null,
      progressPct: 0,
    } satisfies BeinliveStatus;
  }

  const agentStatus = await readBeinliveAgentStatus(input.matchId);
  if (!agentStatus) {
    return {
      provider: "beinlive",
      mode: "r2",
      matchId: input.matchId,
      sourceUrl,
      state: "down",
      playlistUrl: null,
      reason: "agent-unreachable",
      currentSource: null,
      updatedAt: nowIso(),
      label: "bein-live",
      order: 2,
      phase: "failed",
      progressPct: 0,
    } satisfies BeinliveStatus;
  }

  const playlistUrl =
    agentStatus.state === "ready"
      ? agentStatus.playlistUrl || buildBeinlivePublicPlaylistUrl(input.matchId)
      : null;
  return {
    provider: "beinlive",
    mode: "r2",
    matchId: input.matchId,
    sourceUrl,
    state: agentStatus.exists ? agentStatus.state : "down",
    playlistUrl,
    reason: agentStatus.reason || (agentStatus.exists ? "unknown" : "not-bootstrapped"),
    currentSource: agentStatus.currentSource || null,
    updatedAt: agentStatus.updatedAt || nowIso(),
    label: "bein-live",
    order: 2,
    phase: agentStatus.phase || (agentStatus.exists ? null : "queued"),
    progressPct: agentStatus.progressPct ?? (agentStatus.exists ? null : 0),
  } satisfies BeinliveStatus;
}
