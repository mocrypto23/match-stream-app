import axios from "axios";

import type {
  LiveStreamProvider,
  MatchRowLike,
  ProviderAssetResult,
  ProviderContext,
  ProviderManifestResult,
} from "@/lib/live-providers";
import { createTimingSummary } from "@/lib/live-providers";
import { ensureLiveEmbedSessionRuntime } from "@/lib/repack-embed-session";
import { buildPlayerv2Candidates } from "@/lib/repack-ingest-resolver";
import { playerv2RuntimeAdapter } from "@/lib/repack-runtime-adapters/playerv2";
import { primeRuntimeHint, rewriteManifestForSessionMirror } from "@/lib/repack-runtime-adapters/shared";

const SIIIR_DAY_PAGE_URL = "https://w6.siiir.tv/today-matches/";
const SIIIR_HOST_SUFFIXES = ["siiir.tv", "yallashot.us"] as const;
const DAY_PAGE_CACHE_TTL_MS = 90_000;
const RUNTIME_SOURCE_TTL_MS = 90_000;
const FAST_PLAYERV_PAGE_TIMEOUT_MS = 3_500;
const FAST_PLAYERV_BUILD_TIMEOUT_MS = 2_600;
const FAST_MANIFEST_TIMEOUT_MS = 2_400;
const FAST_MANIFEST_CONCURRENCY = 3;
const FAST_MANIFEST_MAX_CANDIDATES = 6;
const DEFAULT_USER_AGENT =
  "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/145.0.0.0 Safari/537.36";

type CachedDayPage = {
  fetchedAt: number;
  matches: Array<{
    homeTeam: string;
    awayTeam: string;
    href: string;
  }>;
};

type CachedRuntimeSource = {
  sourceUrl: string;
  runtimeSourceUrl: string;
  playbackUrl: string;
  updatedAt: number;
};

type FastResolvedManifest = {
  candidateUrl: string;
  targetUrl: string;
  fetchUrl: string;
  referrerUrl: string;
  manifestBody: string;
  finalUrl: string;
};

let cachedDayPage: CachedDayPage | null = null;
const cachedRuntimeSources = new Map<string, CachedRuntimeSource>();

function normalizeHttpUrl(rawUrl: string) {
  try {
    const parsed = new URL(String(rawUrl || "").trim());
    return parsed.protocol === "http:" || parsed.protocol === "https:" ? parsed.toString() : "";
  } catch {
    return "";
  }
}

