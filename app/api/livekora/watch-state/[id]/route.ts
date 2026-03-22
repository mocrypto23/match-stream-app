import { NextResponse } from "next/server";

import { buildBeinliveStatus } from "@/lib/beinlive-agent";
import { buildLivekoraStatus } from "@/lib/livekora-agent";
import { readAllR2MirrorAgentStatuses } from "@/lib/r2-mirror-agent";
import { buildSiiirStatus } from "@/lib/siiir-agent";
import type { StreamProviderId, StreamSourceStatus } from "@/lib/stream-source-types";
import { getOrLoadHotWatchStateSeed } from "@/lib/watch-state-cache";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

type Ctx = { params: Promise<{ id?: string }> };

function hasProviderSource(status: StreamSourceStatus | null, sourceUrl: string | null) {
  return !!String(status?.sourceUrl || status?.currentSource || status?.playlistUrl || sourceUrl || "").trim();
}

function buildWatchStateVersion(statuses: StreamSourceStatus[], sourceUrls: Record<StreamProviderId, string | null>) {
  return statuses
    .map((status) =>
      [
        status.provider,
        status.state,
        status.reason,
        status.currentSource || "",
        status.playlistUrl || "",
        status.updatedAt || "",
        sourceUrls[status.provider] || "",
      ].join("::")
    )
    .join("||");
}

function latestUpdatedAt(statuses: StreamSourceStatus[], seedUpdatedAt: string) {
  const times = statuses
    .map((item) => Date.parse(String(item.updatedAt || "").trim()))
    .filter((value) => Number.isFinite(value)) as number[];
  const seedTime = Date.parse(seedUpdatedAt);
  if (Number.isFinite(seedTime)) times.push(seedTime);
  if (!times.length) return new Date().toISOString();
  return new Date(Math.max(...times)).toISOString();
}

export async function GET(_req: Request, ctx: Ctx) {
  const { id: rawId } = await ctx.params;
  const matchId = Number.parseInt(String(rawId || "").trim(), 10);
  if (!Number.isFinite(matchId) || matchId <= 0) {
    return NextResponse.json({ error: "invalid-match-id" }, { status: 400 });
  }

  const { seed, row, error } = await getOrLoadHotWatchStateSeed(matchId);
  if (error) {
    return NextResponse.json({ error: String(error.message || "db-error") }, { status: 500 });
  }
  if (!seed) {
    return NextResponse.json({ error: "match-not-found" }, { status: 404 });
  }

  const agentStatuses = await readAllR2MirrorAgentStatuses(matchId);
  const safeRow = row || null;
  const [livekoraStatus, beinliveStatus, siiirStatus] = await Promise.all([
    buildLivekoraStatus({
      matchId,
      row: safeRow,
      sourceUrl: seed.sourceUrls.livekora,
      agentStatus: agentStatuses?.livekora || null,
    }),
    buildBeinliveStatus({
      matchId,
      row: safeRow,
      sourceUrl: seed.sourceUrls.beinlive,
      agentStatus: agentStatuses?.beinlive || null,
    }),
    buildSiiirStatus({
      matchId,
      row: safeRow,
      sourceUrl: seed.sourceUrls.siiir,
      agentStatus: agentStatuses?.siiir || null,
    }),
  ]);

  const statuses = [livekoraStatus, beinliveStatus, siiirStatus].sort((left, right) => left.order - right.order);
  const updatedAt = latestUpdatedAt(statuses, seed.updatedAt);
  const response = NextResponse.json({
    matchId,
    stream_url: seed.sourceUrls.beinlive,
    stream_url_2: seed.sourceUrls.siiir,
    stream_url_4: seed.sourceUrls.livekora,
    livekoraStatus,
    beinliveStatus,
    siiirStatus,
    streamSources: statuses,
    providerHasMatchById: {
      livekora: hasProviderSource(livekoraStatus, seed.sourceUrls.livekora),
      beinlive: hasProviderSource(beinliveStatus, seed.sourceUrls.beinlive),
      siiir: hasProviderSource(siiirStatus, seed.sourceUrls.siiir),
    },
    updatedAt,
    version: buildWatchStateVersion(statuses, seed.sourceUrls),
  });
  response.headers.set("Cache-Control", "public, s-maxage=1, stale-while-revalidate=2");
  return response;
}
