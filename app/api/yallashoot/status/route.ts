import { NextResponse } from "next/server";

import { fetchLivekoraMatchRow } from "@/lib/livekora-match";
import { protectClientStatus } from "@/lib/playback-session";
import { resolveProviderSourceUrl } from "@/lib/stream-provider-registry";
import { buildYallashootStatus } from "@/lib/yallashoot-agent";
import { yallashootProvider } from "@/lib/yallashoot-provider";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function GET(req: Request) {
  const url = new URL(req.url);
  const matchId = Number.parseInt(String(url.searchParams.get("matchId") || "").trim(), 10);
  if (!Number.isFinite(matchId) || matchId <= 0) {
    return NextResponse.json({ error: "invalid-match-id" }, { status: 400 });
  }

  const { data, error } = await fetchLivekoraMatchRow(matchId);
  if (error) {
    return NextResponse.json({ error: String(error.message || "db-error") }, { status: 500 });
  }
  if (!data) {
    return NextResponse.json({ error: "match-not-found" }, { status: 404 });
  }

  const status = await buildYallashootStatus({
    matchId,
    row: data,
    sourceUrl: await resolveProviderSourceUrl(yallashootProvider, data),
  });
  return NextResponse.json({ yallashootStatus: protectClientStatus(status) }, { headers: { "Cache-Control": "no-store" } });
}
