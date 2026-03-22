import { bootstrapR2MirrorAgent, readR2MirrorAgentStatus } from "@/lib/r2-mirror-agent";
import type { LivekoraMatchRow } from "@/lib/livekora-match";
import type { SiiirAgentStatus, SiiirStatus } from "@/lib/siiir-types";

function nowIso() {
  return new Date().toISOString();
}

export function buildSiiirPublicPlaylistUrl(matchId: number, publicBaseUrl?: string) {
  if (!Number.isFinite(matchId) || matchId <= 0) return null;
  const base =
    String(publicBaseUrl || process.env.LIVEKORA_R2_PUBLIC_BASE_URL || "https://r2.tf-player.site/live")
      .trim()
      .replace(/\/+$/, "");
  if (!base) return null;
  return `${base}/siiir/m${matchId}/index.m3u8`;
}

export async function readSiiirAgentStatus(matchId: number) {
  return (await readR2MirrorAgentStatus("siiir", matchId)) as SiiirAgentStatus | null;
}

export async function bootstrapSiiirAgent(input: {
  matchId: number;
  sourceUrl: string;
  ingestUrl: string;
}) {
  return await bootstrapR2MirrorAgent({
    provider: "siiir",
    publicPathPrefix: "siiir",
    matchId: input.matchId,
    sourceUrl: input.sourceUrl,
    ingestUrl: input.ingestUrl,
  });
}

export async function buildSiiirStatus(input: {
  matchId: number;
  row?: LivekoraMatchRow | null;
  sourceUrl: string | null;
  agentStatus?: SiiirAgentStatus | null;
}) {
  const sourceUrl = String(input.sourceUrl || "").trim() || null;
  if (!sourceUrl) {
    return {
      provider: "siiir",
      mode: "r2",
      matchId: input.matchId,
      sourceUrl: null,
      state: "down",
      playlistUrl: null,
      reason: "missing-source",
      currentSource: null,
      updatedAt: nowIso(),
      label: "siiir.tv",
      order: 3,
      phase: null,
      progressPct: 0,
    } satisfies SiiirStatus;
  }

  const agentStatus = input.agentStatus === undefined ? await readSiiirAgentStatus(input.matchId) : input.agentStatus;
  if (!agentStatus) {
    return {
      provider: "siiir",
      mode: "r2",
      matchId: input.matchId,
      sourceUrl,
      state: "down",
      playlistUrl: null,
      reason: "agent-unreachable",
      currentSource: null,
      updatedAt: nowIso(),
      label: "siiir.tv",
      order: 3,
      phase: "failed",
      progressPct: 0,
    } satisfies SiiirStatus;
  }

  const playlistUrl =
    agentStatus.state === "ready" ? agentStatus.playlistUrl || buildSiiirPublicPlaylistUrl(input.matchId) : null;
  return {
    provider: "siiir",
    mode: "r2",
    matchId: input.matchId,
    sourceUrl,
    state: agentStatus.exists ? agentStatus.state : "down",
    playlistUrl,
    reason: agentStatus.reason || (agentStatus.exists ? "unknown" : "not-bootstrapped"),
    currentSource: agentStatus.currentSource || null,
    updatedAt: agentStatus.updatedAt || nowIso(),
    label: "siiir.tv",
    order: 3,
    phase: agentStatus.phase || (agentStatus.exists ? null : "queued"),
    progressPct: agentStatus.progressPct ?? (agentStatus.exists ? null : 0),
  } satisfies SiiirStatus;
}
