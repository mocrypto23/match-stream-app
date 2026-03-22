import axios from "axios";

import type {
  LiveStreamProvider,
  MatchRowLike,
  ProviderAssetResult,
  ProviderContext,
  ProviderManifestResult,
} from "@/lib/live-providers";
import { createTimingSummary } from "@/lib/live-providers";
import { fetchLiveEmbedText } from "@/lib/repack-embed-session";
import {
  buildPlayerv2Candidates,
  looksLikePlayerv2Html,
  looksLikePlayerv2PageUrl,
} from "@/lib/repack-ingest-resolver";
import { playerv2RuntimeAdapter } from "@/lib/repack-runtime-adapters/playerv2";
import {
  primeRuntimeHint,
  resolveSessionCandidateMediaManifest,
  rewriteManifestForSessionMirror,
} from "@/lib/repack-runtime-adapters/shared";

const SIIIR_DAY_PAGE_URL = "https://w6.siiir.tv/today-matches/";
const SIIIR_HOST_SUFFIXES = ["siiir.tv", "yallashot.us"] as const;
const DAY_PAGE_CACHE_TTL_MS = 90_000;
const RUNTIME_SOURCE_TTL_MS = 90_000;
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

type DirectSiiirAttempt = {
  ok: boolean;
  result?: ProviderManifestResult;
  error?: string;
  candidatesFound: number;
  candidatesTried: number;
  playervFetchMs: number;
  candidateBuildMs: number;
  manifestProbeMs: number;
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

function parseMediaSequence(manifestText: string) {
  const match = String(manifestText || "").match(/#EXT-X-MEDIA-SEQUENCE:(\d+)/i);
  return match ? Number.parseInt(match[1], 10) : null;
}

function parseTargetDurationSec(manifestText: string) {
  for (const line of String(manifestText || "").split(/\r?\n/)) {
    const match = String(line || "").trim().match(/^#EXT-X-TARGETDURATION:(\d+(?:\.\d+)?)/i);
    if (!match) continue;
    return Number.parseFloat(match[1]);
  }
  return 0;
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

function isDirectSiiirKoooraCandidate(candidate: string) {
  const value = String(candidate || "").trim();
  if (!value || value.includes("/api/embed-proxy")) return false;
  return value.includes("/kooora/") && value.includes("token=") && (value.includes("sid=") || value.includes("session_id="));
}

async function tryDirectSiiirKoooraManifest(
  input: ProviderContext,
  runtimeSource: { runtimeSourceUrl: string; playbackUrl: string }
): Promise<DirectSiiirAttempt> {
  const normalizedRuntimeSourceUrl = normalizeHttpUrl(runtimeSource.runtimeSourceUrl);
  if (!normalizedRuntimeSourceUrl || !looksLikePlayerv2PageUrl(normalizedRuntimeSourceUrl)) {
    return {
      ok: false,
      error: "direct-playerv-missing",
      candidatesFound: 0,
      candidatesTried: 0,
      playervFetchMs: 0,
      candidateBuildMs: 0,
      manifestProbeMs: 0,
    };
  }

  const normalizedPlaybackUrl = normalizeHttpUrl(runtimeSource.playbackUrl) || input.sourceUrl;
  const playervFetchStartedAt = Date.now();
  const fetched = await fetchLiveEmbedText({
    sourceUrl: normalizedRuntimeSourceUrl,
    requestOrigin: input.internalOrigin,
    slotServerId: 2,
    targetUrl: normalizedRuntimeSourceUrl,
    fetchUrl: normalizedRuntimeSourceUrl,
    referrerUrl: normalizedPlaybackUrl,
    timeoutMs: 9_000,
  }).catch(() => null);
  const playervFetchMs = Date.now() - playervFetchStartedAt;
  const playervBody = String(fetched?.body || "").trim();
  const playervContextUrl = normalizeHttpUrl(String(fetched?.finalUrl || normalizedRuntimeSourceUrl).trim()) || normalizedRuntimeSourceUrl;
  if (!fetched?.ok || !playervBody || !looksLikePlayerv2Html(playervBody)) {
    return {
      ok: false,
      error: "direct-playerv-html-missing",
      candidatesFound: 0,
      candidatesTried: 0,
      playervFetchMs,
      candidateBuildMs: 0,
      manifestProbeMs: 0,
    };
  }

  const candidateBuildStartedAt = Date.now();
  const candidates = (
    await buildPlayerv2Candidates(playervContextUrl, playervBody, 5_500, input.internalOrigin).catch(() => [] as string[])
  )
    .filter((candidate) => isDirectSiiirKoooraCandidate(candidate))
    .slice(0, 4);
  const candidateBuildMs = Date.now() - candidateBuildStartedAt;
  if (!candidates.length) {
    return {
      ok: false,
      error: "direct-kooora-candidates-missing",
      candidatesFound: 0,
      candidatesTried: 0,
      playervFetchMs,
      candidateBuildMs,
      manifestProbeMs: 0,
    };
  }

  const manifestProbeStartedAt = Date.now();
  let candidatesTried = 0;
  for (const candidate of candidates) {
    candidatesTried += 1;
    const resolved = await resolveSessionCandidateMediaManifest({
      sourceUrl: normalizedRuntimeSourceUrl,
      slotServer: 2,
      internalOrigin: input.internalOrigin,
      targetUrl: candidate,
      fetchUrl: candidate,
      referrerUrl: playervContextUrl,
      timeoutMs: 9_000,
    });
    if (!resolved.ok) continue;

    const manifestProbeMs = Date.now() - manifestProbeStartedAt;
    primeRuntimeHint(
      {
        sourceUrl: normalizedRuntimeSourceUrl,
        slotServer: 2,
        internalOrigin: input.internalOrigin,
      },
      {
        targetUrl: candidate,
        fetchUrl: candidate,
        referrerUrl: playervContextUrl,
      }
    );

    return {
      ok: true,
      result: {
        ok: true,
        manifestBody: rewriteManifestForSessionMirror(
          resolved.body,
          resolved.finalUrl,
          input.internalOrigin,
          normalizedRuntimeSourceUrl,
          2
        ),
        finalUrl: resolved.finalUrl,
        targetUrl: candidate,
        fetchUrl: candidate,
        referrerUrl: playervContextUrl,
        playbackUrl: normalizedPlaybackUrl,
        currentSource: candidate,
        mediaSequence: parseMediaSequence(resolved.body),
        targetDurationSec: parseTargetDurationSec(resolved.body),
        refreshed: false,
        rotated: false,
        adapterKind: "playerv2",
        candidatesFound: candidates.length,
        candidatesTried,
        sessionOwned: true,
      },
      candidatesFound: candidates.length,
      candidatesTried,
      playervFetchMs,
      candidateBuildMs,
      manifestProbeMs,
    };
  }

  return {
    ok: false,
    error: "direct-kooora-manifest-missing",
    candidatesFound: candidates.length,
    candidatesTried,
    playervFetchMs,
    candidateBuildMs,
    manifestProbeMs: Date.now() - manifestProbeStartedAt,
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
    let directPlayervFetchMs = 0;
    let directCandidateBuildMs = 0;
    let directManifestProbeMs = 0;
    let manifestAttemptMs = 0;
    let refreshResolveMs = 0;
    let refreshManifestMs = 0;
    let directCandidatesFound = 0;
    let directCandidatesTried = 0;
    let directError = "";
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
    const canTryDirectKoooraPath =
      !options?.forceRefresh &&
      (!Number.isFinite(Number(options?.waitForMediaSequence)) || Number(options?.waitForMediaSequence) < 0);
    if (canTryDirectKoooraPath) {
      const directResult = await tryDirectSiiirKoooraManifest(input, runtimeSource);
      directPlayervFetchMs = directResult.playervFetchMs;
      directCandidateBuildMs = directResult.candidateBuildMs;
      directManifestProbeMs = directResult.manifestProbeMs;
      directCandidatesFound = directResult.candidatesFound;
      directCandidatesTried = directResult.candidatesTried;
      directError = String(directResult.error || "");
      if (directResult.ok && directResult.result?.ok) {
        return {
          ...directResult.result,
          timingSummary: createTimingSummary("direct_kooora", {
            total: Date.now() - startedAt,
            resolveRuntimeSource: runtimeResolveMs,
            directPlayervFetch: directPlayervFetchMs,
            directCandidateBuild: directCandidateBuildMs,
            directManifestProbe: directManifestProbeMs,
          }, {
            directCandidatesFound,
            directCandidatesTried,
          }),
        };
      }
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
      directPlayervFetch: directPlayervFetchMs,
      directCandidateBuild: directCandidateBuildMs,
      directManifestProbe: directManifestProbeMs,
      manifest: manifestAttemptMs,
      refreshResolveRuntimeSource: refreshResolveMs,
      refreshManifest: refreshManifestMs,
    }, {
      directCandidatesFound,
      directCandidatesTried,
      directError,
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
