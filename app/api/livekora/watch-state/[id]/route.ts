import { NextResponse } from "next/server";

import { buildWatchStateResponse } from "@/lib/watch-state-response";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

type Ctx = { params: Promise<{ id?: string }> };

export async function GET(req: Request, ctx: Ctx) {
  const { id: rawId } = await ctx.params;
  const matchId = Number.parseInt(String(rawId || "").trim(), 10);
  if (!Number.isFinite(matchId) || matchId <= 0) {
    return NextResponse.json({ error: "invalid-match-id" }, { status: 400 });
  }

  return buildWatchStateResponse(req, matchId);
}
