import { NextResponse } from "next/server";

import { runBootstrapSingleflight } from "@/lib/bootstrap-singleflight";
import { resolveInternalAppOrigin } from "@/lib/live-providers";
import { getMatchStreamWindowFromSeed } from "@/lib/match-stream-window";
import { protectClientStatus } from "@/lib/playback-session";
import { resolveProviderSourceUrl } from "@/lib/stream-provider-registry";
import { getOrLoadHotWatchStateSeed } from "@/lib/watch-state-cache";
import { buildYallashootStatus, bootstrapYallashootAgent } from "@/lib/yallashoot-agent";
import { buildYallashootSessionManifestUrl, yallashootProvider } from "@/lib/yallashoot-provider";

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
    String(seed.sourceUrls.yallashoot || "").trim() ||
    (row ? String((await resolveProviderSourceUrl(yallashootProvider, row)) || "").trim() : "");
  if (!sourceUrl) {
    const yallashootStatus = await buildYallashootStatus({ matchId, row: null, sourceUrl: null });
    return NextResponse.json({ accepted: false, yallashootStatus: protectClientStatus(yallashootStatus) }, { status: 409 });
  }

  const statusBefore = await buildYallashootStatus({
    matchId,
    row: null,
    sourceUrl,
  });
  if (
    String(statusBefore.sourceUrl || "").trim() === sourceUrl &&
    (statusBefore.state === "ready" || statusBefore.state === "warming")
  ) {
    return NextResponse.json(
      {
        accepted: true,
        reason: "already-bootstrapped",
        yallashootStatus: protectClientStatus(statusBefore),
      },
      { status: 200, headers: { "Cache-Control": "no-store" } }
    );
  }

  const internalOrigin = resolveInternalAppOrigin(req);
  const ingestUrl = buildYallashootSessionManifestUrl(matchId, internalOrigin);
  const bootstrapped = await runBootstrapSingleflight("yallashoot", matchId, async () => {
    return await bootstrapYallashootAgent({
      matchId,
      sourceUrl,
      ingestUrl,
    });
  });

  const yallashootStatus = await buildYallashootStatus({
    matchId,
    row: null,
    sourceUrl,
  });
  return NextResponse.json(
    {
      accepted: bootstrapped.accepted,
      reason: bootstrapped.reason,
      yallashootStatus: protectClientStatus(yallashootStatus),
    },
    { status: bootstrapped.ok ? 200 : 502, headers: { "Cache-Control": "no-store" } }
  );
}
