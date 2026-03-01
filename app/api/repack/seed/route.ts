import { NextResponse } from "next/server";

import { getRuntimeRepackFlags } from "@/lib/repack-flags";
import { getServerCapability } from "@/lib/server-capabilities";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

type SeedPayload = {
  matchId?: number;
  serverId?: number;
  sourceUrl?: string;
  sourceCandidate?: string;
  matchStatus?: string | null;
  viewerSessionId?: string | null;
};

function toInt(raw: unknown) {
  const n = Number.parseInt(String(raw ?? ""), 10);
  return Number.isFinite(n) ? n : NaN;
}

function localAgentUrl(pathname: string) {
  const port = Number.parseInt(String(process.env.REPACK_AGENT_PORT || "3400"), 10) || 3400;
  const bind = String(process.env.REPACK_AGENT_BIND || "127.0.0.1").trim() || "127.0.0.1";
  return `http://${bind}:${port}${pathname}`;
}

async function readJson(req: Request) {
  try {
    return (await req.json()) as SeedPayload;
  } catch {
    return {} as SeedPayload;
  }
}

export async function POST(req: Request) {
  const payload = await readJson(req);
  const matchId = toInt(payload.matchId);
  const serverId = toInt(payload.serverId);
  if (!Number.isFinite(matchId) || matchId <= 0 || !Number.isFinite(serverId) || serverId <= 0) {
    return NextResponse.json({ ok: false, error: "invalid-input" }, { status: 400 });
  }

  const capability = getServerCapability(serverId);
  if (!capability?.repackEligible) {
    return NextResponse.json({ ok: false, skipped: true, reason: "server-not-eligible" }, { status: 202 });
  }

  const flags = getRuntimeRepackFlags();
  if (!flags.enabled) {
    return NextResponse.json({ ok: false, skipped: true, reason: "repack-disabled" }, { status: 202 });
  }
  if (!flags.repackServers.has(serverId) || flags.forceDisableServers.has(serverId)) {
    return NextResponse.json({ ok: false, skipped: true, reason: "server-flag-disabled" }, { status: 202 });
  }

  const controller = new AbortController();
  const timeoutId = setTimeout(() => controller.abort(), 2800);
  try {
    const upstream = await fetch(localAgentUrl("/seed"), {
      method: "POST",
      cache: "no-store",
      signal: controller.signal,
      headers: {
        "content-type": "application/json",
      },
      body: JSON.stringify({
        matchId,
        serverId,
        sourceUrl: String(payload.sourceUrl || ""),
        sourceCandidate: String(payload.sourceCandidate || ""),
        matchStatus: String(payload.matchStatus || ""),
        viewerSessionId: String(payload.viewerSessionId || ""),
      }),
    });
    const text = await upstream.text();
    let parsed: unknown = null;
    try {
      parsed = text ? JSON.parse(text) : null;
    } catch {
      parsed = { raw: text };
    }
    return NextResponse.json(
      {
        ok: upstream.ok,
        repackAgentStatus: upstream.status,
        result: parsed,
      },
      { status: upstream.ok ? 200 : 502 }
    );
  } catch (error: unknown) {
    const message = error instanceof Error ? error.message : String(error);
    return NextResponse.json(
      {
        ok: false,
        error: "repack-agent-unreachable",
        detail: message,
      },
      { status: 503 }
    );
  } finally {
    clearTimeout(timeoutId);
  }
}

