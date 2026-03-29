import { buildLivekoraPublicPlaylistUrl } from "@/lib/live-providers";
import { bootstrapR2MirrorAgent, readR2MirrorAgentStatus } from "@/lib/r2-mirror-agent";
import type { LivekoraAgentStatus, LivekoraStatus } from "@/lib/livekora-types";
import type { LivekoraMatchRow } from "@/lib/livekora-match";
import { maybeBuildYouTubeFallbackStatus } from "@/lib/youtube-fallback";

function nowIso() {
  return new Date().toISOString();
}

export async function readLivekoraAgentStatus(matchId: number) {
  return (await readR2MirrorAgentStatus("livekora", matchId)) as LivekoraAgentStatus | null;
}

export async function bootstrapLivekoraAgent(input: {
  matchId: number;
  sourceUrl: string;
  ingestUrl: string;
}) {
  return await bootstrapR2MirrorAgent({
    provider: "livekora",
    publicPathPrefix: "livekora",
    matchId: input.matchId,
    sourceUrl: input.sourceUrl,
    ingestUrl: input.ingestUrl,
  });
}

export async function buildLivekoraStatus(input: {
  matchId: number;
  row?: LivekoraMatchRow | null;
  sourceUrl: string | null;
  agentStatus?: LivekoraAgentStatus | null;
}) {
  const sourceUrl = String(input.sourceUrl || "").trim() || null;
  if (!sourceUrl) {
    return {
      provider: "livekora",
      mode: "r2",
      matchId: input.matchId,
      sourceUrl: null,
      state: "down",
      playlistUrl: null,
      reason: "missing-source",
      currentSource: null,
      updatedAt: nowIso(),
      label: "livekora vip",
      order: 1,
      phase: null,
      progressPct: 0,
    } satisfies LivekoraStatus;
  }

  const agentStatus = input.agentStatus === undefined ? await readLivekoraAgentStatus(input.matchId) : input.agentStatus;
  if (!agentStatus) {
    const youtubeFallback = await maybeBuildYouTubeFallbackStatus({
      provider: "livekora",
      label: "livekora vip",
      order: 1,
      matchId: input.matchId,
      sourceUrl,
      reason: "agent-unreachable",
      updatedAt: nowIso(),
    });
    if (youtubeFallback) {
      return youtubeFallback satisfies LivekoraStatus;
    }
    return {
      provider: "livekora",
      mode: "r2",
      matchId: input.matchId,
      sourceUrl,
      state: "down",
      playlistUrl: null,
      reason: "agent-unreachable",
      currentSource: null,
      updatedAt: nowIso(),
      label: "livekora vip",
      order: 1,
      phase: "failed",
      progressPct: 0,
    } satisfies LivekoraStatus;
  }

  if (agentStatus.state !== "ready") {
    const youtubeFallback = await maybeBuildYouTubeFallbackStatus({
      provider: "livekora",
      label: "livekora vip",
      order: 1,
      matchId: input.matchId,
      sourceUrl,
      currentSource: agentStatus.currentSource || null,
      reason: agentStatus.reason || null,
      updatedAt: agentStatus.updatedAt || nowIso(),
    });
    if (youtubeFallback) {
      return youtubeFallback satisfies LivekoraStatus;
    }
  }

  const playlistUrl =
    agentStatus.state === "ready"
      ? agentStatus.playlistUrl || buildLivekoraPublicPlaylistUrl(input.matchId)
      : null;
  return {
    provider: "livekora",
    mode: "r2",
    matchId: input.matchId,
    sourceUrl,
    state: agentStatus.exists ? agentStatus.state : "down",
    playlistUrl,
    reason: agentStatus.reason || (agentStatus.exists ? "unknown" : "not-bootstrapped"),
    currentSource: agentStatus.currentSource || null,
    updatedAt: agentStatus.updatedAt || nowIso(),
    label: "livekora vip",
    order: 1,
    phase: agentStatus.phase || (agentStatus.exists ? null : "queued"),
    progressPct: agentStatus.progressPct ?? (agentStatus.exists ? null : 0),
  } satisfies LivekoraStatus;
}
