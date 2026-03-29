import { bootstrapR2MirrorAgent, readR2MirrorAgentStatus } from "@/lib/r2-mirror-agent";
import type { LivekoraMatchRow } from "@/lib/livekora-match";
import type { YallashootAgentStatus, YallashootStatus } from "@/lib/yallashoot-types";
import { maybeBuildYouTubeFallbackStatus } from "@/lib/youtube-fallback";

function nowIso() {
  return new Date().toISOString();
}

export function buildYallashootPublicPlaylistUrl(matchId: number, publicBaseUrl?: string) {
  if (!Number.isFinite(matchId) || matchId <= 0) return null;
  const base =
    String(publicBaseUrl || process.env.LIVEKORA_R2_PUBLIC_BASE_URL || "https://r2.tf-player.site/live")
      .trim()
      .replace(/\/+$/, "");
  if (!base) return null;
  return `${base}/yallashoot/m${matchId}/index.m3u8`;
}

export async function readYallashootAgentStatus(matchId: number) {
  return (await readR2MirrorAgentStatus("yallashoot", matchId)) as YallashootAgentStatus | null;
}

export async function bootstrapYallashootAgent(input: {
  matchId: number;
  sourceUrl: string;
  ingestUrl: string;
}) {
  return await bootstrapR2MirrorAgent({
    provider: "yallashoot",
    publicPathPrefix: "yallashoot",
    matchId: input.matchId,
    sourceUrl: input.sourceUrl,
    ingestUrl: input.ingestUrl,
  });
}

export async function buildYallashootStatus(input: {
  matchId: number;
  row?: LivekoraMatchRow | null;
  sourceUrl: string | null;
  agentStatus?: YallashootAgentStatus | null;
}) {
  const sourceUrl = String(input.sourceUrl || "").trim() || null;
  if (!sourceUrl) {
    return {
      provider: "yallashoot",
      mode: "r2",
      matchId: input.matchId,
      sourceUrl: null,
      state: "down",
      playlistUrl: null,
      reason: "missing-source",
      currentSource: null,
      updatedAt: nowIso(),
      label: "yalla-shoot",
      order: 4,
      phase: null,
      progressPct: 0,
    } satisfies YallashootStatus;
  }

  const agentStatus =
    input.agentStatus === undefined ? await readYallashootAgentStatus(input.matchId) : input.agentStatus;
  if (!agentStatus) {
    const youtubeFallback = await maybeBuildYouTubeFallbackStatus({
      provider: "yallashoot",
      label: "yalla-shoot",
      order: 4,
      matchId: input.matchId,
      sourceUrl,
      reason: "agent-unreachable",
      updatedAt: nowIso(),
    });
    if (youtubeFallback) {
      return youtubeFallback satisfies YallashootStatus;
    }
    return {
      provider: "yallashoot",
      mode: "r2",
      matchId: input.matchId,
      sourceUrl,
      state: "down",
      playlistUrl: null,
      reason: "agent-unreachable",
      currentSource: null,
      updatedAt: nowIso(),
      label: "yalla-shoot",
      order: 4,
      phase: "failed",
      progressPct: 0,
    } satisfies YallashootStatus;
  }

  if (agentStatus.state !== "ready") {
    const youtubeFallback = await maybeBuildYouTubeFallbackStatus({
      provider: "yallashoot",
      label: "yalla-shoot",
      order: 4,
      matchId: input.matchId,
      sourceUrl,
      currentSource: agentStatus.currentSource || null,
      reason: agentStatus.reason || null,
      updatedAt: agentStatus.updatedAt || nowIso(),
    });
    if (youtubeFallback) {
      return youtubeFallback satisfies YallashootStatus;
    }
  }

  const playlistUrl =
    agentStatus.state === "ready" ? agentStatus.playlistUrl || buildYallashootPublicPlaylistUrl(input.matchId) : null;
  return {
    provider: "yallashoot",
    mode: "r2",
    matchId: input.matchId,
    sourceUrl,
    state: agentStatus.exists ? agentStatus.state : "down",
    playlistUrl,
    reason: agentStatus.reason || (agentStatus.exists ? "unknown" : "not-bootstrapped"),
    currentSource: agentStatus.currentSource || null,
    updatedAt: agentStatus.updatedAt || nowIso(),
    label: "yalla-shoot",
    order: 4,
    phase: agentStatus.phase || (agentStatus.exists ? null : "queued"),
    progressPct: agentStatus.progressPct ?? (agentStatus.exists ? null : 0),
  } satisfies YallashootStatus;
}
