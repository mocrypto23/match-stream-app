import { execFile } from "node:child_process";
import path from "node:path";
import axios from "axios";

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

type DirectExtractorOutput = {
  ok?: boolean;
  manifestUrl?: string;
  manifestBody?: string;
  referrerUrl?: string;
  manifestRequestHeaders?: Record<string, string>;
  playbackUrl?: string;
  error?: string;
};

type CachedSourceState = {
  sourceUrl: string;
  manifestUrl: string;
  referrerUrl: string;
  requestHeaders: Record<string, string>;
  playbackUrl: string;
  updatedAt: number;
  lastMediaSequence: number | null;
};

const LIVEKORA_HOST_SUFFIXES = ["sportsurges.cc", "livekora.vip", "koooralive.click", "kooraxx.com"] as const;
const DIRECT_EXTRACT_TIMEOUT_MS = 22_000;
const DIRECT_FETCH_TIMEOUT_MS = 15_000;
const WAIT_RETRY_INTERVAL_MS = 700;
const SOURCE_STATE_TTL_MS = 10 * 60_000;
const DEFAULT_USER_AGENT =
  "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/145.0.0.0 Safari/537.36";

const livekoraSourceState = new Map<string, CachedSourceState>();

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

function normalizeHeaderMap(headers?: Record<string, string> | null) {
  const out: Record<string, string> = {};
  for (const [key, value] of Object.entries(headers || {})) {
    const normalizedKey = String(key || "").trim().toLowerCase();
    const normalizedValue = String(value || "").trim();
    if (!normalizedKey || !normalizedValue) continue;
    out[normalizedKey] = normalizedValue;
  }
  return out;
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

function buildSessionAssetUrl(input: {
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

function rewriteManifestForSession(input: {
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
      buildSessionAssetUrl({
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

function buildSourceStateKey(sourceUrl: string) {
  return normalizeHttpUrl(sourceUrl).toLowerCase();
}

function readSourceState(sourceUrl: string) {
  const key = buildSourceStateKey(sourceUrl);
  const cached = livekoraSourceState.get(key);
  if (!cached) return null;
  if (cached.updatedAt + SOURCE_STATE_TTL_MS <= Date.now()) {
    livekoraSourceState.delete(key);
    return null;
  }
  return cached;
}

function writeSourceState(state: CachedSourceState) {
  livekoraSourceState.set(buildSourceStateKey(state.sourceUrl), state);
  return state;
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

function sleep(ms: number) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function buildFetchHeaders(input: {
  requestHeaders?: Record<string, string> | null;
  referrerUrl: string;
  accept: string;
}) {
  const requestHeaders = normalizeHeaderMap(input.requestHeaders);
  const referrerUrl = normalizeHttpUrl(input.referrerUrl);
  const out: Record<string, string> = {
    accept: input.accept,
    "user-agent": requestHeaders["user-agent"] || DEFAULT_USER_AGENT,
  };
  const referer = requestHeaders["referer"] || requestHeaders["referrer"] || referrerUrl;
  if (referer) out.referer = referer;
  const origin = requestHeaders["origin"] || (referer ? new URL(referer).origin : "");
  if (origin) out.origin = origin;
  for (const key of [
    "accept-language",
    "cookie",
    "sec-ch-ua",
    "sec-ch-ua-mobile",
    "sec-ch-ua-platform",
    "sec-fetch-site",
    "sec-fetch-mode",
    "sec-fetch-dest",
  ]) {
    if (requestHeaders[key]) out[key] = requestHeaders[key];
  }
  return out;
}

async function fetchTextWithHeaders(input: {
  url: string;
  requestHeaders?: Record<string, string> | null;
  referrerUrl: string;
  timeoutMs?: number;
}) {
  const targetUrl = normalizeHttpUrl(input.url);
  if (!targetUrl) return null;
  try {
    const response = await axios.get<string>(targetUrl, {
      responseType: "text",
      timeout: Math.max(8_000, Number(input.timeoutMs || DIRECT_FETCH_TIMEOUT_MS)),
      maxRedirects: 5,
      validateStatus: () => true,
      headers: buildFetchHeaders({
        requestHeaders: input.requestHeaders,
        referrerUrl: input.referrerUrl,
        accept: "application/vnd.apple.mpegurl,application/x-mpegurl,text/plain,*/*",
      }),
    });
    if (Number(response.status || 0) < 200 || Number(response.status || 0) >= 300) return null;
    const body = String(response.data || "");
    return body.trim() ? body : null;
  } catch {
    return null;
  }
}

async function fetchBinaryWithHeaders(input: {
  url: string;
  requestHeaders?: Record<string, string> | null;
  referrerUrl: string;
  timeoutMs?: number;
}) {
  const targetUrl = normalizeHttpUrl(input.url);
  if (!targetUrl) {
    return { ok: false as const, status: 0, contentType: "", bodyBase64: "", error: "invalid-asset-url" };
  }
  try {
    const response = await axios.get<ArrayBuffer>(targetUrl, {
      responseType: "arraybuffer",
      timeout: Math.max(8_000, Number(input.timeoutMs || DIRECT_FETCH_TIMEOUT_MS)),
      maxRedirects: 5,
      validateStatus: () => true,
      headers: buildFetchHeaders({
        requestHeaders: input.requestHeaders,
        referrerUrl: input.referrerUrl,
        accept: "*/*",
      }),
    });
    if (Number(response.status || 0) < 200 || Number(response.status || 0) >= 300) {
      return {
        ok: false as const,
        status: Number(response.status || 0),
        contentType: String(response.headers["content-type"] || ""),
        bodyBase64: "",
        error: `asset-http-${Number(response.status || 0)}`,
      };
    }
    const bytes = Buffer.from(response.data);
    return {
      ok: true as const,
      status: Number(response.status || 200),
      contentType: String(response.headers["content-type"] || "application/octet-stream"),
      bodyBase64: bytes.toString("base64"),
      error: "",
    };
  } catch (error) {
    return {
      ok: false as const,
      status: 0,
      contentType: "",
      bodyBase64: "",
      error: error instanceof Error ? error.message : String(error || "asset-fetch-failed"),
    };
  }
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

function runDirectLivekoraExtractor(sourceUrl: string) {
  const scriptPath = path.join(process.cwd(), "server", "livekora-direct-extract.js");
  return new Promise<DirectExtractorOutput | null>((resolve) => {
    execFile(
      process.execPath,
      [scriptPath, sourceUrl],
      {
        cwd: process.cwd(),
        timeout: DIRECT_EXTRACT_TIMEOUT_MS + 8_000,
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
          resolve(JSON.parse(raw) as DirectExtractorOutput);
        } catch {
          resolve(null);
        }
      }
    );
  });
}

async function discoverLivekoraState(input: ProviderContext) {
  const extracted = await runDirectLivekoraExtractor(input.sourceUrl);
  const manifestUrl = normalizeHttpUrl(String(extracted?.manifestUrl || "").trim());
  const requestHeaders = normalizeHeaderMap(extracted?.manifestRequestHeaders);
  const referrerUrl = normalizeHttpUrl(String(extracted?.referrerUrl || "").trim()) || input.sourceUrl;
  if (!manifestUrl) {
    return {
      ok: false as const,
      error: String(extracted?.error || "direct-manifest-url-missing"),
      extracted,
    };
  }

  let manifestBody = String(extracted?.manifestBody || "").trim();
  if (!manifestBody || !/^\s*#extm3u/m.test(manifestBody)) {
    manifestBody = String(
      (await fetchTextWithHeaders({
        url: manifestUrl,
        requestHeaders,
        referrerUrl,
      })) || ""
    ).trim();
  }
  if (!manifestBody || !/^\s*#extm3u/m.test(manifestBody)) {
    return {
      ok: false as const,
      error: String(extracted?.error || "direct-manifest-body-missing"),
      extracted,
    };
  }

  let finalUrl = manifestUrl;
  if (!hasMediaSegments(manifestBody, finalUrl)) {
    const variantUrl = pickVariantManifestUrl(manifestBody, finalUrl);
    if (!variantUrl) {
      return {
        ok: false as const,
        error: "direct-variant-missing",
        extracted,
      };
    }
    const variantBody = await fetchTextWithHeaders({
      url: variantUrl,
      requestHeaders,
      referrerUrl,
    });
    if (!variantBody || !hasMediaSegments(variantBody, variantUrl)) {
      return {
        ok: false as const,
        error: "direct-variant-fetch-failed",
        extracted,
      };
    }
    manifestBody = variantBody;
    finalUrl = variantUrl;
  }

  const cached = writeSourceState({
    sourceUrl: input.sourceUrl,
    manifestUrl: finalUrl,
    referrerUrl,
    requestHeaders,
    playbackUrl: normalizeHttpUrl(String(extracted?.playbackUrl || "").trim()) || input.sourceUrl,
    updatedAt: Date.now(),
    lastMediaSequence: parseMediaSequence(manifestBody),
  });

  return {
    ok: true as const,
    state: cached,
    manifestBody,
    finalUrl,
  };
}

async function resolveManifestFromState(input: ProviderContext, state: CachedSourceState) {
  let manifestBody = await fetchTextWithHeaders({
    url: state.manifestUrl,
    requestHeaders: state.requestHeaders,
    referrerUrl: state.referrerUrl,
  });
  if (!manifestBody || !/^\s*#extm3u/m.test(manifestBody)) {
    return null;
  }

  let finalUrl = state.manifestUrl;
  if (!hasMediaSegments(manifestBody, finalUrl)) {
    const variantUrl = pickVariantManifestUrl(manifestBody, finalUrl);
    if (!variantUrl) return null;
    const variantBody = await fetchTextWithHeaders({
      url: variantUrl,
      requestHeaders: state.requestHeaders,
      referrerUrl: state.referrerUrl,
    });
    if (!variantBody || !hasMediaSegments(variantBody, variantUrl)) return null;
    manifestBody = variantBody;
    finalUrl = variantUrl;
  }

  const mediaSequence = parseMediaSequence(manifestBody);
  writeSourceState({
    ...state,
    manifestUrl: finalUrl,
    updatedAt: Date.now(),
    lastMediaSequence: mediaSequence,
  });

  return {
    manifestBody,
    finalUrl,
    mediaSequence,
    targetDurationSec: parseTargetDurationSec(manifestBody),
  };
}

export function buildLivekoraSessionManifestUrl(matchId: number, internalOrigin: string) {
  return `${String(internalOrigin || resolveInternalAppOrigin()).replace(/\/+$/, "")}/api/livekora/session-manifest?matchId=${encodeURIComponent(String(matchId))}`;
}

export const livekoraProvider: LiveStreamProvider = {
  id: "livekora",
  publicPathPrefix: "live/livekora",
  sourceSelector: pickLivekoraSourceUrl,
  isAllowedSource: isAllowedLivekoraSource,
  async extractCurrentManifest(input, options) {
    const waitForMediaSequence =
      Number.isFinite(Number(options?.waitForMediaSequence)) ? Number(options?.waitForMediaSequence) : null;
    const waitDeadlineAt =
      waitForMediaSequence !== null
        ? Date.now() + Math.max(1_000, Math.min(12_000, Number(options?.waitTimeoutMs || 5_000)))
        : 0;

    let state = readSourceState(input.sourceUrl);
    let attempts = 0;
    let lastError = "livekora-manifest-unavailable";

    while (attempts < 3) {
      attempts += 1;
      let discoveredResolved:
        | {
            manifestBody: string;
            finalUrl: string;
            mediaSequence: number | null;
            targetDurationSec: number;
          }
        | null = null;
      if (!state || options?.forceRefresh) {
        let discovered:
          | Awaited<ReturnType<typeof discoverLivekoraState>>
          | null = null;
        try {
          discovered = await withTimeout(
            discoverLivekoraState(input),
            DIRECT_EXTRACT_TIMEOUT_MS + 5_000,
            "livekora-direct-discovery-timeout"
          );
        } catch (error) {
          lastError = error instanceof Error ? error.message : String(error || "livekora-direct-discovery-failed");
          state = null;
          continue;
        }
        if (!discovered.ok) {
          lastError = discovered.error;
          state = null;
          continue;
        }
        state = discovered.state;
        discoveredResolved = {
          manifestBody: discovered.manifestBody,
          finalUrl: discovered.finalUrl,
          mediaSequence: parseMediaSequence(discovered.manifestBody),
          targetDurationSec: parseTargetDurationSec(discovered.manifestBody),
        };
      }

      const resolved = discoveredResolved || (await resolveManifestFromState(input, state));
      if (!resolved) {
        lastError = "livekora-manifest-fetch-failed";
        livekoraSourceState.delete(buildSourceStateKey(input.sourceUrl));
        state = null;
        continue;
      }

      if (
        waitForMediaSequence !== null &&
        resolved.mediaSequence !== null &&
        resolved.mediaSequence <= waitForMediaSequence &&
        Date.now() < waitDeadlineAt
      ) {
        await sleep(WAIT_RETRY_INTERVAL_MS);
        continue;
      }

      return {
        ok: true,
        manifestBody: rewriteManifestForSession({
          manifest: resolved.manifestBody,
          baseUrl: resolved.finalUrl,
          internalOrigin: input.internalOrigin,
          sourceUrl: input.sourceUrl,
          referrerUrl: state.referrerUrl,
        }),
        finalUrl: resolved.finalUrl,
        targetUrl: resolved.finalUrl,
        fetchUrl: resolved.finalUrl,
        referrerUrl: state.referrerUrl,
        playbackUrl: state.playbackUrl || input.sourceUrl,
        currentSource: resolved.finalUrl,
        mediaSequence: resolved.mediaSequence,
        targetDurationSec: resolved.targetDurationSec,
        refreshed: attempts > 1,
        rotated: false,
        adapterKind: "livekora",
        candidatesFound: 1,
        candidatesTried: attempts,
        sessionOwned: true,
      };
    }

    return {
      ok: false,
      error: lastError,
      playbackUrl: input.sourceUrl,
      currentSource: state?.manifestUrl || "",
      mediaSequence: state?.lastMediaSequence ?? null,
      targetDurationSec: 0,
      refreshed: attempts > 1,
      rotated: false,
      adapterKind: "livekora",
      candidatesFound: state ? 1 : 0,
      candidatesTried: attempts,
    };
  },
  async fetchAsset(input) {
    const state = readSourceState(input.sourceUrl);
    const referrerUrl =
      normalizeHttpUrl(String(input.referrerUrl || "").trim()) || state?.referrerUrl || input.sourceUrl;
    return await fetchBinaryWithHeaders({
      url: input.assetUrl,
      requestHeaders: state?.requestHeaders,
      referrerUrl,
      timeoutMs: input.timeoutMs,
    });
  },
};

export const liveProviders = [livekoraProvider] as const;
