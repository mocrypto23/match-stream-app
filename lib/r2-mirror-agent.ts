import type { StreamAgentStatus, StreamProviderId } from "@/lib/stream-source-types";

const R2_AGENT_BIND = String(process.env.LIVEKORA_R2_AGENT_BIND || "127.0.0.1").trim() || "127.0.0.1";
const R2_AGENT_PORT = Number.parseInt(String(process.env.LIVEKORA_R2_AGENT_PORT || "3500"), 10) || 3500;

function localAgentUrl(pathname: string) {
  return `http://${R2_AGENT_BIND}:${R2_AGENT_PORT}${pathname}`;
}

export async function readR2MirrorAgentStatus(provider: StreamProviderId, matchId: number) {
  const controller = new AbortController();
  const timeoutId = setTimeout(() => controller.abort(), 1800);
  try {
    const url = new URL(localAgentUrl("/status"));
    url.searchParams.set("providerId", provider);
    url.searchParams.set("matchId", String(matchId));
    const response = await fetch(url, {
      method: "GET",
      cache: "no-store",
      signal: controller.signal,
    });
    if (!response.ok) return null;
    return (await response.json().catch(() => null)) as StreamAgentStatus | null;
  } catch {
    return null;
  } finally {
    clearTimeout(timeoutId);
  }
}

export async function bootstrapR2MirrorAgent(input: {
  provider: StreamProviderId;
  publicPathPrefix: string;
  matchId: number;
  sourceUrl: string;
  ingestUrl: string;
}) {
  const controller = new AbortController();
  const timeoutId = setTimeout(() => controller.abort(), 4_500);
  try {
    const response = await fetch(localAgentUrl("/bootstrap"), {
      method: "POST",
      cache: "no-store",
      signal: controller.signal,
      headers: {
        "content-type": "application/json",
      },
      body: JSON.stringify({
        providerId: input.provider,
        publicPathPrefix: input.publicPathPrefix,
        matchId: input.matchId,
        sourceUrl: input.sourceUrl,
        ingestUrl: input.ingestUrl,
      }),
    });
    const payload = (await response.json().catch(() => null)) as
      | {
          accepted?: boolean;
          status?: StreamAgentStatus | null;
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
    const fallbackStatus = await readR2MirrorAgentStatus(input.provider, input.matchId);
    if (fallbackStatus?.exists) {
      return {
        ok: true,
        accepted: true,
        status: fallbackStatus,
        reason: fallbackStatus.reason || "accepted",
      };
    }
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
