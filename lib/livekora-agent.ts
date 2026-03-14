import { buildLivekoraPublicPlaylistUrl } from "@/lib/live-providers";
import type { LivekoraAgentStatus, LivekoraStatus } from "@/lib/livekora-types";
import type { LivekoraMatchRow } from "@/lib/livekora-match";

const LIVEKORA_AGENT_BIND = String(process.env.LIVEKORA_R2_AGENT_BIND || "127.0.0.1").trim() || "127.0.0.1";
const LIVEKORA_AGENT_PORT = Number.parseInt(String(process.env.LIVEKORA_R2_AGENT_PORT || "3500"), 10) || 3500;

function nowIso() {
  return new Date().toISOString();
}

function localAgentUrl(pathname: string) {
  return `http://${LIVEKORA_AGENT_BIND}:${LIVEKORA_AGENT_PORT}${pathname}`;
}

export async function readLivekoraAgentStatus(matchId: number) {
  const controller = new AbortController();
  const timeoutId = setTimeout(() => controller.abort(), 1800);
  try {
    const response = await fetch(localAgentUrl(`/status?matchId=${encodeURIComponent(String(matchId))}`), {
      method: "GET",
      cache: "no-store",
      signal: controller.signal,
    });
    if (!response.ok) return null;
    return (await response.json().catch(() => null)) as LivekoraAgentStatus | null;
  } catch {
    return null;
  } finally {
    clearTimeout(timeoutId);
  }
}

export async function bootstrapLivekoraAgent(input: {
  matchId: number;
  sourceUrl: string;
  ingestUrl: string;
}) {
  const controller = new AbortController();
  const timeoutId = setTimeout(() => controller.abort(), 12_000);
  try {
    const response = await fetch(localAgentUrl("/bootstrap"), {
      method: "POST",
      cache: "no-store",
      signal: controller.signal,
      headers: {
        "content-type": "application/json",
      },
      body: JSON.stringify(input),
    });
    const payload = (await response.json().catch(() => null)) as
      | {
          accepted?: boolean;
          status?: LivekoraAgentStatus | null;
          reason?: string;
        }
      | null;
    return {
      ok: response.ok,
      accepted: !!payload?.accepted,
      status: payload?.status || null,
      reason: String(payload?.reason || (!response.ok ? `agent-http-${response.status}` : "")).trim() || null,
    };
  } catch (error) {
    return {
      ok: false,
      accepted: false,
      status: null,
      reason: error instanceof Error ? error.message : String(error || "agent-unreachable"),
    };
  } finally {
    clearTimeout(timeoutId);
  }
}

export async function buildLivekoraStatus(input: {
  matchId: number;
  row: LivekoraMatchRow;
  sourceUrl: string | null;
}) {
  const sourceUrl = String(input.sourceUrl || "").trim() || null;
  if (!sourceUrl) {
    return {
      provider: "livekora",
      mode: "livekora_r2",
      matchId: input.matchId,
      sourceUrl: null,
      state: "down",
      playlistUrl: null,
      reason: "missing-source",
      currentSource: null,
      updatedAt: nowIso(),
    } satisfies LivekoraStatus;
  }

  const agentStatus = await readLivekoraAgentStatus(input.matchId);
  if (!agentStatus) {
    return {
      provider: "livekora",
      mode: "livekora_r2",
      matchId: input.matchId,
      sourceUrl,
      state: "down",
      playlistUrl: null,
      reason: "agent-unreachable",
      currentSource: null,
      updatedAt: nowIso(),
    } satisfies LivekoraStatus;
  }

  const playlistUrl =
    agentStatus.state === "ready"
      ? agentStatus.playlistUrl || buildLivekoraPublicPlaylistUrl(input.matchId)
      : null;
  return {
    provider: "livekora",
    mode: "livekora_r2",
    matchId: input.matchId,
    sourceUrl,
    state: agentStatus.exists ? agentStatus.state : "down",
    playlistUrl,
    reason: agentStatus.reason || (agentStatus.exists ? "unknown" : "not-bootstrapped"),
    currentSource: agentStatus.currentSource || null,
    updatedAt: agentStatus.updatedAt || nowIso(),
  } satisfies LivekoraStatus;
}
