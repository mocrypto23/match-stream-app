import { NextResponse } from "next/server";

import { buildLivekoraStatus } from "@/lib/livekora-agent";
import { fetchLivekoraMatchRow } from "@/lib/livekora-match";
import { pickLivekoraSourceUrl } from "@/lib/live-providers";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

type Ctx = { params: Promise<{ id?: string }> };

export async function GET(_req: Request, ctx: Ctx) {
  const { id: rawId } = await ctx.params;
  const matchId = Number.parseInt(String(rawId || "").trim(), 10);
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

  const sourceUrl = pickLivekoraSourceUrl(data);
  const livekoraStatus = await buildLivekoraStatus({
    matchId,
    row: data,
    sourceUrl,
  });

  const response = NextResponse.json({
    id: data.id,
    match_key: data.match_key || null,
    home_team: data.home_team || null,
    away_team: data.away_team || null,
    home_logo: data.home_logo || null,
    away_logo: data.away_logo || null,
    match_start: data.match_start || null,
    match_day: data.match_day || null,
    status_key: data.status_key || null,
    stream_url_4: sourceUrl,
    livekoraStatus,
    livekoraPlaylistUrl: livekoraStatus.playlistUrl,
  });
  response.headers.set("Cache-Control", "public, s-maxage=6, stale-while-revalidate=20");
  return response;
}
