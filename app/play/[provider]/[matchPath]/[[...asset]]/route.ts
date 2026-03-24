import { NextResponse } from "next/server";

import {
  buildUpstreamPlaybackManifestUrl,
  isValidPlaybackProvider,
  parsePlaybackMatchId,
  rewriteManifestForPlaybackGateway,
  verifyPlaybackSessionToken,
} from "@/lib/playback-session";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

type Ctx = {
  params: Promise<{
    provider?: string;
    matchPath?: string;
    asset?: string[];
  }>;
};

function buildRawAssetUrl(manifestUrl: string, assetPath: string) {
  if (!assetPath || assetPath.includes("..")) return null;
  try {
    return new URL(assetPath, manifestUrl).toString();
  } catch {
    return null;
  }
}

export async function GET(req: Request, ctx: Ctx) {
  const { provider: rawProvider, matchPath, asset } = await ctx.params;
  const provider = String(rawProvider || "").trim();
  const matchId = parsePlaybackMatchId(String(matchPath || ""));
  if (!isValidPlaybackProvider(provider) || !matchId) {
    return NextResponse.json({ error: "invalid-playback-path" }, { status: 400 });
  }

  const session = verifyPlaybackSessionToken({ req, matchId, provider });
  if (!session.ok) {
    return NextResponse.json({ error: session.reason }, { status: 401 });
  }

  const upstreamManifestUrl = buildUpstreamPlaybackManifestUrl(provider, matchId);
  if (!upstreamManifestUrl) {
    return NextResponse.json({ error: "upstream-playlist-unavailable" }, { status: 404 });
  }

  const assetPath = Array.isArray(asset) && asset.length ? asset.join("/") : "index.m3u8";
  if (assetPath !== "index.m3u8") {
    const rawAssetUrl = buildRawAssetUrl(upstreamManifestUrl, assetPath);
    if (!rawAssetUrl) {
      return NextResponse.json({ error: "invalid-playback-asset" }, { status: 400 });
    }
    return NextResponse.redirect(rawAssetUrl, { status: 307 });
  }

  const response = await fetch(upstreamManifestUrl, {
    method: "GET",
    cache: "no-store",
    redirect: "follow",
    headers: {
      accept: "application/vnd.apple.mpegurl,application/x-mpegurl,text/plain,*/*",
      "user-agent": String(req.headers.get("user-agent") || ""),
    },
  }).catch(() => null);

  if (!response || !response.ok) {
    return NextResponse.json({ error: "manifest-fetch-failed" }, { status: 502 });
  }

  const manifestText = await response.text().catch(() => "");
  const rewritten = rewriteManifestForPlaybackGateway(manifestText, upstreamManifestUrl);
  const out = new NextResponse(rewritten, {
    status: 200,
    headers: {
      "content-type": "application/vnd.apple.mpegurl; charset=utf-8",
      "cache-control": "no-store, no-cache, must-revalidate, max-age=0",
      "x-tf-playback-gateway": "1",
    },
  });
  return out;
}
