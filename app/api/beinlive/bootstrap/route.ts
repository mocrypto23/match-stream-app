import { NextResponse } from "next/server";

import { bootstrapBeinliveAgent, buildBeinliveStatus } from "@/lib/beinlive-agent";
import { runBootstrapSingleflight } from "@/lib/bootstrap-singleflight";
import { beinliveProvider, buildBeinliveSessionManifestUrl } from "@/lib/beinlive-provider";
import { resolveInternalAppOrigin } from "@/lib/live-providers";
import { getMatchStreamWindowFromSeed } from "@/lib/match-stream-window";
import { protectClientStatus } from "@/lib/playback-session";
import { resolveProviderSourceUrl } from "@/lib/stream-provider-registry";
import { getOrLoadHotWatchStateSeed } from "@/lib/watch-state-cache";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function POST(req: Request) {
  const body = (await req.json().catch(() => null)) as { matchId?: number } | null;
  const matchId = Number.parseInt(String(body?.matchId ?? "").trim(), 10);
  if (!Number.isFinite(matchId) || matchId <= 0) {
    return NextResponse.json({ accepted: false, error: "invalid-match-id" }, { status: 400 });
  }

  const { seed, row, error } = await getOrLoadHotWatchStateSeed(matchId);
  if (error) {
    return NextResponse.json({ accepted: false, error: String(error.message || "db-error") }, { status: 500 });
  }
  if (!seed) {
    return NextResponse.json({ accepted: false, error: "match-not-found" }, { status: 404 });
  }

  const streamWindow = getMatchStreamWindowFromSeed(seed);
  if (!streamWindow.canOpen) {
    return NextResponse.json(
      {
        accepted: false,
        reason: "scheduled-not-open",
        opensAt: streamWindow.opensAtMs ? new Date(streamWindow.opensAtMs).toISOString() : null,
        msUntilOpen: streamWindow.msUntilOpen,
      },
      { status: 409, headers: { "Cache-Control": "no-store" } },
    );
  }

  const sourceUrl =
    String(seed.sourceUrls.beinlive || "").trim() ||
    (row ? String(await resolveProviderSourceUrl(beinliveProvider, row) || "").trim() : "");
  if (!sourceUrl) {
    const beinliveStatus = await buildBeinliveStatus({ matchId, row: null, sourceUrl: null });
    return NextResponse.json({ accepted: false, beinliveStatus: protectClientStatus(beinliveStatus) }, { status: 409 });
  }

  const beinliveStatusBefore = await buildBeinliveStatus({
    matchId,
    row: null,
    sourceUrl,
  });
  if (beinliveStatusBefore.reason === "missing-source") {
    return NextResponse.json(
      {
        accepted: false,
        reason: "missing-source",
        beinliveStatus: protectClientStatus(beinliveStatusBefore),
      },
      { status: 409, headers: { "Cache-Control": "no-store" } }
    );
  }
  if (
    String(beinliveStatusBefore.sourceUrl || "").trim() === sourceUrl &&
    (beinliveStatusBefore.state === "ready" || beinliveStatusBefore.state === "warming")
  ) {
    return NextResponse.json(
      {
        accepted: true,
        reason: "already-bootstrapped",
        beinliveStatus: protectClientStatus(beinliveStatusBefore),
      },
      { status: 200, headers: { "Cache-Control": "no-store" } }
    );
  }

  const internalOrigin = resolveInternalAppOrigin(req);
  const ingestUrl = buildBeinliveSessionManifestUrl(matchId, internalOrigin);
  const bootstrapped = await runBootstrapSingleflight("beinlive", matchId, async () => {
    return await bootstrapBeinliveAgent({
      matchId,
      sourceUrl,
      ingestUrl,
    });
  });

  const beinliveStatus = await buildBeinliveStatus({
    matchId,
    row: null,
    sourceUrl,
  });
  return NextResponse.json(
    {
      accepted: bootstrapped.accepted,
      reason: bootstrapped.reason,
      beinliveStatus: protectClientStatus(beinliveStatus),
    },
    { status: bootstrapped.ok ? 200 : 502, headers: { "Cache-Control": "no-store" } }
  );
}
