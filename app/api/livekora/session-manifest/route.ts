import { NextResponse } from "next/server";

import { fetchLivekoraMatchRow } from "@/lib/livekora-match";
import { livekoraProvider, pickLivekoraSourceUrl, resolveInternalAppOrigin } from "@/lib/live-providers";
import { runSessionManifestSingleflight } from "@/lib/session-manifest-singleflight";
import { getOrLoadHotWatchStateSeed, seedHotWatchState } from "@/lib/watch-state-cache";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function GET(req: Request) {
  const url = new URL(req.url);
  const matchId = Number.parseInt(String(url.searchParams.get("matchId") || "").trim(), 10);
  const waitForMediaSequence = Number.parseInt(String(url.searchParams.get("waitForMediaSequence") || "").trim(), 10);
  const waitTimeoutMs = Number.parseInt(String(url.searchParams.get("waitTimeoutMs") || "").trim(), 10);
  const forceRefresh = String(url.searchParams.get("forceRefresh") || "").trim() === "1";
  const allowRotate = String(url.searchParams.get("allowRotate") || "1").trim() !== "0";
  if (!Number.isFinite(matchId) || matchId <= 0) {
    return NextResponse.json({ ok: false, error: "invalid-match-id" }, { status: 400 });
  }

  const { seed, row, error } = await getOrLoadHotWatchStateSeed(matchId);
  if (error) {
    return NextResponse.json({ ok: false, error: String(error.message || "db-error") }, { status: 500 });
  }
  if (!seed) {
    return NextResponse.json({ ok: false, error: "match-not-found" }, { status: 404 });
  }

  const effectiveRow = row || (await fetchLivekoraMatchRow(matchId)).data || null;
  const freshSourceUrl = effectiveRow ? await pickLivekoraSourceUrl(effectiveRow) : null;
  if (freshSourceUrl && freshSourceUrl !== seed.sourceUrls.livekora) {
    seedHotWatchState({
      matchId,
      livekoraSourceUrl: freshSourceUrl,
      beinliveSourceUrl: seed.sourceUrls.beinlive,
      siiirSourceUrl: seed.sourceUrls.siiir,
      yallashootSourceUrl: seed.sourceUrls.yallashoot,
      matchStart: effectiveRow?.match_start || seed.matchStart || null,
      statusKey: effectiveRow?.status_key || seed.statusKey || null,
    });
  }
  const sourceUrl = String(freshSourceUrl || seed.sourceUrls.livekora || "").trim() || null;
  if (!sourceUrl) {
    return NextResponse.json({ ok: false, error: "missing-source" }, { status: 409 });
  }

  const internalOrigin = resolveInternalAppOrigin(req);
  const singleflightKey = [
    "livekora",
    matchId,
    sourceUrl,
    Number.isFinite(waitForMediaSequence) ? waitForMediaSequence : "",
    Number.isFinite(waitTimeoutMs) ? waitTimeoutMs : "",
    forceRefresh ? "force" : "normal",
    allowRotate ? "rotate" : "fixed",
  ].join("::");
  const resolved = await runSessionManifestSingleflight(singleflightKey, async () => {
    return await livekoraProvider.extractCurrentManifest(
      {
        matchId,
        sourceUrl,
        internalOrigin,
      },
      {
        waitForMediaSequence: Number.isFinite(waitForMediaSequence) ? waitForMediaSequence : null,
        waitTimeoutMs: Number.isFinite(waitTimeoutMs) ? waitTimeoutMs : null,
        forceRefresh,
        allowRotate,
      }
    );
  });
  if (!resolved.ok) {
    return NextResponse.json(
      {
        ok: false,
        error: resolved.error || "manifest-resolution-failed",
        currentSource: resolved.currentSource || null,
        playbackUrl: resolved.playbackUrl || null,
      },
      { status: 502 }
    );
  }

  return new Response(resolved.manifestBody, {
    status: 200,
    headers: {
      "content-type": "application/vnd.apple.mpegurl; charset=utf-8",
      "cache-control": "no-store, no-cache, must-revalidate, max-age=0",
      "x-livekora-session-manifest": "1",
      "x-livekora-current-source": resolved.currentSource || "",
      "x-livekora-playback-url": resolved.playbackUrl || "",
      "x-livekora-media-sequence": String(resolved.mediaSequence ?? ""),
      "x-livekora-target-duration": String(resolved.targetDurationSec || 0),
      "x-r2-session-manifest": "1",
      "x-r2-current-source": resolved.currentSource || "",
      "x-r2-playback-url": resolved.playbackUrl || "",
      "x-r2-media-sequence": String(resolved.mediaSequence ?? ""),
      "x-r2-target-duration": String(resolved.targetDurationSec || 0),
    },
  });
}
