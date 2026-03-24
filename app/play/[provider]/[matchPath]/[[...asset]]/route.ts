import { NextResponse } from "next/server";

import {
  buildUpstreamPlaybackManifestUrl,
  guardPlaybackAssetRequest,
  isValidPlaybackProvider,
  observePlaybackGatewayRequest,
  parsePlaybackMatchId,
  rewriteManifestForPlaybackGateway,
  verifyPlaybackSessionToken,
} from "@/lib/playback-session";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

const MANIFEST_MICRO_CACHE_TTL_MS = 1500;
const MANIFEST_MICRO_CACHE_MAX_ENTRIES = 256;

type ManifestMicroCacheEntry = {
  body: string;
  expiresAt: number;
};

const manifestMicroCache = new Map<string, ManifestMicroCacheEntry>();

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

function cleanupManifestMicroCache(now: number) {
  for (const [key, entry] of manifestMicroCache.entries()) {
    if (entry.expiresAt <= now) {
      manifestMicroCache.delete(key);
    }
  }
  if (manifestMicroCache.size <= MANIFEST_MICRO_CACHE_MAX_ENTRIES) return;
  const staleKeys = Array.from(manifestMicroCache.keys()).slice(
    0,
    manifestMicroCache.size - MANIFEST_MICRO_CACHE_MAX_ENTRIES
  );
  for (const key of staleKeys) {
    manifestMicroCache.delete(key);
  }
}

function readManifestMicroCache(key: string, now: number) {
  const entry = manifestMicroCache.get(key);
  if (!entry) return null;
  if (entry.expiresAt <= now) {
    manifestMicroCache.delete(key);
    return null;
  }
  return entry.body;
}

function writeManifestMicroCache(key: string, body: string, now: number) {
  cleanupManifestMicroCache(now);
  manifestMicroCache.set(key, {
    body,
    expiresAt: now + MANIFEST_MICRO_CACHE_TTL_MS,
  });
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
    observePlaybackGatewayRequest({
      req,
      provider,
      matchId,
      assetPath: Array.isArray(asset) && asset.length ? asset.join("/") : "index.m3u8",
      reason: session.reason,
    });
    return NextResponse.json({ error: session.reason }, { status: 401 });
  }

  const upstreamManifestUrl = buildUpstreamPlaybackManifestUrl(provider, matchId);
  if (!upstreamManifestUrl) {
    return NextResponse.json({ error: "upstream-playlist-unavailable" }, { status: 404 });
  }

  const assetPath = Array.isArray(asset) && asset.length ? asset.join("/") : "index.m3u8";
  const now = Date.now();
  const manifestCacheKey = `${provider}:${matchId}:${assetPath}`;
  observePlaybackGatewayRequest({
    req,
    provider,
    matchId,
    assetPath,
  });
  if (assetPath !== "index.m3u8" && !assetPath.toLowerCase().endsWith(".m3u8")) {
    const guard = guardPlaybackAssetRequest({
      req,
      provider,
      matchId,
      claims: session.claims,
      assetPath,
    });
    if (!guard.ok) {
      return NextResponse.json({ error: guard.reason }, { status: 429 });
    }
    const rawAssetUrl = buildRawAssetUrl(upstreamManifestUrl, assetPath);
    if (!rawAssetUrl) {
      return NextResponse.json({ error: "invalid-playback-asset" }, { status: 400 });
    }
    const redirect = NextResponse.redirect(rawAssetUrl, { status: 307 });
    redirect.headers.set("Cache-Control", "no-store");
    redirect.headers.set("x-tf-playback-gateway", "1");
    return redirect;
  }

  const manifestUrl = assetPath === "index.m3u8" ? upstreamManifestUrl : buildRawAssetUrl(upstreamManifestUrl, assetPath);
  if (!manifestUrl) {
    return NextResponse.json({ error: "invalid-manifest-asset" }, { status: 400 });
  }

  const cachedManifest = readManifestMicroCache(manifestCacheKey, now);
  if (cachedManifest) {
    return new NextResponse(cachedManifest, {
      status: 200,
      headers: {
        "content-type": "application/vnd.apple.mpegurl; charset=utf-8",
        "cache-control": "no-store, no-cache, must-revalidate, max-age=0",
        "x-tf-playback-gateway": "1",
      },
    });
  }

  const response = await fetch(manifestUrl, {
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
  const rewritten = rewriteManifestForPlaybackGateway(manifestText, manifestUrl);
  writeManifestMicroCache(manifestCacheKey, rewritten, Date.now());
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