function isTemplatedRuntimeUrl(rawUrl: string) {
  const value = String(rawUrl || "").trim();
  return value.includes("${") || /encodeURIComponent\s*\(/i.test(value);
}

function hostMatchesAnySuffix(host: string, suffixes: readonly string[]) {
  const normalized = String(host || "").trim().toLowerCase().replace(/\.$/, "");
  if (!normalized) return false;
  return suffixes.some((suffix) => normalized === suffix || normalized.endsWith(`.${suffix}`));
}

function isSiiirGenericPage(rawUrl: string) {
  const normalized = normalizeHttpUrl(rawUrl);
  if (!normalized) return false;
  try {
    const parsed = new URL(normalized);
    if (!hostMatchesAnySuffix(parsed.hostname, ["siiir.tv"])) return false;
    const pathname = String(parsed.pathname || "").replace(/\/+$/, "") || "/";
    return pathname === "/" || pathname === "/today-matches";
  } catch {
    return false;
  }
}

function isSiiirUsableSource(rawUrl: string) {
  const normalized = normalizeHttpUrl(rawUrl);
  if (!normalized) return false;
  try {
    const parsed = new URL(normalized);
    const host = parsed.hostname.toLowerCase();
    const pathname = String(parsed.pathname || "").toLowerCase();
    if (hostMatchesAnySuffix(host, ["yallashot.us"])) {
      return pathname.includes("/hard/") || /\/playerv\d+\.php/i.test(pathname);
    }
    if (hostMatchesAnySuffix(host, ["siiir.tv"])) {
      return !isSiiirGenericPage(normalized);
    }
    return false;
  } catch {
    return false;
  }
}

function runtimeCacheKey(sourceUrl: string) {
  return normalizeHttpUrl(sourceUrl).toLowerCase();
}

function readCachedRuntimeSource(sourceUrl: string) {
  const key = runtimeCacheKey(sourceUrl);
  if (!key) return null;
  const cached = cachedRuntimeSources.get(key);
  if (!cached) return null;
  if (
    !normalizeHttpUrl(cached.runtimeSourceUrl) ||
    !normalizeHttpUrl(cached.playbackUrl) ||
    isTemplatedRuntimeUrl(cached.runtimeSourceUrl) ||
    isTemplatedRuntimeUrl(cached.playbackUrl)
  ) {
    cachedRuntimeSources.delete(key);
    return null;
  }
  if (cached.updatedAt + RUNTIME_SOURCE_TTL_MS <= Date.now()) {
    cachedRuntimeSources.delete(key);
    return null;
  }
  return cached;
}

function writeCachedRuntimeSource(state: CachedRuntimeSource) {
  const key = runtimeCacheKey(state.sourceUrl);
  if (!key) return state;
  cachedRuntimeSources.set(key, state);
  return state;
}

function normalizeTeamName(value: unknown) {
  return String(value || "")
    .toLowerCase()
    .replace(/[\u064b-\u065f\u0670\u0610-\u061a]/g, "")
    .replace(/[\u0623\u0625\u0622]/g, "\u0627")
    .replace(/\u0649/g, "\u064a")
    .replace(/\u0624/g, "\u0648")
    .replace(/\u0626/g, "\u064a")
    .replace(/\u0629/g, "\u0647")
    .replace(/[^a-z0-9\u0600-\u06ff]+/g, "");
}

function unorderedPairKey(home: unknown, away: unknown) {
  const left = normalizeTeamName(home);
  const right = normalizeTeamName(away);
  if (!left || !right) return "";
  return [left, right].sort().join("|");
}

function decodeHtmlEntities(value: string) {
  return String(value || "")
    .replace(/&#8211;/g, "-")
    .replace(/&#8217;/g, "'")
    .replace(/&#8220;/g, '"')
    .replace(/&#8221;/g, '"')
    .replace(/&nbsp;/g, " ")
    .replace(/&amp;/g, "&");
}

function parseTodayMatches(html: string) {
  const out: CachedDayPage["matches"] = [];
  const cardRe =
    /<div[^>]+class=['"][^'"]*\bAY_Match\b[^'"]*['"][\s\S]*?<div[^>]+class=['"][^'"]*\bTM_Name\b[^'"]*['"][^>]*>\s*([^<]+?)\s*<\/div>[\s\S]*?<div[^>]+class=['"][^'"]*\bTM_Name\b[^'"]*['"][^>]*>\s*([^<]+?)\s*<\/div>[\s\S]*?<a[^>]+href=["']([^"'#]+(?:\?[^"'#]*)?)["']/gi;

  let match: RegExpExecArray | null = null;
  while ((match = cardRe.exec(html))) {
    const homeTeam = decodeHtmlEntities(String(match[1] || "").trim());
    const awayTeam = decodeHtmlEntities(String(match[2] || "").trim());
    const href = normalizeHttpUrl(String(match[3] || "").trim());
    if (!homeTeam || !awayTeam || !href) continue;
    out.push({ homeTeam, awayTeam, href });
  }
  return out;
}

async function fetchTodayMatches() {
  if (cachedDayPage && cachedDayPage.fetchedAt + DAY_PAGE_CACHE_TTL_MS > Date.now()) {
    return cachedDayPage.matches;
  }

  const response = await axios.get<string>(SIIIR_DAY_PAGE_URL, {
    responseType: "text",
    timeout: 14_000,
    maxRedirects: 5,
    validateStatus: () => true,
    headers: {
      "user-agent": DEFAULT_USER_AGENT,
      accept: "text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8",
      "accept-language": "ar,en;q=0.9",
    },
  });
  const html = String(response.data || "");
  const matches = Number(response.status || 0) >= 200 && Number(response.status || 0) < 300 ? parseTodayMatches(html) : [];
  cachedDayPage = {
    fetchedAt: Date.now(),
    matches,
  };
  return matches;
}

async function findTodayMatchSource(row: MatchRowLike) {
  const pairKey = unorderedPairKey(row?.home_team, row?.away_team);
  if (!pairKey) return null;
  const dayMatches = await fetchTodayMatches().catch(() => [] as CachedDayPage["matches"]);
  return dayMatches.find((candidate) => unorderedPairKey(candidate.homeTeam, candidate.awayTeam) === pairKey) || null;
}

function extractPlayerv2UrlFromHardPage(pageUrl: string, html: string) {
  const directMatch = String(html.match(/https?:\/\/[^"'`\s]+\/playerv\d+\.php\?[^"'`\s]+/i)?.[0] || "").trim();
  const directUrl =
    directMatch && !directMatch.includes("${") && !/encodeURIComponent\s*\(/i.test(directMatch)
      ? normalizeHttpUrl(directMatch)
      : "";
  if (directUrl) return directUrl;

  const playerTemplateMatch = html.match(
    /playerUrl\s*=\s*`(https?:\/\/[^`]+?\/playerv\d+\.php\?match=match)\$\{encodeURIComponent\(matchId\)\}(&key=[^`]+)`/i
  );
  const sourceMatchId = String(new URL(pageUrl).searchParams.get("match") || "").trim();
  if (playerTemplateMatch?.[1] && playerTemplateMatch?.[2] && sourceMatchId) {
    return normalizeHttpUrl(`${playerTemplateMatch[1]}${encodeURIComponent(sourceMatchId)}${playerTemplateMatch[2]}`);
  }
  return "";
}

async function resolveSiiirRuntimeSource(sourceUrl: string, options?: { forceRefresh?: boolean }) {
  const normalized = normalizeHttpUrl(sourceUrl);
  if (!normalized) return null;
  if (isTemplatedRuntimeUrl(normalized)) return null;
  if (/\/playerv\d+\.php/i.test(String(new URL(normalized).pathname || "").toLowerCase())) {
    return {
      runtimeSourceUrl: normalized,
      playbackUrl: normalized,
    };
  }

  const cached = options?.forceRefresh ? null : readCachedRuntimeSource(normalized);
  if (cached) {
    return {
      runtimeSourceUrl: cached.runtimeSourceUrl,
      playbackUrl: cached.playbackUrl,
    };
  }

  const response = await axios.get<string>(normalized, {
    responseType: "text",
    timeout: 14_000,
    maxRedirects: 5,
    validateStatus: () => true,
    headers: {
      "user-agent": DEFAULT_USER_AGENT,
      accept: "text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8",
      "accept-language": "ar,en;q=0.9",
      referer: normalized,
    },
  });
  if (Number(response.status || 0) < 200 || Number(response.status || 0) >= 300) return null;
  const html = String(response.data || "");
  const runtimeSourceUrl = extractPlayerv2UrlFromHardPage(normalized, html);
  if (!runtimeSourceUrl || isTemplatedRuntimeUrl(runtimeSourceUrl)) return null;

  writeCachedRuntimeSource({
    sourceUrl: normalized,
    runtimeSourceUrl,
    playbackUrl: normalized,
    updatedAt: Date.now(),
  });

  return {
    runtimeSourceUrl,
    playbackUrl: normalized,
  };
}

function mapManifestResult(
  result: Awaited<ReturnType<typeof playerv2RuntimeAdapter.currentManifest>>,
  playbackUrl: string
): ProviderManifestResult {
  if (!result.ok) {
    return {
      ok: false,
      error: result.error,
      playbackUrl: result.playbackUrl || playbackUrl,
      currentSource: result.currentSource,
      mediaSequence: result.mediaSequence,
      targetDurationSec: result.targetDurationSec,
      refreshed: result.refreshed,
      rotated: result.rotated,
      adapterKind: "playerv2",
      candidatesFound: result.candidatesFound,
      candidatesTried: result.candidatesTried,
    };
  }

  return {
    ok: true,
    manifestBody: result.manifestBody,
    finalUrl: result.finalUrl,
    targetUrl: result.targetUrl,
    fetchUrl: result.fetchUrl,
    referrerUrl: result.referrerUrl,
    playbackUrl: result.playbackUrl || playbackUrl,
    currentSource: result.currentSource,
    mediaSequence: result.mediaSequence,
    targetDurationSec: result.targetDurationSec,
    refreshed: result.refreshed,
    rotated: result.rotated,
    adapterKind: "playerv2",
    candidatesFound: result.candidatesFound,
    candidatesTried: result.candidatesTried,
    sessionOwned: true,
  };
}

function mapAssetResult(result: Awaited<ReturnType<typeof playerv2RuntimeAdapter.fetchAsset>>): ProviderAssetResult {
  return {
    ok: !!result.ok,
    status: Number(result.status || 0),
    contentType: String(result.contentType || ""),
    bodyBase64: String(result.bodyBase64 || ""),
    error: String(result.error || ""),
  };
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

function resolveManifestUrl(raw: string, baseUrl: string) {
  const value = String(raw || "").trim();
  if (!value) return "";
  try {
    const absolute = new URL(value, baseUrl).toString();
    return normalizeHttpUrl(absolute);
  } catch {
    return "";
  }
}

function looksLikeManifestResponse(contentType: string, body: string, finalUrl: string) {
  const text = String(body || "");
  const ct = String(contentType || "").toLowerCase();
  if (/^\s*#extm3u/im.test(text)) return true;
  if (ct.includes("application/vnd.apple.mpegurl") || ct.includes("application/x-mpegurl")) return true;
  return String(finalUrl || "").toLowerCase().includes(".m3u8");
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
    if (trimmed.startsWith("#")) continue;
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

function preferFastPlayervCandidate(candidateUrl: string) {
  const value = String(candidateUrl || "").trim();
  let score = 0;
  if (value.startsWith("/api/embed-proxy?")) score += 200;
  if (value.includes("/kooora/")) score += 120;
  if (/[?&]sid=/i.test(value)) score += 60;
  if (/[?&]token=/i.test(value)) score += 40;
  if (value.toLowerCase().includes(".m3u8")) score += 20;
  return score;
}

function looksLikeFastPlayervPage(body: string) {
  const text = String(body || "")
    .replace(/\\u002f/gi, "/")
    .replace(/\\\//g, "/")
    .replace(/&amp;/gi, "&")
    .toLowerCase();
  return (
    text.includes("window.tabsconfig") ||
    /playerv\d+\.php\?action=generate_token/i.test(text) ||
    text.includes("data-mobile-path=") ||
    text.includes("data-path=") ||
    text.includes("albaplayer_name") ||
    text.includes("/kooora/")
  );
}

async function fetchFastManifestResponse(input: {
  requestUrl: string;
  referrerUrl: string;
  timeoutMs: number;
}) {
  const controller = new AbortController();
  const timeoutId = setTimeout(() => controller.abort(), input.timeoutMs);
  try {
    const response = await fetch(input.requestUrl, {
      method: "GET",
      cache: "no-store",
      redirect: "follow",
      signal: controller.signal,
      headers: {
        "user-agent": DEFAULT_USER_AGENT,
        accept: "application/vnd.apple.mpegurl,application/x-mpegurl,text/plain,*/*",
        "accept-language": "ar,en;q=0.9",
        referer: input.referrerUrl,
      },
    });
    const body = await response.text();
    const contentType = String(response.headers.get("content-type") || "").trim();
    const proxiedTarget = normalizeHttpUrl(String(response.headers.get("x-embed-proxy-target") || "").trim());
    const finalUrl = normalizeHttpUrl(proxiedTarget || response.url || input.requestUrl) || input.requestUrl;
    return {
      ok: response.ok,
      status: Number(response.status || 0),
      body: String(body || ""),
      contentType,
      finalUrl,
      fetchUrl: String(input.requestUrl || "").trim(),
    };
  } catch (error) {
    return {
      ok: false,
      status: 0,
      body: "",
      contentType: "",
      finalUrl: String(input.requestUrl || "").trim(),
      fetchUrl: String(input.requestUrl || "").trim(),
      error: error instanceof Error ? error.message : String(error || "fast-manifest-fetch-failed"),
    };
  } finally {
    clearTimeout(timeoutId);
  }
}

async function resolveFastPlayervManifest(input: {
  runtimeSourceUrl: string;
  playbackUrl: string;
  internalOrigin: string;
}) {
  const startedAt = Date.now();
  let pageFetchMs = 0;
  let candidateBuildMs = 0;
  let manifestProbeMs = 0;

  const pageFetchStartedAt = Date.now();
  const pageResponse = await axios
    .get<string>(input.runtimeSourceUrl, {
      responseType: "text",
      timeout: FAST_PLAYERV_PAGE_TIMEOUT_MS,
      maxRedirects: 5,
      validateStatus: () => true,
      headers: {
        "user-agent": DEFAULT_USER_AGENT,
        accept: "text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8",
        "accept-language": "ar,en;q=0.9",
        referer: input.playbackUrl || input.runtimeSourceUrl,
      },
    })
    .catch(() => null);
  pageFetchMs = Date.now() - pageFetchStartedAt;

  const pageHtml =
    Number(pageResponse?.status || 0) >= 200 && Number(pageResponse?.status || 0) < 300
      ? String(pageResponse?.data || "").trim()
      : "";
  if (!pageHtml || !looksLikeFastPlayervPage(pageHtml)) {
    return {
      ok: false as const,
      timingSummary: createTimingSummary("fast_page_missing", {
        total: Date.now() - startedAt,
        fastPageFetch: pageFetchMs,
      }, {
        pageStatus: Number(pageResponse?.status || 0),
        bodyLength: pageHtml.length,
      }),
    };
  }

  const candidateBuildStartedAt = Date.now();
  const fastCandidates = await buildPlayerv2Candidates(
    input.runtimeSourceUrl,
    pageHtml,
    FAST_PLAYERV_BUILD_TIMEOUT_MS,
    input.internalOrigin
  ).catch(() => [] as string[]);
  candidateBuildMs = Date.now() - candidateBuildStartedAt;

  const orderedCandidates = Array.from(new Set(fastCandidates))
    .sort((left, right) => preferFastPlayervCandidate(right) - preferFastPlayervCandidate(left))
    .slice(0, FAST_MANIFEST_MAX_CANDIDATES);
  if (!orderedCandidates.length) {
    return {
      ok: false as const,
      timingSummary: createTimingSummary("fast_candidates_missing", {
        total: Date.now() - startedAt,
        fastPageFetch: pageFetchMs,
        fastCandidateBuild: candidateBuildMs,
      }),
    };
  }

  let candidatesTried = 0;
  const probeStartedAt = Date.now();
  let cursor = 0;
  let resolved: FastResolvedManifest | null = null;

  const workers = Array.from({ length: Math.min(FAST_MANIFEST_CONCURRENCY, orderedCandidates.length) }, async () => {
    while (resolved === null && cursor < orderedCandidates.length) {
      const candidateUrl = orderedCandidates[cursor];
      cursor += 1;
      if (!candidateUrl) continue;
      candidatesTried += 1;
      const requestUrl = candidateUrl.startsWith("/")
        ? new URL(candidateUrl, `${String(input.internalOrigin || "").replace(/\/+$/, "")}/`).toString()
        : candidateUrl;
      const first = await fetchFastManifestResponse({
        requestUrl,
        referrerUrl: input.runtimeSourceUrl,
        timeoutMs: FAST_MANIFEST_TIMEOUT_MS,
      });
      if (!first.ok || !looksLikeManifestResponse(first.contentType, first.body, first.finalUrl)) continue;

      let manifestBody = first.body;
      let finalUrl = first.finalUrl;
      let referrerUrl = input.runtimeSourceUrl;
      if (!hasMediaSegments(manifestBody, finalUrl)) {
        const variantUrl = pickVariantManifestUrl(manifestBody, finalUrl);
        if (!variantUrl) continue;
        const second = await fetchFastManifestResponse({
          requestUrl: variantUrl,
          referrerUrl: finalUrl,
          timeoutMs: FAST_MANIFEST_TIMEOUT_MS,
        });
        if (!second.ok || !looksLikeManifestResponse(second.contentType, second.body, second.finalUrl)) continue;
        if (!hasMediaSegments(second.body, second.finalUrl)) continue;
        manifestBody = second.body;
        referrerUrl = finalUrl;
        finalUrl = second.finalUrl;
      }

      resolved = {
        candidateUrl,
        targetUrl: finalUrl,
        fetchUrl: requestUrl,
        referrerUrl,
        manifestBody,
        finalUrl,
      };
      break;
    }
  });

  await Promise.all(workers);
  manifestProbeMs = Date.now() - probeStartedAt;

  if (!resolved) {
    return {
      ok: false as const,
      timingSummary: createTimingSummary("fast_probe_failed", {
        total: Date.now() - startedAt,
        fastPageFetch: pageFetchMs,
        fastCandidateBuild: candidateBuildMs,
        fastManifestProbe: manifestProbeMs,
      }, {
        candidatesFound: orderedCandidates.length,
        candidatesTried,
      }),
    };
  }

  const finalResolved = resolved as FastResolvedManifest;

  const runtimeInput = {
    sourceUrl: input.runtimeSourceUrl,
    slotServer: 2 as const,
    internalOrigin: input.internalOrigin,
  };
  primeRuntimeHint(runtimeInput, {
    targetUrl: finalResolved.targetUrl,
    fetchUrl: finalResolved.fetchUrl,
    referrerUrl: finalResolved.referrerUrl,
  });
  void ensureLiveEmbedSessionRuntime({
    sourceUrl: input.runtimeSourceUrl,
    requestOrigin: input.internalOrigin,
    slotServerId: 2,
    timeoutMs: 8_000,
  }).catch(() => null);

  return {
    ok: true as const,
    result: {
      ok: true as const,
      manifestBody: rewriteManifestForSessionMirror(
        finalResolved.manifestBody,
        finalResolved.finalUrl,
        input.internalOrigin,
        input.runtimeSourceUrl,
        2
      ),
      finalUrl: finalResolved.finalUrl,
      targetUrl: finalResolved.targetUrl,
      fetchUrl: finalResolved.fetchUrl,
      referrerUrl: finalResolved.referrerUrl,
      playbackUrl: input.playbackUrl,
      currentSource: finalResolved.targetUrl,
      mediaSequence: parseMediaSequence(finalResolved.manifestBody),
      targetDurationSec: parseTargetDurationSec(finalResolved.manifestBody),
      refreshed: false,
      rotated: false,
      adapterKind: "playerv2" as const,
      candidatesFound: orderedCandidates.length,
      candidatesTried,
      sessionOwned: true as const,
    },
    timingSummary: createTimingSummary("fast_resolved", {
      total: Date.now() - startedAt,
      fastPageFetch: pageFetchMs,
      fastCandidateBuild: candidateBuildMs,
      fastManifestProbe: manifestProbeMs,
    }, {
      candidatesFound: orderedCandidates.length,
      candidatesTried,
    }),
  };
}

export function isAllowedSiiirSource(rawUrl: string) {
  const normalized = normalizeHttpUrl(rawUrl);
  if (!normalized) return false;
  try {
    return hostMatchesAnySuffix(new URL(normalized).hostname, SIIIR_HOST_SUFFIXES);
  } catch {
    return false;
  }
}

export async function pickSiiirSourceUrl(row: MatchRowLike) {
  const canonicalTodayMatch = await findTodayMatchSource(row);
  if (canonicalTodayMatch?.href && isSiiirUsableSource(canonicalTodayMatch.href)) {
    return canonicalTodayMatch.href;
  }

  const direct = String(row?.stream_url_2 || "").trim();
  if (isSiiirUsableSource(direct)) return direct;
  return canonicalTodayMatch?.href || null;
}

export function buildSiiirSessionManifestUrl(matchId: number, internalOrigin: string) {
  return `${String(internalOrigin || "").replace(/\/+$/, "")}/api/siiir/session-manifest?matchId=${encodeURIComponent(String(matchId))}`;
}

export const siiirProvider: LiveStreamProvider = {
  id: "siiir",
  label: "siiir.tv",
  order: 3,
  publicPathPrefix: "live/siiir",
  sourceSelector: pickSiiirSourceUrl,
  isAllowedSource: isAllowedSiiirSource,
  async extractCurrentManifest(input: ProviderContext, options) {
    const startedAt = Date.now();
    let runtimeResolveMs = 0;
    let fastPathMs = 0;
    let manifestAttemptMs = 0;
    let refreshResolveMs = 0;
    let refreshManifestMs = 0;
    const initialRuntimeSource = await resolveSiiirRuntimeSource(input.sourceUrl, { forceRefresh: !!options?.forceRefresh });
    runtimeResolveMs = Date.now() - startedAt;
    if (!initialRuntimeSource?.runtimeSourceUrl) {
      return {
        ok: false,
        error: "siiir-runtime-source-missing",
        playbackUrl: input.sourceUrl,
        currentSource: "",
        mediaSequence: null,
        targetDurationSec: 0,
        refreshed: false,
        rotated: false,
        adapterKind: "playerv2",
        candidatesFound: 0,
        candidatesTried: 0,
        timingSummary: createTimingSummary("runtime_source_missing", {
          total: runtimeResolveMs,
          resolveRuntimeSource: runtimeResolveMs,
        }),
      };
    }

    let runtimeSource = initialRuntimeSource;
    const fastPathStartedAt = Date.now();
    const fastPathResult =
      !options?.forceRefresh
        ? await resolveFastPlayervManifest({
            runtimeSourceUrl: runtimeSource.runtimeSourceUrl,
            playbackUrl: runtimeSource.playbackUrl,
            internalOrigin: input.internalOrigin,
          }).catch(() => null)
        : null;
    fastPathMs = Date.now() - fastPathStartedAt;
    if (fastPathResult?.ok) {
      return {
        ...fastPathResult.result,
        timingSummary: createTimingSummary("fast_resolved", {
          total: Date.now() - startedAt,
          resolveRuntimeSource: runtimeResolveMs,
          fastPath: fastPathMs,
        }, {
          detail: fastPathResult.timingSummary,
        }),
      };
    }

    let manifestStartedAt = Date.now();
    let resolved = await playerv2RuntimeAdapter.currentManifest(
      {
        sourceUrl: runtimeSource.runtimeSourceUrl,
        slotServer: 2,
        internalOrigin: input.internalOrigin,
      },
      options
    );
    manifestAttemptMs = Date.now() - manifestStartedAt;

    if (!resolved.ok) {
      const refreshResolveStartedAt = Date.now();
      const refreshedRuntimeSource = await resolveSiiirRuntimeSource(input.sourceUrl, { forceRefresh: true });
      refreshResolveMs = Date.now() - refreshResolveStartedAt;
      if (refreshedRuntimeSource?.runtimeSourceUrl) {
        runtimeSource = refreshedRuntimeSource;
        const refreshManifestStartedAt = Date.now();
        resolved = await playerv2RuntimeAdapter.currentManifest(
          {
            sourceUrl: runtimeSource.runtimeSourceUrl,
            slotServer: 2,
            internalOrigin: input.internalOrigin,
          },
          {
            ...options,
            forceRefresh: true,
          }
        );
        refreshManifestMs = Date.now() - refreshManifestStartedAt;
      }
    }

    const mapped = mapManifestResult(resolved, runtimeSource.playbackUrl);
    const totalMs = Date.now() - startedAt;
    const timingSummary = createTimingSummary(mapped.ok ? "resolved" : "resolved_failed", {
      total: totalMs,
      resolveRuntimeSource: runtimeResolveMs,
      fastPath: fastPathMs,
      manifest: manifestAttemptMs,
      refreshResolveRuntimeSource: refreshResolveMs,
      refreshManifest: refreshManifestMs,
    }, {
      fastPathDetail: fastPathResult?.timingSummary || "",
    });
    return {
      ...mapped,
      timingSummary,
    };
  },
  async fetchAsset(input) {
    const initialRuntimeSource = await resolveSiiirRuntimeSource(input.sourceUrl);
    let effectiveSourceUrl = initialRuntimeSource?.runtimeSourceUrl || input.sourceUrl;
    let assetResult = await playerv2RuntimeAdapter.fetchAsset({
      sourceUrl: effectiveSourceUrl,
      slotServer: 2,
      internalOrigin: input.internalOrigin,
      assetUrl: input.assetUrl,
      referrerUrl: input.referrerUrl,
      timeoutMs: input.timeoutMs,
    });

    const shouldRetryWithFreshRuntimeSource =
      !assetResult.ok &&
      (Number(assetResult.status || 0) === 0 ||
        Number(assetResult.status || 0) === 403 ||
        Number(assetResult.status || 0) === 404 ||
        Number(assetResult.status || 0) >= 500);

    if (shouldRetryWithFreshRuntimeSource) {
      const refreshedRuntimeSource = await resolveSiiirRuntimeSource(input.sourceUrl, { forceRefresh: true });
      if (refreshedRuntimeSource?.runtimeSourceUrl && refreshedRuntimeSource.runtimeSourceUrl !== effectiveSourceUrl) {
        effectiveSourceUrl = refreshedRuntimeSource.runtimeSourceUrl;
        assetResult = await playerv2RuntimeAdapter.fetchAsset({
          sourceUrl: effectiveSourceUrl,
          slotServer: 2,
          internalOrigin: input.internalOrigin,
          assetUrl: input.assetUrl,
          referrerUrl: input.referrerUrl,
          timeoutMs: input.timeoutMs,
        });
      }
    }

    return mapAssetResult(
      assetResult
    );
  },
};
