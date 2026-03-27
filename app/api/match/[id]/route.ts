import { NextResponse } from "next/server";

import { buildBeinliveStatus } from "@/lib/beinlive-agent";
import { buildLivekoraStatus } from "@/lib/livekora-agent";
import { fetchLivekoraMatchRow } from "@/lib/livekora-match";
import { readAllR2MirrorAgentStatuses } from "@/lib/r2-mirror-agent";
import { buildSiiirStatus } from "@/lib/siiir-agent";
import { buildYallashootStatus } from "@/lib/yallashoot-agent";
import { buildClientPlaybackUrl, protectClientStatus } from "@/lib/playback-session";
import { getOrLoadHotWatchStateSeed } from "@/lib/watch-state-cache";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

type Ctx = { params: Promise<{ id?: string }> };

export async function GET(_req: Request, ctx: Ctx) {
  const { id: rawId } = await ctx.params;
  const matchId = Number.parseInt(String(rawId || "").trim(), 10);
  if (!Number.isFinite(matchId) || matchId <= 0) {
    return NextResponse.json({ error: "invalid-match-id" }, { status: 400 });
  }

  const { seed, row: seededRow, error } = await getOrLoadHotWatchStateSeed(matchId);
  if (error) {
    return NextResponse.json({ error: String(error.message || "db-error") }, { status: 500 });
  }
  if (!seed) {
    return NextResponse.json({ error: "match-not-found" }, { status: 404 });
  }
  const data = seededRow || (await fetchLivekoraMatchRow(matchId)).data;
  if (!data) {
    return NextResponse.json({ error: "match-not-found" }, { status: 404 });
  }
  const sourceUrl = seed.sourceUrls.livekora;
  const beinliveSourceUrl = seed.sourceUrls.beinlive;
  const siiirSourceUrl = seed.sourceUrls.siiir;
  const yallashootSourceUrl = seed.sourceUrls.yallashoot;

  const agentStatuses = await readAllR2MirrorAgentStatuses(matchId);

  const [livekoraStatus, beinliveStatus, siiirStatus, yallashootStatus] = await Promise.all([
    buildLivekoraStatus({
      matchId,
      row: data,
      sourceUrl,
      agentStatus: agentStatuses?.livekora || null,
    }),
    buildBeinliveStatus({
      matchId,
      row: data,
      sourceUrl: beinliveSourceUrl,
      agentStatus: agentStatuses?.beinlive || null,
    }),
    buildSiiirStatus({
      matchId,
      row: data,
      sourceUrl: siiirSourceUrl,
      agentStatus: agentStatuses?.siiir || null,
    }),
    buildYallashootStatus({
      matchId,
      row: data,
      sourceUrl: yallashootSourceUrl,
      agentStatus: agentStatuses?.yallashoot || null,
    }),
  ]);
  const protectedLivekoraStatus = protectClientStatus(livekoraStatus);
  const protectedBeinliveStatus = protectClientStatus(beinliveStatus);
  const protectedSiiirStatus = protectClientStatus(siiirStatus);
  const protectedYallashootStatus = protectClientStatus(yallashootStatus);
  const streamSources = [protectedLivekoraStatus, protectedBeinliveStatus, protectedSiiirStatus, protectedYallashootStatus]
    .filter(Boolean)
    .sort((left, right) => Number(left?.order || 0) - Number(right?.order || 0));

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
    stream_url_5: yallashootSourceUrl,
    stream_url_4: sourceUrl,
    livekoraStatus: protectedLivekoraStatus,
    livekoraPlaylistUrl: buildClientPlaybackUrl("livekora", matchId, !!String(livekoraStatus.playlistUrl || "").trim()),
    beinliveStatus: protectedBeinliveStatus,
    beinlivePlaylistUrl: buildClientPlaybackUrl("beinlive", matchId, !!String(beinliveStatus.playlistUrl || "").trim()),
    siiirStatus: protectedSiiirStatus,
    siiirPlaylistUrl: buildClientPlaybackUrl("siiir", matchId, !!String(siiirStatus.playlistUrl || "").trim()),
    yallashootStatus: protectedYallashootStatus,
    yallashootPlaylistUrl: buildClientPlaybackUrl(
      "yallashoot",
      matchId,
      !!String(yallashootStatus.playlistUrl || "").trim()
    ),
    streamSources,
  });
  response.headers.set("Cache-Control", "public, s-maxage=6, stale-while-revalidate=20");
  return response;
}
