import { NextResponse } from "next/server";

import { supabaseAdmin } from "../../_supabase";
import { resolveRepackIngestUrl } from "@/lib/repack-ingest-resolver";
import { resolveInternalPlayerOrigin, toAbsoluteInternalUrl } from "@/lib/repack-ingest-gateway";
import {
  getSlotSourceUrlFromRow,
  isIngestCandidateAlignedWithSlotServer,
  isAllowedSourceForSlotServer,
  isValidHttpUrl,
  type SlotServerId,
} from "@/lib/server-source-policy";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

const DEFAULT_RESOLVE_TIMEOUT_MS =
  Math.max(8000, Number.parseInt(String(process.env.REPACK_RESOLVE_TIMEOUT_MS || "10000"), 10) || 10000);
const DEFAULT_MAX_CANDIDATES = Math.min(
  24,
  Math.max(16, Number.parseInt(String(process.env.REPACK_RESOLVE_MAX_CANDIDATES || "16"), 10) || 16)
);
const DEFAULT_FETCH_TIMEOUT_MS = Math.max(
  3500,
  Number.parseInt(String(process.env.REPACK_AGENT_PREFLIGHT_TIMEOUT_MS || "4500"), 10) || 4500
);
const DEFAULT_USER_AGENT =
  "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/141.0.0.0 Safari/537.36";

type MatchRow = {
  id: number;
  stream_url?: string | null;
  stream_url_2?: string | null;
  stream_url_3?: string | null;
  stream_url_4?: string | null;
};

type FetchManifestResult =
  | {
      ok: true;
      body: string;
      contentType: string;
      finalUrl: string;
      fetchUrl: string;
    }
  | {
      ok: false;
      error: string;
      status: number;
      fetchUrl: string;
      finalUrl: string;
      body: string;
      contentType: string;
    };

function toInt(raw: unknown) {
  const value = Number.parseInt(String(raw ?? ""), 10);
  return Number.isFinite(value) ? value : NaN;
}

function isSlotServerId(value: number): value is SlotServerId {
  return value === 1 || value === 2 || value === 3 || value === 4;
}

function safeOrigin(rawUrl: string) {
  try {
    return new URL(rawUrl).origin;
  } catch {
    return "";
  }
}

