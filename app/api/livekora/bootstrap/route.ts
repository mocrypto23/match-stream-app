import { NextResponse } from "next/server";

import { bootstrapLivekoraAgent, buildLivekoraStatus } from "@/lib/livekora-agent";
import { runBootstrapSingleflight } from "@/lib/bootstrap-singleflight";
import { buildLivekoraSessionManifestUrl, resolveInternalAppOrigin } from "@/lib/live-providers";
import { getOrLoadHotWatchStateSeed } from "@/lib/watch-state-cache";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function POST(req: Request) {
  const body = (await req.json().catch(() => null)) as { matchId?: number } | null;
  const matchId = Number.parseInt(String(body?.matchId ?? "").trim(), 10);
  if (!Number.isFinite(matchId) || matchId <= 0) {
    return NextResponse.json({ accepted: false, error: "invalid-match-id" }, { status: 400 });
  }

  const { seed, error } = await getOrLoadHotWatchStateSeed(matchId);
  if (error) {
    return NextResponse.json({ accepted: false, error: String(error.message || "db-error") }, { status: 500 });
  }
  if (!seed) {
    return NextResponse.json({ accepted: false, error: "match-not-found" }, { status: 404 });
  }

  const sourceUrl = String(seed.sourceUrls.livekora || "").trim() || null;
  if (!sourceUrl) {
    const livekoraStatus = await buildLivekoraStatus({ matchId, row: null, sourceUrl: null });
    return NextResponse.json({ accepted: false, livekoraStatus }, { status: 409 });
  }

  const livekoraStatusBefore = await buildLivekoraStatus({
    matchId,
    row: null,
    sourceUrl,
  });
  if (
    String(livekoraStatusBefore.sourceUrl || "").trim() === sourceUrl &&
    (livekoraStatusBefore.state === "ready" || livekoraStatusBefore.state === "warming")
  ) {
    return NextResponse.json(
      {
        accepted: true,
        reason: "already-bootstrapped",
        livekoraStatus: livekoraStatusBefore,
      },
      { status: 200, headers: { "Cache-Control": "no-store" } }
    );
  }

  const internalOrigin = resolveInternalAppOrigin(req);
  const ingestUrl = buildLivekoraSessionManifestUrl(matchId, internalOrigin);
  const bootstrapped = await runBootstrapSingleflight("livekora", matchId, async () => {
    return await bootstrapLivekoraAgent({
      matchId,
      sourceUrl,
      ingestUrl,
    });
  });

  const livekoraStatus = await buildLivekoraStatus({
    matchId,
    row: null,
    sourceUrl,
  });
  return NextResponse.json(
    {
      accepted: bootstrapped.accepted,
      reason: bootstrapped.reason,
      livekoraStatus,
    },
    { status: bootstrapped.ok ? 200 : 502, headers: { "Cache-Control": "no-store" } }
  );
}
