import { NextResponse } from "next/server";

import { resolveInternalAppOrigin } from "@/lib/live-providers";
import { sanitizeHeaderValue } from "@/lib/http-header-utils";
import { runSessionManifestSingleflight } from "@/lib/session-manifest-singleflight";
import { getOrLoadHotWatchStateSeed } from "@/lib/watch-state-cache";
import { readYallashootAgentStatus } from "@/lib/yallashoot-agent";
import { yallashootProvider } from "@/lib/yallashoot-provider";

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

  const { seed, error } = await getOrLoadHotWatchStateSeed(matchId);
  if (error) {
    return NextResponse.json({ ok: false, error: String(error.message || "db-error") }, { status: 500 });
  }
  if (!seed) {
    return NextResponse.json({ ok: false, error: "match-not-found" }, { status: 404 });
  }

  const sourceUrl = String(seed.sourceUrls.yallashoot || "").trim();
  if (!sourceUrl) {
    return NextResponse.json({ ok: false, error: "missing-source" }, { status: 409 });
  }

  const internalOrigin = resolveInternalAppOrigin(req);
  const agentStatus = await readYallashootAgentStatus(matchId);
  const singleflightKey = [
    "yallashoot",
    matchId,
    sourceUrl,
    String(agentStatus?.currentSource || "").trim(),
    Number.isFinite(waitForMediaSequence) ? waitForMediaSequence : "",
    Number.isFinite(waitTimeoutMs) ? waitTimeoutMs : "",
    forceRefresh ? "force" : "normal",
    allowRotate ? "rotate" : "fixed",
  ].join("::");
  const resolved = await runSessionManifestSingleflight(singleflightKey, async () => {
    return await yallashootProvider.extractCurrentManifest(
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
        preferredCurrentSource: String(agentStatus?.currentSource || "").trim() || null,
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

  const response = new Response(resolved.manifestBody, {
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
  const timingSummary = sanitizeHeaderValue(resolved.timingSummary || "");
  if (timingSummary) {
    response.headers.set("x-livekora-timing", timingSummary);
    response.headers.set("x-r2-timing", timingSummary);
  }
  return response;
}
