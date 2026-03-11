import { NextResponse } from "next/server";
import { supabaseAdmin } from "../../_supabase";
import { resolveRepackIngestUrl, type RepackIngestResolution } from "@/lib/repack-ingest-resolver";
import { getRepackSeedRuntimeState } from "@/lib/repack-runtime-state";
import {
  getSlotSourceUrlFromRow,
  isIngestCandidateAlignedWithSlotServer,
  isAllowedSourceForSlotServer,
  isValidHttpUrl,
  type SlotServerId,
} from "@/lib/server-source-policy";
import {
  buildRepackGatewayManifestUrl,
  resolveInternalPlayerOrigin,
  toAbsoluteInternalUrl,
} from "@/lib/repack-ingest-gateway";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

const DEFAULT_RESOLVE_TIMEOUT_MS =
  Math.max(8000, Number.parseInt(String(process.env.REPACK_RESOLVE_TIMEOUT_MS || "10000"), 10) || 10000);
const DEFAULT_MAX_CANDIDATES = Math.min(
  24,
  Math.max(16, Number.parseInt(String(process.env.REPACK_RESOLVE_MAX_CANDIDATES || "16"), 10) || 16)
);
const DEFAULT_GATEWAY_CACHE_TTL_MS = 3500;
const DEFAULT_USER_AGENT =
  "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/141.0.0.0 Safari/537.36";

type MatchRow = {
  id: number;
  stream_url?: string | null;
  stream_url_2?: string | null;
  stream_url_3?: string | null;
  stream_url_4?: string | null;
};

type CachedGatewayResolution = {
  expiresAt: number;
  sourceUrl: string;
  probeReferrerUrl: string;
  upstreamIngestUrl: string | null;
  upstreamMode: string;
};

const gatewayResolutionCache = new Map<string, CachedGatewayResolution>();

function toInt(raw: unknown) {
  const value = Number.parseInt(String(raw ?? ""), 10);
  return Number.isFinite(value) ? value : NaN;
}

function isSlotServerId(value: number): value is SlotServerId {
  return value === 1 || value === 2 || value === 3 || value === 4;
}

function runtimeCacheKey(matchId: number, slotServer: SlotServerId) {
  return `${matchId}:${slotServer}`;
}

function trimGatewayResolutionCache(now = Date.now()) {
  for (const [key, value] of gatewayResolutionCache.entries()) {
    if (value.expiresAt <= now) gatewayResolutionCache.delete(key);
  }
}