function resolveManifestUrl(raw: string, baseUrl: string) {
  const value = String(raw || "").trim();
  if (!value) return "";
  try {
    const absolute = new URL(value, baseUrl).toString();
    return isValidHttpUrl(absolute) ? absolute : "";
  } catch {
    return "";
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

function isLikelyChildPlaylistUrl(rawUrl: string) {
  const value = String(rawUrl || "").toLowerCase();
  return value.includes(".m3u8");
}

function hasMediaSegments(manifest: string, baseUrl: string) {
  let previousExtInf = false;
  for (const line of String(manifest || "").split(/\r?\n/)) {
    const trimmed = String(line || "").trim();
    if (!trimmed) continue;
    if (trimmed.startsWith("#EXTINF")) {
      previousExtInf = true;
      continue;
    }
    if (trimmed.startsWith("#")) {
      if (!trimmed.startsWith("#EXT-X-STREAM-INF")) previousExtInf = false;
      continue;
    }

    const absolute = resolveManifestUrl(trimmed, baseUrl);
    if (!absolute) continue;
    if (previousExtInf) return true;
    if (!isLikelyChildPlaylistUrl(absolute)) return true;
    previousExtInf = false;
  }
  return false;
}

function pickVariantManifestUrl(manifest: string, baseUrl: string) {
  let pendingBandwidth = -1;
  const variants: Array<{ url: string; bandwidth: number; order: number }> = [];
  let order = 0;

  for (const line of String(manifest || "").split(/\r?\n/)) {
    const trimmed = String(line || "").trim();
    if (!trimmed) continue;
    if (trimmed.startsWith("#EXT-X-STREAM-INF")) {
      const match = trimmed.match(/BANDWIDTH=(\d+)/i);
      pendingBandwidth = match?.[1] ? Number.parseInt(match[1], 10) : -1;
      continue;
    }
    if (trimmed.startsWith("#")) continue;

    const absolute = resolveManifestUrl(trimmed, baseUrl);
    if (!absolute || !isLikelyChildPlaylistUrl(absolute)) {
      pendingBandwidth = -1;
      continue;
    }
    variants.push({
      url: absolute,
      bandwidth: Number.isFinite(pendingBandwidth) ? pendingBandwidth : -1,
      order,
    });
    order += 1;
    pendingBandwidth = -1;
  }

  variants.sort((left, right) => {
    if (right.bandwidth !== left.bandwidth) return right.bandwidth - left.bandwidth;
    return left.order - right.order;
  });
  return variants[0]?.url || "";
}

async function fetchManifestOnce(fetchUrl: string, headers?: Record<string, string>): Promise<FetchManifestResult> {
  const controller = new AbortController();
  const timeoutId = setTimeout(() => controller.abort(), DEFAULT_FETCH_TIMEOUT_MS);
  try {
    const response = await fetch(fetchUrl, {
      method: "GET",
      cache: "no-store",
      redirect: "follow",
      signal: controller.signal,
      headers: {
        accept: "application/vnd.apple.mpegurl,application/x-mpegurl,text/plain,*/*",
        "user-agent": DEFAULT_USER_AGENT,
        ...(headers || {}),
      },
    });
    const body = await response.text();
    const contentType = String(response.headers.get("content-type") || "").toLowerCase();
    const finalUrl = response.url || fetchUrl;
    if (!response.ok) {
      return {
        ok: false,
        error: `manifest-http-${response.status || 0}`,
        status: response.status,
        fetchUrl,
        finalUrl,
        body,
        contentType,
      };
    }
    if (!looksLikeManifestResponse(contentType, body, finalUrl)) {
      return {
        ok: false,
        error: "manifest-not-hls",
        status: response.status,
        fetchUrl,
        finalUrl,
        body,
        contentType,
      };
    }
    return {
      ok: true,
      body,
      contentType,
      finalUrl,
      fetchUrl,
    };
  } catch (error) {
    return {
      ok: false,
      error: `manifest-fetch-failed:${error instanceof Error ? error.message : String(error)}`,
      status: 0,
      fetchUrl,
      finalUrl: fetchUrl,
      body: "",
      contentType: "",
    };
  } finally {
    clearTimeout(timeoutId);
  }
}

async function fetchStrictMediaManifest(fetchUrl: string, headers?: Record<string, string>) {
  let currentUrl = fetchUrl;
  for (let depth = 0; depth < 3; depth += 1) {
    const fetched = await fetchManifestOnce(currentUrl, headers);
    if (!fetched.ok) return fetched;
    if (hasMediaSegments(fetched.body, fetched.finalUrl)) return fetched;

    const variantUrl = pickVariantManifestUrl(fetched.body, fetched.finalUrl);
    if (!variantUrl) {
      return {
        ok: false,
        error: "manifest-no-media-playlist",
        status: 502,
        fetchUrl: currentUrl,
        finalUrl: fetched.finalUrl,
        body: fetched.body,
        contentType: fetched.contentType,
      } satisfies FetchManifestResult;
    }
    currentUrl = variantUrl;
  }

  return {
    ok: false,
    error: "manifest-recursion-limit",
    status: 502,
    fetchUrl,
    finalUrl: fetchUrl,
    body: "",
    contentType: "",
  } satisfies FetchManifestResult;
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
    if (trimmed.startsWith("/api/embed-proxy") || trimmed.includes("/api/embed-proxy?")) {
      return toAbsoluteInternalUrl(trimmed, input.internalOrigin);
    }
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
      out.push(line.replace(/URI="([^"]+)"/gi, (_match, rawUri) => `URI="${rewriteUri(rawUri)}"`));
      continue;
    }
    out.push(rewriteUri(trimmed));
  }

  return out.join("\n");
}

