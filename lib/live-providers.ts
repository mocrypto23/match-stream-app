import { execFile } from "node:child_process";
import path from "node:path";

type MatchRowLike = {
  stream_url_4?: string | null;
};

type ManifestOptions = {
  waitForMediaSequence?: number | null;
  waitTimeoutMs?: number | null;
  forceRefresh?: boolean;
  allowRotate?: boolean;
};

export type ProviderManifestResult =
  | {
      ok: true;
      manifestBody: string;
      finalUrl: string;
      targetUrl: string;
      fetchUrl?: string;
      referrerUrl: string;
      playbackUrl: string;
      currentSource: string;
      mediaSequence: number | null;
      targetDurationSec: number;
      refreshed: boolean;
      rotated: boolean;
      adapterKind: "livekora";
      candidatesFound: number;
      candidatesTried: number;
      sessionOwned: true;
    }
  | {
      ok: false;
      error: string;
      playbackUrl: string;
      currentSource: string;
      mediaSequence: number | null;
      targetDurationSec: number;
      refreshed: boolean;
      rotated: boolean;
      adapterKind: "livekora";
      candidatesFound: number;
      candidatesTried: number;
    };

export type ProviderAssetResult =
  | {
      ok: true;
      status: number;
      contentType: string;
      bodyBase64: string;
      error: string;
    }
  | {
      ok: false;
      status: number;
      contentType: string;
      bodyBase64: string;
      error: string;
    };

export type ProviderContext = {
  matchId: number;
  sourceUrl: string;
  internalOrigin: string;
};

export type LiveStreamProvider = {
  id: "livekora";
  publicPathPrefix: string;
  sourceSelector: (row: MatchRowLike) => string | null;
  isAllowedSource: (rawUrl: string) => boolean;
  extractCurrentManifest: (input: ProviderContext, options?: ManifestOptions) => Promise<ProviderManifestResult>;
  fetchAsset: (
    input: ProviderContext & {
      assetUrl: string;
      referrerUrl?: string | null;
      timeoutMs?: number;
    }
  ) => Promise<ProviderAssetResult>;
};

type EmbedProxyExtractorOutput = {
  ok?: boolean;
  manifestUrl?: string;
  manifestBody?: string;
  referrerUrl?: string;
  playbackUrl?: string;
  error?: string;
};

const LIVEKORA_HOST_SUFFIXES = ["sportsurges.cc", "livekora.vip", "koooralive.click", "kooraxx.com"] as const;
const EMBED_PROXY_EXTRACT_TIMEOUT_MS = 30_000;
const EMBED_PROXY_FETCH_TIMEOUT_MS = 25_000;
const DEFAULT_USER_AGENT =
  "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/145.0.0.0 Safari/537.36";

function normalizeHttpUrl(rawUrl: string) {
  try {
    const parsed = new URL(String(rawUrl || "").trim());
    return parsed.protocol === "http:" || parsed.protocol === "https:" ? parsed.toString() : "";
  } catch {
    return "";
  }
}

function isHttpUrl(rawUrl: string) {
  return !!normalizeHttpUrl(rawUrl);
}

function hostMatchesAnySuffix(host: string, suffixes: readonly string[]) {
  const normalized = String(host || "").trim().toLowerCase().replace(/\.$/, "");
  if (!normalized) return false;
  return suffixes.some((suffix) => normalized === suffix || normalized.endsWith(`.${suffix}`));
}

function resolveManifestUrl(raw: string, baseUrl: string) {
  const value = String(raw || "").trim();
  if (!value) return "";
  try {
    const absolute = new URL(value, baseUrl).toString();
    return isHttpUrl(absolute) ? absolute : "";
  } catch {
    return "";
  }
}

