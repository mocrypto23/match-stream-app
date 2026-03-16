import { execFile } from "node:child_process";
import path from "node:path";
import axios from "axios";
import type { StreamProviderId } from "@/lib/stream-source-types";

export type MatchRowLike = {
  stream_url?: string | null;
  stream_url_2?: string | null;
  stream_url_3?: string | null;
  stream_url_4?: string | null;
  home_team?: string | null;
  away_team?: string | null;
  match_start?: string | null;
  match_day?: string | null;
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
      adapterKind: "livekora" | "bein" | "playerv2";
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
      adapterKind: "livekora" | "bein" | "playerv2";
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
  id: StreamProviderId;
  label: string;
  order: number;
  publicPathPrefix: string;
  sourceSelector: (row: MatchRowLike) => string | null | Promise<string | null>;
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
  candidates?: Array<{
    manifestUrl?: string;
    manifestBody?: string;
    referrerUrl?: string;
    manifestRequestHeaders?: Record<string, string>;
    playbackUrl?: string;
  }>;
  error?: string;
};

type CachedSourceCandidateState = {
  manifestUrl: string;
  referrerUrl: string;
  requestHeaders: Record<string, string>;
  playbackUrl: string;
  updatedAt: number;
  lastMediaSequence: number | null;
  lastError: string;
  failureCount: number;
};