function absolutizeManifestUrls(manifest: string, baseUrl: string, internalOrigin: string) {
  const lines = String(manifest || "").split(/\r?\n/);
  const out: string[] = [];

  const absolutize = (raw: string) => {
    const value = String(raw || "").trim();
    if (!value || /^data:/i.test(value)) return value;
    try {
      const absolute = new URL(value, baseUrl).toString();
      if (!isValidHttpUrl(absolute)) return value;
      return absolute.startsWith(internalOrigin) ? absolute : toAbsoluteInternalUrl(absolute, internalOrigin);
    } catch {
      return value;
    }
  };

  for (const line of lines) {
    const trimmed = String(line || "").trim();
    if (!trimmed) {
      out.push(line);
      continue;
    }
    if (trimmed.startsWith("#")) {
      out.push(line.replace(/URI="([^"]+)"/gi, (_match, rawUri) => `URI="${absolutize(rawUri)}"`));
      continue;
    }
    out.push(absolutize(trimmed));
  }

  return out.join("\n");
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
  const { data, error } = await fetchMatchRow(matchId);
  if (error) return NextResponse.json({ ok: false, error: String(error.message || "db-error") }, { status: 500 });
  if (!data) return NextResponse.json({ ok: false, error: "match-not-found" }, { status: 404 });

  const sourceUrl = String(getSlotSourceUrlFromRow(data, slotServer) || "").trim();
  if (!sourceUrl || !isValidHttpUrl(sourceUrl)) {
    return NextResponse.json({ ok: false, error: "missing-source" }, { status: 502 });
  }
  if (!isAllowedSourceForSlotServer(slotServer, sourceUrl)) {
    return NextResponse.json({ ok: false, error: "source-not-allowed" }, { status: 502 });
  }

  const resolved = await resolveRepackIngestUrl({
    sourceUrl,
    requestOrigin: internalOrigin,
    slotServerId: slotServer,
    preferProxyIngest: true,
    referrerUrl: sourceUrl,
    timeoutMs: DEFAULT_RESOLVE_TIMEOUT_MS,
    maxCandidates: DEFAULT_MAX_CANDIDATES,
    allowCandidate: ({ candidateUrl, referrerUrl }) =>
      isIngestCandidateAlignedWithSlotServer({
        slotServerId: slotServer,
        sourceUrl,
        ingestUrl: candidateUrl,
        probeReferrerUrl: referrerUrl,
        probePlaylistUrl: candidateUrl,
      }),
  });

  const resolvedIngestUrl = String(resolved.ingestUrl || "").trim();
  if (resolved.resolver.resolverState !== "ok" || !isValidHttpUrl(resolvedIngestUrl)) {
    return NextResponse.json(
      {
        ok: false,
        error: `resolver-${resolved.reason}`,
        resolver: resolved.resolver,
      },
      { status: 502 }
    );
  }

  if (
    !isIngestCandidateAlignedWithSlotServer({
      slotServerId: slotServer,
      sourceUrl,
      ingestUrl: resolvedIngestUrl,
      probeReferrerUrl: resolved.probeEvidence?.referrerUrl || null,
      probePlaylistUrl: resolved.probeEvidence?.playlistUrl || null,
    })
  ) {
    return NextResponse.json(
      {
        ok: false,
        error: "ingest-source-mismatch",
        resolver: resolved.resolver,
      },
      { status: 502 }
    );
  }

  const manifestHeaders =
    resolved.mode === "backend_proxy_ingest"
      ? undefined
      : {
          referer: String(resolved.probeEvidence?.referrerUrl || sourceUrl).trim(),
          origin: safeOrigin(String(resolved.probeEvidence?.referrerUrl || sourceUrl).trim()),
        };
  const fetchUrl =
    resolved.mode === "backend_proxy_ingest"
      ? toAbsoluteInternalUrl(resolvedIngestUrl, internalOrigin)
      : resolvedIngestUrl;

  const manifest = await fetchStrictMediaManifest(fetchUrl, manifestHeaders);
  if (!manifest.ok) {
    return NextResponse.json(
      {
        ok: false,
        error: manifest.error,
        upstreamIngestUrl: resolvedIngestUrl,
      },
      { status: 502 }
    );
  }

  const manifestBody =
    resolved.mode === "backend_proxy_ingest"
      ? absolutizeManifestUrls(manifest.body, manifest.finalUrl || fetchUrl, internalOrigin)
      : rewriteManifestForEmbedProxy({
          manifest: manifest.body,
          baseUrl: manifest.finalUrl || fetchUrl,
          internalOrigin,
          referrerUrl: String(resolved.probeEvidence?.referrerUrl || sourceUrl).trim() || sourceUrl,
        });

  return new Response(manifestBody, {
    status: 200,
    headers: {
      "content-type": "application/vnd.apple.mpegurl; charset=utf-8",
      "cache-control": "no-store, no-cache, must-revalidate, max-age=0",
      "x-repack-gateway": "1",
      "x-repack-slot-server": String(slotServer),
      "x-repack-source-url": sourceUrl,
      "x-repack-upstream-url": resolvedIngestUrl,
    },
  });
}