function parseMediaSequence(manifestText: string) {
  const match = String(manifestText || "").match(/#EXT-X-MEDIA-SEQUENCE:(\d+)/i);
  if (!match?.[1]) return null;
  const value = Number.parseInt(match[1], 10);
  return Number.isFinite(value) ? value : null;
}

function parseTargetDurationSec(manifestText: string) {
  for (const line of String(manifestText || "").split(/\r?\n/)) {
    const match = String(line || "").trim().match(/^#EXT-X-TARGETDURATION:(\d+(?:\.\d+)?)/i);
    if (!match?.[1]) continue;
    const value = Number.parseFloat(match[1]);
    if (Number.isFinite(value) && value > 0) return value;
  }
  return 0;
}

function hasMediaSegments(manifestText: string, baseUrl: string) {
  let previousExtInf = false;
  for (const line of String(manifestText || "").split(/\r?\n/)) {
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
    previousExtInf = false;
  }
  return false;
}

function pickVariantManifestUrl(manifestText: string, baseUrl: string) {
  let pendingBandwidth = -1;
  const variants: Array<{ url: string; bandwidth: number; order: number }> = [];
  let order = 0;
  for (const line of String(manifestText || "").split(/\r?\n/)) {
    const trimmed = String(line || "").trim();
    if (!trimmed) continue;
    if (trimmed.startsWith("#EXT-X-STREAM-INF")) {
      const match = trimmed.match(/BANDWIDTH=(\d+)/i);
      pendingBandwidth = match?.[1] ? Number.parseInt(match[1], 10) : -1;
      continue;
    }
    if (trimmed.startsWith("#")) continue;
    const absolute = resolveManifestUrl(trimmed, baseUrl);
    if (!absolute || !absolute.toLowerCase().includes(".m3u8")) {
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

function buildEmbedProxyUrl(input: {
  targetUrl: string;
  requestOrigin: string;
  referrerUrl?: string | null;
}) {
  const targetUrl = normalizeHttpUrl(input.targetUrl);
  const requestOrigin = normalizeHttpUrl(input.requestOrigin);
  if (!targetUrl || !requestOrigin) return "";
  const params = new URLSearchParams();
  params.set("url", targetUrl);
  params.set("depth", "0");
  params.set("stable", "1");
  const referrerUrl = normalizeHttpUrl(input.referrerUrl || input.targetUrl);
  if (referrerUrl) params.set("ref", referrerUrl);
  return `${requestOrigin.replace(/\/+$/, "")}/api/embed-proxy?${params.toString()}`;
}

function buildLivekoraSessionAssetUrl(input: {
  internalOrigin: string;
  sourceUrl: string;
  assetUrl: string;
  referrerUrl: string;
}) {
  const internalOrigin = normalizeHttpUrl(input.internalOrigin);
  const sourceUrl = normalizeHttpUrl(input.sourceUrl);
  const assetUrl = normalizeHttpUrl(input.assetUrl);
  const referrerUrl = normalizeHttpUrl(input.referrerUrl);
  if (!internalOrigin || !sourceUrl || !assetUrl) return "";
  const params = new URLSearchParams();
  params.set("sourceUrl", sourceUrl);
  params.set("assetUrl", assetUrl);
  if (referrerUrl) params.set("referrerUrl", referrerUrl);
  return `${internalOrigin.replace(/\/+$/, "")}/api/livekora/session-asset?${params.toString()}`;
}

function rewriteManifestForLivekoraSession(input: {
  manifest: string;
  baseUrl: string;
  internalOrigin: string;
  sourceUrl: string;
  referrerUrl: string;
}) {
  const lines = String(input.manifest || "").split(/\r?\n/);
  const out: string[] = [];
  const rewriteAssetUrl = (raw: string) => {
    const absolute = resolveManifestUrl(raw, input.baseUrl);
    if (!absolute) return raw;
    return (
      buildLivekoraSessionAssetUrl({
        internalOrigin: input.internalOrigin,
        sourceUrl: input.sourceUrl,
        assetUrl: absolute,
        referrerUrl: input.referrerUrl,
      }) || raw
    );
  };

  for (const line of lines) {
    const trimmed = String(line || "").trim();
    if (!trimmed) {
      out.push(line);
      continue;
    }
    if (trimmed.startsWith("#")) {
      out.push(line.replace(/URI="([^"]+)"/gi, (_match, rawUri) => `URI="${rewriteAssetUrl(rawUri)}"`));
      continue;
    }
    out.push(rewriteAssetUrl(trimmed));
  }
  return out.join("\n");
}

export function isAllowedLivekoraSource(rawUrl: string) {
  const normalized = normalizeHttpUrl(rawUrl);
  if (!normalized) return false;
  try {
    return hostMatchesAnySuffix(new URL(normalized).hostname, LIVEKORA_HOST_SUFFIXES);
  } catch {
    return false;
  }
}

export function pickLivekoraSourceUrl(row: MatchRowLike) {
  const raw = String(row?.stream_url_4 || "").trim();
  return isAllowedLivekoraSource(raw) ? raw : null;
}

export function buildLivekoraPublicPlaylistUrl(matchId: number, publicBaseUrl?: string) {
  if (!Number.isFinite(matchId) || matchId <= 0) return null;
  const base =
    String(publicBaseUrl || process.env.LIVEKORA_R2_PUBLIC_BASE_URL || "https://r2.tf-player.site/live")
      .trim()
      .replace(/\/+$/, "");
  if (!base) return null;
  return `${base}/livekora/m${matchId}/index.m3u8`;
}

export function resolveInternalAppOrigin(req?: Request | null) {
  const configured = String(process.env.LIVEKORA_INTERNAL_APP_ORIGIN || process.env.INTERNAL_APP_ORIGIN || "").trim();
  if (configured) {
    try {
      const parsed = new URL(configured);
      if (parsed.protocol === "http:" || parsed.protocol === "https:") return parsed.toString().replace(/\/+$/, "");
    } catch {}
  }
  try {
    const origin = new URL(String(req?.url || "")).origin;
    if (origin) return origin.replace(/\/+$/, "");
  } catch {}
  const port = Number.parseInt(String(process.env.PORT || "3000"), 10) || 3000;
  return `http://127.0.0.1:${port}`;
}

function withTimeout<T>(promise: Promise<T>, timeoutMs: number, errorText: string) {
  return new Promise<T>((resolve, reject) => {
    const timeoutId = setTimeout(() => reject(new Error(errorText)), timeoutMs);
    promise.then(
      (value) => {
        clearTimeout(timeoutId);
        resolve(value);
      },
      (error) => {
        clearTimeout(timeoutId);
        reject(error);
      }
    );
  });
}

function runEmbedProxyLivekoraExtractor(input: ProviderContext) {
  const scriptPath = path.join(process.cwd(), "server", "livekora-direct-extract.js");
  const playbackUrl = buildEmbedProxyUrl({
    targetUrl: input.sourceUrl,
    requestOrigin: input.internalOrigin,
    referrerUrl: input.sourceUrl,
  });
  return new Promise<EmbedProxyExtractorOutput | null>((resolve) => {
    execFile(
      process.execPath,
      [scriptPath, input.sourceUrl, playbackUrl],
      {
        cwd: process.cwd(),
        timeout: EMBED_PROXY_EXTRACT_TIMEOUT_MS + 10_000,
        maxBuffer: 4 * 1024 * 1024,
      },
      (_error, stdout) => {
        const raw = String(stdout || "")
          .split(/\r?\n/)
          .map((line) => line.trim())
          .filter(Boolean)
          .at(-1);
        if (!raw) {
          resolve(null);
          return;
        }
        try {
          resolve(JSON.parse(raw) as EmbedProxyExtractorOutput);
        } catch {
          resolve(null);
        }
      }
    );
  });
}

async function fetchTextViaEmbedProxy(input: {
  targetUrl: string;
  internalOrigin: string;
  referrerUrl: string;
  timeoutMs?: number;
}) {
  const proxyUrl = buildEmbedProxyUrl({
    targetUrl: input.targetUrl,
    requestOrigin: input.internalOrigin,
    referrerUrl: input.referrerUrl,
  });
  if (!proxyUrl) return null;
  const controller = new AbortController();
  const timeoutId = setTimeout(() => controller.abort(), Math.max(8_000, Number(input.timeoutMs || EMBED_PROXY_FETCH_TIMEOUT_MS)));
  try {
    const response = await fetch(proxyUrl, {
      method: "GET",
      cache: "no-store",
      redirect: "follow",
      signal: controller.signal,
      headers: {
        accept: "application/vnd.apple.mpegurl,application/x-mpegurl,text/plain,*/*",
        "user-agent": DEFAULT_USER_AGENT,
      },
    });
    if (!response.ok) return null;
    const body = await response.text().catch(() => "");
    return body.trim() ? body : null;
  } catch {
    return null;
  } finally {
    clearTimeout(timeoutId);
  }
}

async function fetchBinaryViaEmbedProxy(input: {
  targetUrl: string;
  internalOrigin: string;
  referrerUrl: string;
  timeoutMs?: number;
}) {
  const proxyUrl = buildEmbedProxyUrl({
    targetUrl: input.targetUrl,
    requestOrigin: input.internalOrigin,
    referrerUrl: input.referrerUrl,
  });
  if (!proxyUrl) {
    return { ok: false as const, status: 0, contentType: "", bodyBase64: "", error: "invalid-proxy-url" };
  }
  const controller = new AbortController();
  const timeoutId = setTimeout(() => controller.abort(), Math.max(8_000, Number(input.timeoutMs || EMBED_PROXY_FETCH_TIMEOUT_MS)));
  try {
    const response = await fetch(proxyUrl, {
      method: "GET",
      cache: "no-store",
      redirect: "follow",
      signal: controller.signal,
      headers: {
        accept: "*/*",
        "user-agent": DEFAULT_USER_AGENT,
      },
    });
    if (!response.ok) {
      return {
        ok: false as const,
        status: Number(response.status || 0),
        contentType: String(response.headers.get("content-type") || ""),
        bodyBase64: "",
        error: `embed-proxy-http-${Number(response.status || 0)}`,
      };
    }
    const bytes = Buffer.from(await response.arrayBuffer());
    return {
      ok: true as const,
      status: Number(response.status || 200),
      contentType: String(response.headers.get("content-type") || "application/octet-stream"),
      bodyBase64: bytes.toString("base64"),
      error: "",
    };
  } catch (error) {
    return {
      ok: false as const,
      status: 0,
      contentType: "",
      bodyBase64: "",
      error: error instanceof Error ? error.message : String(error || "embed-proxy-fetch-failed"),
    };
  } finally {
    clearTimeout(timeoutId);
  }
}

export function buildLivekoraSessionManifestUrl(matchId: number, internalOrigin: string) {
  return `${String(internalOrigin || resolveInternalAppOrigin()).replace(/\/+$/, "")}/api/livekora/session-manifest?matchId=${encodeURIComponent(String(matchId))}`;
}

export const livekoraProvider: LiveStreamProvider = {
  id: "livekora",
  publicPathPrefix: "live/livekora",
  sourceSelector: pickLivekoraSourceUrl,
  isAllowedSource: isAllowedLivekoraSource,
  async extractCurrentManifest(input) {
    try {
      const extracted = await withTimeout(
        runEmbedProxyLivekoraExtractor(input),
        EMBED_PROXY_EXTRACT_TIMEOUT_MS + 5_000,
        "livekora-embed-proxy-timeout"
      );
      const manifestUrl = normalizeHttpUrl(String(extracted?.manifestUrl || "").trim());
      const upstreamReferrerUrl = normalizeHttpUrl(String(extracted?.referrerUrl || "").trim()) || input.sourceUrl;
      let manifestBody = String(extracted?.manifestBody || "").trim();

      if (!manifestUrl || !manifestBody || !/^\s*#extm3u/m.test(manifestBody)) {
        return {
          ok: false,
          error: String(extracted?.error || "embed-proxy-manifest-missing"),
          playbackUrl: input.sourceUrl,
          currentSource: "",
          mediaSequence: null,
          targetDurationSec: 0,
          refreshed: false,
          rotated: false,
          adapterKind: "livekora",
          candidatesFound: 0,
          candidatesTried: 1,
        };
      }

      let finalUrl = manifestUrl;
      if (!hasMediaSegments(manifestBody, finalUrl)) {
        const variantUrl = pickVariantManifestUrl(manifestBody, finalUrl);
        if (!variantUrl) {
          return {
            ok: false,
            error: "embed-proxy-variant-missing",
            playbackUrl: input.sourceUrl,
            currentSource: manifestUrl,
            mediaSequence: null,
            targetDurationSec: 0,
            refreshed: false,
            rotated: false,
            adapterKind: "livekora",
            candidatesFound: 1,
            candidatesTried: 1,
          };
        }
        const variantBody = await fetchTextViaEmbedProxy({
          targetUrl: variantUrl,
          internalOrigin: input.internalOrigin,
          referrerUrl: upstreamReferrerUrl,
        });
        if (!variantBody || !hasMediaSegments(variantBody, variantUrl)) {
          return {
            ok: false,
            error: "embed-proxy-variant-fetch-failed",
            playbackUrl: input.sourceUrl,
            currentSource: variantUrl,
            mediaSequence: null,
            targetDurationSec: 0,
            refreshed: false,
            rotated: false,
            adapterKind: "livekora",
            candidatesFound: 1,
            candidatesTried: 2,
          };
        }
        manifestBody = variantBody;
        finalUrl = variantUrl;
      }

      return {
        ok: true,
        manifestBody: rewriteManifestForLivekoraSession({
          manifest: manifestBody,
          baseUrl: finalUrl,
          internalOrigin: input.internalOrigin,
          sourceUrl: input.sourceUrl,
          referrerUrl: upstreamReferrerUrl,
        }),
        finalUrl,
        targetUrl: finalUrl,
        fetchUrl: buildEmbedProxyUrl({
          targetUrl: finalUrl,
          requestOrigin: input.internalOrigin,
          referrerUrl: upstreamReferrerUrl,
        }),
        referrerUrl: upstreamReferrerUrl,
        playbackUrl: String(extracted?.playbackUrl || input.sourceUrl).trim() || input.sourceUrl,
        currentSource: finalUrl,
        mediaSequence: parseMediaSequence(manifestBody),
        targetDurationSec: parseTargetDurationSec(manifestBody),
        refreshed: false,
        rotated: false,
        adapterKind: "livekora",
        candidatesFound: 1,
        candidatesTried: 1,
        sessionOwned: true,
      };
    } catch (error) {
      return {
        ok: false,
        error: error instanceof Error ? error.message : String(error || "livekora-embed-proxy-failed"),
        playbackUrl: input.sourceUrl,
        currentSource: "",
        mediaSequence: null,
        targetDurationSec: 0,
        refreshed: false,
        rotated: false,
        adapterKind: "livekora",
        candidatesFound: 0,
        candidatesTried: 0,
      };
    }
  },
  async fetchAsset(input) {
    const referrerUrl = normalizeHttpUrl(String(input.referrerUrl || "").trim()) || input.sourceUrl;
    return await fetchBinaryViaEmbedProxy({
      targetUrl: input.assetUrl,
      internalOrigin: input.internalOrigin,
      referrerUrl,
      timeoutMs: input.timeoutMs,
    });
  },
};

export const liveProviders = [livekoraProvider] as const;