type CachedSourceState = {
  sourceUrl: string;
  updatedAt: number;
  activeIndex: number;
  lastMediaSequence: number | null;
  candidates: CachedSourceCandidateState[];
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

function isSequenceRollback(nextMediaSequence: number | null, previousMediaSequence: number | null) {
  if (!Number.isFinite(nextMediaSequence) || !Number.isFinite(previousMediaSequence)) return false;
  return Number(nextMediaSequence) + 2 < Number(previousMediaSequence);
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

function buildCandidateStateKey(candidate: {
  manifestUrl: string;
  playbackUrl: string;
}) {
  return `${normalizeHttpUrl(candidate.manifestUrl).toLowerCase()}::${normalizeHttpUrl(candidate.playbackUrl).toLowerCase()}`;
}

function sanitizeSourceState(state: CachedSourceState | null) {
  if (!state) return null;
  const candidates = (state.candidates || [])
    .map((candidate) => ({
      manifestUrl: normalizeHttpUrl(candidate.manifestUrl),
      referrerUrl: normalizeHttpUrl(candidate.referrerUrl),
      requestHeaders: normalizeHeaderMap(candidate.requestHeaders),
      playbackUrl: normalizeHttpUrl(candidate.playbackUrl),
      updatedAt: Number(candidate.updatedAt || Date.now()),
      lastMediaSequence: Number.isFinite(candidate.lastMediaSequence) ? Number(candidate.lastMediaSequence) : null,
      lastError: String(candidate.lastError || ""),
      failureCount: Math.max(0, Number(candidate.failureCount || 0)),
    }))
    .filter((candidate) => candidate.manifestUrl && candidate.referrerUrl && candidate.playbackUrl);

  if (!candidates.length) return null;

  return {
    sourceUrl: normalizeHttpUrl(state.sourceUrl),
    updatedAt: Number(state.updatedAt || Date.now()),
    activeIndex: Math.max(0, Math.min(candidates.length - 1, Number(state.activeIndex || 0))),
    lastMediaSequence: Number.isFinite(state.lastMediaSequence) ? Number(state.lastMediaSequence) : null,
    candidates,
  } satisfies CachedSourceState;
}

function readSourceState(sourceUrl: string) {
  const key = buildSourceStateKey(sourceUrl);
  const cached = sanitizeSourceState(livekoraSourceState.get(key) || null);
  if (!cached) return null;
  if (cached.updatedAt + SOURCE_STATE_TTL_MS <= Date.now()) {
    livekoraSourceState.delete(key);
    return null;
  }
  return cached;
}

function writeSourceState(state: CachedSourceState) {
  const normalized = sanitizeSourceState(state);
  if (!normalized) return null;
  livekoraSourceState.set(buildSourceStateKey(normalized.sourceUrl), normalized);
  return normalized;
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
  extraHeaders?: Record<string, string> | null;
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
  for (const [key, value] of Object.entries(normalizeHeaderMap(input.extraHeaders))) {
    out[key] = value;
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
  extraHeaders?: Record<string, string> | null;
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
        extraHeaders: input.extraHeaders,
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

function pickFirstMediaSegmentUrl(manifestText: string, baseUrl: string) {
  let previousExtInf = false;
  for (const line of String(manifestText || "").split(/\r?\n/)) {
    const trimmed = String(line || "").trim();
    if (!trimmed) continue;
    if (trimmed.startsWith("#EXTINF")) {
      previousExtInf = true;
      continue;
    }
    if (trimmed.startsWith("#")) {
      if (!trimmed.startsWith("#EXT-X-BYTERANGE")) previousExtInf = false;
      continue;
    }
    const absolute = resolveManifestUrl(trimmed, baseUrl);
    if (!absolute) {
      previousExtInf = false;
      continue;
    }
    if (previousExtInf) return absolute;
    previousExtInf = false;
  }
  return "";
}

type LivekoraCandidateResolution =
  | {
      ok: true;
      manifestBody: string;
      finalUrl: string;
      mediaSequence: number | null;
      targetDurationSec: number;
    }
  | {
      ok: false;
      error: string;
    };

type LivekoraResolvedStateResult = {
  state: CachedSourceState;
  manifestBody: string;
  finalUrl: string;
  mediaSequence: number | null;
  targetDurationSec: number;
  rotated: boolean;
};

type LivekoraResolveFromStateResult =
  | LivekoraResolvedStateResult
  | {
      error: string;
      state: CachedSourceState;
      rotated: boolean;
    };

function normalizeLivekoraCandidate(raw: {
  manifestUrl?: string;
  referrerUrl?: string;
  manifestRequestHeaders?: Record<string, string>;
  playbackUrl?: string;
} | null | undefined) {
  const manifestUrl = normalizeHttpUrl(String(raw?.manifestUrl || "").trim());
  const referrerUrl = normalizeHttpUrl(String(raw?.referrerUrl || "").trim());
  const playbackUrl = normalizeHttpUrl(String(raw?.playbackUrl || "").trim());
  if (!manifestUrl || !referrerUrl || !playbackUrl) return null;
  return {
    manifestUrl,
    referrerUrl,
    requestHeaders: normalizeHeaderMap(raw?.manifestRequestHeaders),
    playbackUrl,
    updatedAt: Date.now(),
    lastMediaSequence: null,
    lastError: "",
    failureCount: 0,
  } satisfies CachedSourceCandidateState;
}

function orderLivekoraCandidates(candidates: CachedSourceCandidateState[]) {
  return [...candidates].sort((left, right) => {
    if (left.failureCount !== right.failureCount) return left.failureCount - right.failureCount;
    return left.updatedAt - right.updatedAt;
  });
}

function buildDiscoveredLivekoraCandidates(input: ProviderContext, extracted: DirectExtractorOutput | null) {
  const orderedCandidates: CachedSourceCandidateState[] = [];
  const seen = new Set<string>();
  const pushCandidate = (raw: {
    manifestUrl?: string;
    referrerUrl?: string;
    manifestRequestHeaders?: Record<string, string>;
    playbackUrl?: string;
  } | null | undefined) => {
    const normalized = normalizeLivekoraCandidate(raw);
    if (!normalized) return;
    const key = buildCandidateStateKey(normalized);
    if (seen.has(key)) return;
    seen.add(key);
    orderedCandidates.push(normalized);
  };

  for (const candidate of extracted?.candidates || []) {
    pushCandidate(candidate);
  }
  pushCandidate({
    manifestUrl: extracted?.manifestUrl,
    referrerUrl: extracted?.referrerUrl || input.sourceUrl,
    manifestRequestHeaders: extracted?.manifestRequestHeaders,
    playbackUrl: extracted?.playbackUrl || input.sourceUrl,
  });

  if (!orderedCandidates.length) return [];
  return orderLivekoraCandidates(orderedCandidates);
}

async function resolveLivekoraCandidateManifest(
  candidate: CachedSourceCandidateState,
  options?: { verifySegment?: boolean }
): Promise<LivekoraCandidateResolution> {
  let manifestBody = await fetchTextWithHeaders({
    url: candidate.manifestUrl,
    requestHeaders: candidate.requestHeaders,
    referrerUrl: candidate.referrerUrl,
  });
  if (!manifestBody || !/^\s*#extm3u/im.test(manifestBody)) {
    return { ok: false, error: "livekora-manifest-fetch-failed" };
  }

  let finalUrl = candidate.manifestUrl;
  if (!hasMediaSegments(manifestBody, finalUrl)) {
    const variantUrl = pickVariantManifestUrl(manifestBody, finalUrl);
    if (!variantUrl) return { ok: false, error: "livekora-variant-missing" };
    const variantBody = await fetchTextWithHeaders({
      url: variantUrl,
      requestHeaders: candidate.requestHeaders,
      referrerUrl: candidate.referrerUrl,
    });
    if (!variantBody || !hasMediaSegments(variantBody, variantUrl)) {
      return { ok: false, error: "livekora-variant-fetch-failed" };
    }
    manifestBody = variantBody;
    finalUrl = variantUrl;
  }

  if (options?.verifySegment) {
    const segmentUrl = pickFirstMediaSegmentUrl(manifestBody, finalUrl);
    if (!segmentUrl) return { ok: false, error: "livekora-segment-missing" };
    const segmentProbe = await fetchBinaryWithHeaders({
      url: segmentUrl,
      requestHeaders: candidate.requestHeaders,
      referrerUrl: candidate.referrerUrl,
      timeoutMs: 6_000,
      extraHeaders: {
        range: "bytes=0-2047",
      },
    });
    if (!segmentProbe.ok) {
      return { ok: false, error: segmentProbe.error || "livekora-segment-probe-failed" };
    }
  }

  return {
    ok: true,
    manifestBody,
    finalUrl,
    mediaSequence: parseMediaSequence(manifestBody),
    targetDurationSec: parseTargetDurationSec(manifestBody),
  };
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

export function buildProviderPublicPlaylistUrl(providerId: StreamProviderId, matchId: number, publicBaseUrl?: string) {
  if (providerId === "livekora") return buildLivekoraPublicPlaylistUrl(matchId, publicBaseUrl);
  if (!Number.isFinite(matchId) || matchId <= 0) return null;
  const base =
    String(publicBaseUrl || process.env.LIVEKORA_R2_PUBLIC_BASE_URL || "https://r2.tf-player.site/live")
      .trim()
      .replace(/\/+$/, "");
  if (!base) return null;
  return providerId === "siiir" ? `${base}/siiir/m${matchId}/index.m3u8` : `${base}/beinlive/m${matchId}/index.m3u8`;
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
  const discoveredCandidates = buildDiscoveredLivekoraCandidates(input, extracted);
  if (!discoveredCandidates.length) {
    return {
      ok: false as const,
      error: String(extracted?.error || "direct-manifest-url-missing"),
      extracted,
    };
  }

  const state: CachedSourceState = {
    sourceUrl: input.sourceUrl,
    updatedAt: Date.now(),
    activeIndex: 0,
    lastMediaSequence: null,
    candidates: discoveredCandidates,
  };

  let lastError = String(extracted?.error || "livekora-candidate-probe-failed");
  for (let index = 0; index < state.candidates.length; index += 1) {
    const candidate = state.candidates[index];
    const resolved = await resolveLivekoraCandidateManifest(candidate, { verifySegment: true });
    if (!resolved.ok) {
      candidate.failureCount += 1;
      candidate.lastError = resolved.error;
      candidate.updatedAt = Date.now();
      lastError = resolved.error;
      continue;
    }

    candidate.manifestUrl = resolved.finalUrl;
    candidate.lastMediaSequence = resolved.mediaSequence;
    candidate.updatedAt = Date.now();
    candidate.lastError = "";
    candidate.failureCount = 0;
    state.activeIndex = index;
    state.updatedAt = Date.now();
    state.lastMediaSequence = resolved.mediaSequence;
    const cached = writeSourceState(state) || state;
    return {
      ok: true as const,
      state: cached,
      manifestBody: resolved.manifestBody,
      finalUrl: resolved.finalUrl,
      rotated: index > 0,
    };
  }

  writeSourceState(state);
  return {
    ok: false as const,
    error: lastError,
    extracted,
  };
}

async function resolveManifestFromState(
  _input: ProviderContext,
  state: CachedSourceState,
  options?: { allowRotate?: boolean }
): Promise<LivekoraResolveFromStateResult> {
  const originalActiveIndex = Math.max(0, Math.min(state.candidates.length - 1, state.activeIndex || 0));
  const orderedIndices = [originalActiveIndex];
  if (options?.allowRotate) {
    for (let index = 0; index < state.candidates.length; index += 1) {
      if (index === originalActiveIndex) continue;
      orderedIndices.push(index);
    }
  }

  let lastError = "livekora-manifest-fetch-failed";
  for (const index of orderedIndices) {
    const candidate = state.candidates[index];
    if (!candidate) continue;
    const resolved = await resolveLivekoraCandidateManifest(candidate, {
      verifySegment: index !== originalActiveIndex,
    });
    if (!resolved.ok) {
      candidate.failureCount += 1;
      candidate.lastError = resolved.error;
      candidate.updatedAt = Date.now();
      lastError = resolved.error;
      continue;
    }

    candidate.manifestUrl = resolved.finalUrl;
    candidate.lastMediaSequence = resolved.mediaSequence;
    candidate.updatedAt = Date.now();
    candidate.lastError = "";
    candidate.failureCount = 0;
    state.activeIndex = index;
    state.updatedAt = Date.now();
    state.lastMediaSequence = resolved.mediaSequence;
    const cached = writeSourceState(state) || state;
    return {
      manifestBody: resolved.manifestBody,
      finalUrl: resolved.finalUrl,
      mediaSequence: resolved.mediaSequence,
      targetDurationSec: resolved.targetDurationSec,
      state: cached,
      rotated: index !== originalActiveIndex,
    };
  }

  writeSourceState(state);
  return {
    error: lastError,
    state,
    rotated: false,
  };
}

export function buildLivekoraSessionManifestUrl(matchId: number, internalOrigin: string) {
  return `${String(internalOrigin || resolveInternalAppOrigin()).replace(/\/+$/, "")}/api/livekora/session-manifest?matchId=${encodeURIComponent(String(matchId))}`;
}

export const livekoraProvider: LiveStreamProvider = {
  id: "livekora",
  label: "livekora vip",
  order: 1,
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
    const maxAttempts =
      waitForMediaSequence !== null
        ? Math.max(3, Math.ceil(Math.max(0, waitDeadlineAt - Date.now()) / WAIT_RETRY_INTERVAL_MS) + 2)
        : 3;

    let state = readSourceState(input.sourceUrl);
    let attempts = 0;
    let lastError = "livekora-manifest-unavailable";

    while (attempts < maxAttempts) {
      attempts += 1;
      let discoveredResolved:
        | {
            state: CachedSourceState;
            manifestBody: string;
            finalUrl: string;
            mediaSequence: number | null;
            targetDurationSec: number;
            rotated: boolean;
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
          state: discovered.state,
          manifestBody: discovered.manifestBody,
          finalUrl: discovered.finalUrl,
          mediaSequence: parseMediaSequence(discovered.manifestBody),
          targetDurationSec: parseTargetDurationSec(discovered.manifestBody),
          rotated: discovered.rotated,
        };
      }

      const resolved = discoveredResolved || (await resolveManifestFromState(input, state, { allowRotate: options?.allowRotate }));
      if ("error" in resolved) {
        lastError = resolved.error || "livekora-manifest-fetch-failed";
        livekoraSourceState.delete(buildSourceStateKey(input.sourceUrl));
        state = null;
        continue;
      }
      const successfulResolved: LivekoraResolvedStateResult = resolved;
      state = successfulResolved.state;
      const activeState = state;
      if (!activeState) {
        lastError = "livekora-state-missing";
        continue;
      }
      const activeCandidate = activeState.candidates[activeState.activeIndex] || null;

      const unchangedSequence =
        waitForMediaSequence !== null &&
        successfulResolved.mediaSequence !== null &&
        successfulResolved.mediaSequence <= waitForMediaSequence &&
        !isSequenceRollback(successfulResolved.mediaSequence, waitForMediaSequence);

      if (
        unchangedSequence &&
        Date.now() < waitDeadlineAt
      ) {
        lastError = "media-sequence-unchanged";
        await sleep(WAIT_RETRY_INTERVAL_MS);
        continue;
      }

      return {
        ok: true,
        manifestBody: rewriteManifestForSession({
          manifest: successfulResolved.manifestBody,
          baseUrl: successfulResolved.finalUrl,
          internalOrigin: input.internalOrigin,
          sourceUrl: input.sourceUrl,
          referrerUrl: activeCandidate?.referrerUrl || input.sourceUrl,
        }),
        finalUrl: successfulResolved.finalUrl,
        targetUrl: successfulResolved.finalUrl,
        fetchUrl: successfulResolved.finalUrl,
        referrerUrl: activeCandidate?.referrerUrl || input.sourceUrl,
        playbackUrl: activeCandidate?.playbackUrl || input.sourceUrl,
        currentSource: successfulResolved.finalUrl,
        mediaSequence: successfulResolved.mediaSequence,
        targetDurationSec: successfulResolved.targetDurationSec,
        refreshed: attempts > 1,
        rotated: successfulResolved.rotated,
        adapterKind: "livekora",
        candidatesFound: activeState.candidates.length,
        candidatesTried: attempts,
        sessionOwned: true,
      };
    }

    const failedActiveIndex = state ? state.activeIndex : -1;

    return {
      ok: false,
      error: lastError,
      playbackUrl: input.sourceUrl,
      currentSource: (failedActiveIndex >= 0 ? state?.candidates[failedActiveIndex]?.manifestUrl : "") || "",
      mediaSequence: state?.lastMediaSequence ?? null,
      targetDurationSec: 0,
      refreshed: attempts > 1,
      rotated: false,
      adapterKind: "livekora",
      candidatesFound: state?.candidates.length || 0,
      candidatesTried: attempts,
    };
  },
  async fetchAsset(input) {
    const state = readSourceState(input.sourceUrl);
    const activeCandidate = state?.candidates[state.activeIndex];
    const referrerUrl =
      normalizeHttpUrl(String(input.referrerUrl || "").trim()) || activeCandidate?.referrerUrl || input.sourceUrl;
    return await fetchBinaryWithHeaders({
      url: input.assetUrl,
      requestHeaders: activeCandidate?.requestHeaders,
      referrerUrl,
      timeoutMs: input.timeoutMs,
    });
  },
};
