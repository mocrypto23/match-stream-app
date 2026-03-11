import { NextResponse } from "next/server";

import { getUiServerIdForSlotServer, type SlotServerId } from "@/lib/server-source-policy";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

type SeedPayload = {
  matchId?: number;
  serverId?: number;
};

function toInt(raw: unknown) {
  const n = Number.parseInt(String(raw ?? ""), 10);
  return Number.isFinite(n) ? n : NaN;
}

function isSlotServerId(value: number): value is SlotServerId {
  return value === 1 || value === 2 || value === 3 || value === 4;
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
  if (!Number.isFinite(matchId) || matchId <= 0 || !Number.isFinite(serverId) || !isSlotServerId(serverId)) {
    return NextResponse.json({ ok: false, error: "invalid-input" }, { status: 400 });
  }

  const bootstrapUrl = new URL("/api/repack/bootstrap", req.url).toString();
  const uiServer = getUiServerIdForSlotServer(serverId);
  try {
    const upstream = await fetch(bootstrapUrl, {
      method: "POST",
      cache: "no-store",
      headers: {
        "content-type": "application/json",
      },
      body: JSON.stringify({
        matchId,
        uiServers: [uiServer],
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
        error: "repack-bootstrap-unreachable",
        detail: message,
      },
      { status: 503 }
    );
  }
}
