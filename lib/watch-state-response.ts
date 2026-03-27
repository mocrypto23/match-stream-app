import { createHash } from "node:crypto";

import { NextResponse } from "next/server";

import { buildBeinliveStatus } from "@/lib/beinlive-agent";
import { buildLivekoraStatus } from "@/lib/livekora-agent";
import { protectClientStatus } from "@/lib/playback-session";
import { readAllR2MirrorAgentStatuses } from "@/lib/r2-mirror-agent";
import { buildSiiirStatus } from "@/lib/siiir-agent";
import { buildYallashootStatus } from "@/lib/yallashoot-agent";
import type { StreamProviderId, StreamSourceStatus } from "@/lib/stream-source-types";
import { getOrLoadHotWatchStateSeed } from "@/lib/watch-state-cache";

type SourceUrlMap = Record<StreamProviderId, string | null>;

export type HotWatchStatePayload = {
  matchId: number;
  stream_url?: string | null;
  stream_url_2?: string | null;
  stream_url_5?: string | null;
  stream_url_4?: string | null;
  livekoraStatus?: StreamSourceStatus | null;
  beinliveStatus?: StreamSourceStatus | null;
  siiirStatus?: StreamSourceStatus | null;
  yallashootStatus?: StreamSourceStatus | null;
  updatedAt?: string | null;
  version?: string | null;
};

function buildWatchStateVersion(statuses: StreamSourceStatus[], sourceUrls: SourceUrlMap) {
  return statuses
    .map((status) =>
      [
        status.provider,
        status.state,
        status.phase || "",
        String(status.progressPct ?? ""),
        status.reason,
        status.currentSource || "",
        status.playlistUrl || "",
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

function createWatchStateEtag(version: string) {
  return `"${createHash("sha1").update(version).digest("hex")}"`;
}

function ifNoneMatchIncludes(ifNoneMatch: string | null, etag: string) {
  if (!ifNoneMatch) return false;
  return ifNoneMatch
    .split(",")
    .map((value) => value.trim())
    .some((value) => value === etag || value === `W/${etag}`);
}

function applyWatchStateHeaders(response: NextResponse, etag: string) {
  response.headers.set("Cache-Control", "public, s-maxage=1, stale-while-revalidate=2");
  response.headers.set("ETag", etag);
  return response;
}

export async function buildWatchStateResponse(req: Request, matchId: number) {
  const { seed, row, error } = await getOrLoadHotWatchStateSeed(matchId);
  if (error) {
    return NextResponse.json({ error: String(error.message || "db-error") }, { status: 500 });
  }
  if (!seed) {
    return NextResponse.json({ error: "match-not-found" }, { status: 404 });
  }

  const agentStatuses = await readAllR2MirrorAgentStatuses(matchId);
  const safeRow = row || null;
  const [livekoraStatus, beinliveStatus, siiirStatus, yallashootStatus] = await Promise.all([
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
    buildYallashootStatus({
      matchId,
      row: safeRow,
      sourceUrl: seed.sourceUrls.yallashoot,
      agentStatus: agentStatuses?.yallashoot || null,
    }),
  ]);

  const statuses = [livekoraStatus, beinliveStatus, siiirStatus, yallashootStatus].sort(
    (left, right) => left.order - right.order
  );
  const updatedAt = latestUpdatedAt(statuses, seed.updatedAt);
  const version = buildWatchStateVersion(statuses, seed.sourceUrls);
  const etag = createWatchStateEtag(version);

  if (ifNoneMatchIncludes(req.headers.get("if-none-match"), etag)) {
    return applyWatchStateHeaders(new NextResponse(null, { status: 304 }), etag);
  }

  const protectedLivekoraStatus = protectClientStatus(livekoraStatus);
  const protectedBeinliveStatus = protectClientStatus(beinliveStatus);
  const protectedSiiirStatus = protectClientStatus(siiirStatus);
  const protectedYallashootStatus = protectClientStatus(yallashootStatus);

  const payload: HotWatchStatePayload = {
    matchId,
    stream_url: seed.sourceUrls.beinlive,
    stream_url_2: seed.sourceUrls.siiir,
    stream_url_5: seed.sourceUrls.yallashoot,
    stream_url_4: seed.sourceUrls.livekora,
    livekoraStatus: protectedLivekoraStatus,
    beinliveStatus: protectedBeinliveStatus,
    siiirStatus: protectedSiiirStatus,
    yallashootStatus: protectedYallashootStatus,
    updatedAt,
    version,
  };

  return applyWatchStateHeaders(NextResponse.json(payload), etag);
}
