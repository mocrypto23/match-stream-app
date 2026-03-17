import { NextResponse } from "next/server";

import { buildBeinliveStatus } from "@/lib/beinlive-agent";
import { buildLivekoraStatus } from "@/lib/livekora-agent";
import { fetchLivekoraMatchRow } from "@/lib/livekora-match";
import { buildSiiirStatus } from "@/lib/siiir-agent";
import { beinliveProvider } from "@/lib/beinlive-provider";
import { livekoraProvider } from "@/lib/live-providers";
import { siiirProvider } from "@/lib/siiir-provider";
import { resolveProviderSourceUrl } from "@/lib/stream-provider-registry";

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

  const [sourceUrl, beinliveSourceUrl, siiirSourceUrl] = await Promise.all([
    resolveProviderSourceUrl(livekoraProvider, data),
    resolveProviderSourceUrl(beinliveProvider, data),
    resolveProviderSourceUrl(siiirProvider, data),
  ]);

  const [livekoraStatus, beinliveStatus, siiirStatus] = await Promise.all([
    buildLivekoraStatus({
      matchId,
      row: data,
      sourceUrl,
    }),
    buildBeinliveStatus({
      matchId,
      row: data,
      sourceUrl: beinliveSourceUrl,
    }),
    buildSiiirStatus({
      matchId,
      row: data,
      sourceUrl: siiirSourceUrl,
    }),
  ]);
  const streamSources = [livekoraStatus, beinliveStatus, siiirStatus].sort((left, right) => left.order - right.order);

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
    stream_url: beinliveSourceUrl,
    stream_url_2: siiirSourceUrl,
    stream_url_4: sourceUrl,
    livekoraStatus,
    livekoraPlaylistUrl: livekoraStatus.playlistUrl,
    beinliveStatus,
    beinlivePlaylistUrl: beinliveStatus.playlistUrl,
    siiirStatus,
    siiirPlaylistUrl: siiirStatus.playlistUrl,
    streamSources,
  });
  response.headers.set("Cache-Control", "public, s-maxage=6, stale-while-revalidate=20");
  return response;
}
