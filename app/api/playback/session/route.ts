import { NextResponse } from "next/server";

import {
  attachPlaybackSessionCookie,
  buildPlaybackManifestPath,
  createPlaybackSessionToken,
  guardPlaybackSessionIssueRequest,
  isValidPlaybackProvider,
  observePlaybackGatewayRequest,
} from "@/lib/playback-session";
import { readAllR2MirrorAgentStatuses } from "@/lib/r2-mirror-agent";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function POST(req: Request) {
  const payload = (await req.json().catch(() => null)) as
    | {
        matchId?: number | string | null;
        provider?: string | null;
      }
    | null;

  const matchId = Number.parseInt(String(payload?.matchId || "").trim(), 10);
  const provider = String(payload?.provider || "").trim();

  if (!Number.isFinite(matchId) || matchId <= 0 || !isValidPlaybackProvider(provider)) {
    return NextResponse.json({ error: "invalid-playback-session-request" }, { status: 400 });
  }

  const guard = guardPlaybackSessionIssueRequest({ req, provider, matchId });
  if (!guard.ok) {
    observePlaybackGatewayRequest({
      req,
      provider,
      matchId,
      assetPath: "session",
      reason: guard.reason,
    });
    return NextResponse.json({ error: guard.reason }, { status: 429 });
  }

  observePlaybackGatewayRequest({
    req,
    provider,
    matchId,
    assetPath: "session",
  });

  const statuses = await readAllR2MirrorAgentStatuses(matchId);
  const providerStatus =
    provider === "livekora" ? statuses?.livekora : provider === "beinlive" ? statuses?.beinlive : statuses?.siiir;

  if (providerStatus?.state !== "ready" || !String(providerStatus.playlistUrl || "").trim()) {
    return NextResponse.json({ error: "playback-not-ready" }, { status: 409 });
  }

  const session = createPlaybackSessionToken({
    matchId,
    provider,
    userAgent: String(req.headers.get("user-agent") || ""),
  });

  const response = NextResponse.json({
    ok: true,
    playUrl: buildPlaybackManifestPath(provider, matchId),
    expiresAt: new Date(session.expiresAt).toISOString(),
  });
  response.headers.set("Cache-Control", "no-store");
  return attachPlaybackSessionCookie(response, {
    matchId,
    provider,
    token: session.token,
    expiresAt: session.expiresAt,
  });
}