function looksLikeManifestResponse(contentType: string, body: string, finalUrl: string) {
  const ct = String(contentType || "").toLowerCase();
  const text = String(body || "");
  const url = String(finalUrl || "").toLowerCase();
  if (/^\s*#extm3u/m.test(text)) return true;
  if (ct.includes("application/vnd.apple.mpegurl") || ct.includes("application/x-mpegurl")) return true;
  return url.includes(".m3u8");
}

function buildInternalEmbedProxyUrl(input: {
  sourceUrl: string;
  internalOrigin: string;
  referrerUrl?: string | null;
}) {
  const sourceUrl = String(input.sourceUrl || "").trim();
  if (!isValidHttpUrl(sourceUrl)) return "";
  const proxyUrl = new URL("/api/embed-proxy", input.internalOrigin);
  proxyUrl.searchParams.set("url", sourceUrl);
  proxyUrl.searchParams.set("depth", "0");
  proxyUrl.searchParams.set("backend", "1");
  const referrerUrl = String(input.referrerUrl || "").trim();
  if (isValidHttpUrl(referrerUrl)) proxyUrl.searchParams.set("ref", referrerUrl);
  return proxyUrl.toString();
}

function safeOrigin(rawUrl: string) {
  try {
    return new URL(rawUrl).origin;
  } catch {
    return "";
  }
}

function rewriteManifestForEmbedProxy(input: {
  manifest: string;
  baseUrl: string;
  internalOrigin: string;
  referrerUrl: string;
}) {
  const lines = String(input.manifest || "").split(/\r?\n/);
  const out: string[] = [];
  const rewriteUri = (raw: string) => {
    const trimmed = String(raw || "").trim();
    if (!trimmed) return trimmed;
    if (/^data:/i.test(trimmed)) return trimmed;
    if (trimmed.startsWith("/api/embed-proxy") || trimmed.includes("/api/embed-proxy?")) return trimmed;
    try {
      const absolute = new URL(trimmed, input.baseUrl).toString();
      if (!isValidHttpUrl(absolute)) return trimmed;
      return buildInternalEmbedProxyUrl({
        sourceUrl: absolute,
        internalOrigin: input.internalOrigin,
        referrerUrl: input.referrerUrl,
      });
    } catch {
      return trimmed;
    }
  };

  for (const line of lines) {
    const trimmed = String(line || "").trim();
    if (!trimmed) {
      out.push(line);
      continue;
    }
    if (trimmed.startsWith("#")) {
      out.push(line.replace(/URI="([^"]+)"/gi, (_m, rawUri) => `URI="${rewriteUri(rawUri)}"`));
      continue;
    }
    out.push(rewriteUri(trimmed));
  }

  return out.join("\n");
}

function canAcceptProtectedProxySoftResult(ingest: RepackIngestResolution) {
  if (ingest.mode !== "backend_proxy_ingest") return false;
  if (!isValidHttpUrl(String(ingest.ingestUrl || "").trim())) return false;
  if (String(ingest.reason || "").trim() !== "resolved-proxy-candidate-soft") return false;
  const playlistStatus = Number.parseInt(String(ingest.probeEvidence?.playlistStatus || 0), 10) || 0;
  const segmentStatus = Number.parseInt(String(ingest.probeEvidence?.segmentStatus || 0), 10) || 0;
  return playlistStatus >= 200 && playlistStatus < 300 && segmentStatus === 403;
}

async function fetchMatchRow(matchId: number) {
  const { data, error } = await supabaseAdmin
    .from("match-stream-app")
    .select("id,stream_url,stream_url_2,stream_url_3,stream_url_4")
    .eq("id", matchId)
    .maybeSingle();
  return {
    data: (data || null) as MatchRow | null,
    error: (error || null) as { message?: string } | null,
  };
}

function pickSourceContext(matchId: number, slotServer: SlotServerId) {
  const runtimeState = getRepackSeedRuntimeState(matchId, slotServer);
  const sourceUrl = String(runtimeState?.sourceUrl || "").trim();
  const probeReferrerUrl = String(runtimeState?.probeReferrerUrl || "").trim();
  const ingestUrl = String(runtimeState?.ingestUrl || "").trim();
  const ingestMode = String(runtimeState?.ingestMode || "").trim();
  return {
    sourceUrl: isValidHttpUrl(sourceUrl) ? sourceUrl : "",
    probeReferrerUrl: isValidHttpUrl(probeReferrerUrl) ? probeReferrerUrl : "",
    ingestUrl: isValidHttpUrl(ingestUrl) ? ingestUrl : "",
    ingestMode,
  };
}

async function resolveGatewayUpstream(input: {
  matchId: number;
  slotServer: SlotServerId;
  internalOrigin: string;
}) {
  trimGatewayResolutionCache();
  const cacheKey = runtimeCacheKey(input.matchId, input.slotServer);
  const cached = gatewayResolutionCache.get(cacheKey);
  if (cached && cached.expiresAt > Date.now()) return cached;

  const runtimeContext = pickSourceContext(input.matchId, input.slotServer);
  let sourceUrl = runtimeContext.sourceUrl;
  if (!sourceUrl) {
    const { data, error } = await fetchMatchRow(input.matchId);
    if (error || !data) throw new Error(String(error?.message || "match-not-found"));
    sourceUrl = String(getSlotSourceUrlFromRow(data, input.slotServer) || "").trim();
  }
  if (!sourceUrl || !isValidHttpUrl(sourceUrl)) throw new Error("missing-source");
  if (!isAllowedSourceForSlotServer(input.slotServer, sourceUrl)) throw new Error("source-not-allowed");

  const referrerUrl = runtimeContext.probeReferrerUrl || sourceUrl;
  const resolved = await resolveRepackIngestUrl({
    sourceUrl,
    requestOrigin: input.internalOrigin,
    slotServerId: input.slotServer,
    preferProxyIngest: true,
    referrerUrl,
    timeoutMs: DEFAULT_RESOLVE_TIMEOUT_MS,
    maxCandidates: DEFAULT_MAX_CANDIDATES,
    allowCandidate: ({ candidateUrl, referrerUrl: candidateReferrerUrl }) =>
      isIngestCandidateAlignedWithSlotServer({
        slotServerId: input.slotServer,
        sourceUrl,
        ingestUrl: candidateUrl,
        probeReferrerUrl: candidateReferrerUrl,
        probePlaylistUrl: candidateUrl,
      }),
  });

  const allowProtectedProxySoft = canAcceptProtectedProxySoftResult(resolved);
  const resolvedIngestUrl =
    isValidHttpUrl(String(resolved.ingestUrl || "").trim()) &&
    (resolved.resolver.resolverState === "ok" || allowProtectedProxySoft)
      ? String(resolved.ingestUrl || "").trim()
      : runtimeContext.ingestUrl;
  const resolvedMode =
    resolvedIngestUrl && resolved.resolver.resolverState === "ok"
      ? String(resolved.mode || "").trim()
      : runtimeContext.ingestMode || String(resolved.mode || "").trim();
  if (!resolvedIngestUrl || !isValidHttpUrl(resolvedIngestUrl)) {
    throw new Error(`invalid-ingest-url:${resolved.reason}`);
  }

  const validatedFetchUrl =
    resolvedMode === "backend_proxy_ingest"
      ? toAbsoluteInternalUrl(resolvedIngestUrl, input.internalOrigin)
      : resolvedIngestUrl;
  if (!validatedFetchUrl || !isValidHttpUrl(validatedFetchUrl)) {
    throw new Error("invalid-upstream-fetch-url");
  }

  const next: CachedGatewayResolution = {
    expiresAt: Date.now() + DEFAULT_GATEWAY_CACHE_TTL_MS,
    sourceUrl,
    probeReferrerUrl:
      String(resolved.probeEvidence?.referrerUrl || "").trim() || runtimeContext.probeReferrerUrl || sourceUrl,
    upstreamIngestUrl: resolvedIngestUrl,
    upstreamMode: resolvedMode || "backend_proxy_ingest",
  };
  gatewayResolutionCache.set(cacheKey, next);
  return next;
}

async function fetchGatewayManifest(fetchUrl: string, headers?: Record<string, string>) {
  const response = await fetch(fetchUrl, {
    method: "GET",
    cache: "no-store",
    headers: {
      accept: "application/vnd.apple.mpegurl,application/x-mpegurl,text/html,*/*",
      "user-agent": DEFAULT_USER_AGENT,
      ...(headers || {}),
    },
  });
  const body = await response.text();
  const contentType = String(response.headers.get("content-type") || "").toLowerCase();
  return {
    ok: response.ok,
    status: response.status,
    body,
    contentType,
    finalUrl: response.url || fetchUrl,
  };
}

export async function GET(req: Request) {
  const url = new URL(req.url);
  const matchId = toInt(url.searchParams.get("matchId"));
  const slotServer = toInt(url.searchParams.get("slotServer"));
  if (!Number.isFinite(matchId) || matchId <= 0) {
    return NextResponse.json({ ok: false, error: "invalid-match-id" }, { status: 400 });
  }
  if (!Number.isFinite(slotServer) || !isSlotServerId(slotServer)) {
    return NextResponse.json({ ok: false, error: "invalid-slot-server" }, { status: 400 });
  }

  const internalOrigin = resolveInternalPlayerOrigin(req);
  try {
    let resolved = await resolveGatewayUpstream({
      matchId,
      slotServer,
      internalOrigin,
    });
    const manifestFetchHeaders =
      resolved.upstreamMode === "backend_proxy_ingest"
        ? undefined
        : {
            referer: resolved.probeReferrerUrl || resolved.sourceUrl,
            origin: safeOrigin(resolved.probeReferrerUrl || resolved.sourceUrl),
          };
    const initialFetchUrl =
      resolved.upstreamMode === "backend_proxy_ingest"
        ? toAbsoluteInternalUrl(String(resolved.upstreamIngestUrl || ""), internalOrigin)
        : String(resolved.upstreamIngestUrl || "");
    let manifest = await fetchGatewayManifest(initialFetchUrl, manifestFetchHeaders);

    if (!manifest.ok || !looksLikeManifestResponse(manifest.contentType, manifest.body, manifest.finalUrl)) {
      gatewayResolutionCache.delete(runtimeCacheKey(matchId, slotServer));
      resolved = await resolveGatewayUpstream({
        matchId,
        slotServer,
        internalOrigin,
      });
      const retryFetchHeaders =
        resolved.upstreamMode === "backend_proxy_ingest"
          ? undefined
          : {
              referer: resolved.probeReferrerUrl || resolved.sourceUrl,
              origin: safeOrigin(resolved.probeReferrerUrl || resolved.sourceUrl),
            };
      const retryFetchUrl =
        resolved.upstreamMode === "backend_proxy_ingest"
          ? toAbsoluteInternalUrl(String(resolved.upstreamIngestUrl || ""), internalOrigin)
          : String(resolved.upstreamIngestUrl || "");
      manifest = await fetchGatewayManifest(retryFetchUrl, retryFetchHeaders);
    }

    if (!manifest.ok) {
      return NextResponse.json(
        {
          ok: false,
          error: `manifest-http-${manifest.status || 0}`,
          matchId,
          slotServer,
          upstreamIngestUrl: resolved.upstreamIngestUrl,
        },
        { status: 502 }
      );
    }
    if (!looksLikeManifestResponse(manifest.contentType, manifest.body, manifest.finalUrl)) {
      return NextResponse.json(
        {
          ok: false,
          error: "manifest-not-hls",
          matchId,
          slotServer,
          upstreamIngestUrl: resolved.upstreamIngestUrl,
        },
        { status: 502 }
      );
    }

    const manifestBody =
      resolved.upstreamMode === "backend_proxy_ingest"
        ? manifest.body
        : rewriteManifestForEmbedProxy({
            manifest: manifest.body,
            baseUrl: manifest.finalUrl || String(resolved.upstreamIngestUrl || ""),
            internalOrigin,
            referrerUrl: resolved.probeReferrerUrl || resolved.sourceUrl,
          });

    return new Response(manifestBody, {
      status: 200,
      headers: {
        "content-type": "application/vnd.apple.mpegurl; charset=utf-8",
        "cache-control": "no-store, no-cache, must-revalidate",
        "x-repack-gateway": "1",
        "x-repack-slot-server": String(slotServer),
        "x-repack-source-url": resolved.sourceUrl,
        "x-repack-upstream-url": resolved.upstreamIngestUrl || "",
      },
    });
  } catch (error) {
    return NextResponse.json(
      {
        ok: false,
        error: String((error as Error)?.message || "gateway-failed"),
        gatewayUrl: buildRepackGatewayManifestUrl({
          matchId,
          slotServer,
          internalOrigin,
        }),
      },
      { status: 502 }
    );
  }
}
