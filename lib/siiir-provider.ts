import axios from "axios";

import type {
  LiveStreamProvider,
  MatchRowLike,
  ProviderAssetResult,
  ProviderContext,
  ProviderManifestResult,
} from "@/lib/live-providers";
import { playerv2RuntimeAdapter } from "@/lib/repack-runtime-adapters/playerv2";

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
    const initialRuntimeSource = await resolveSiiirRuntimeSource(input.sourceUrl, { forceRefresh: !!options?.forceRefresh });
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
      };
    }

    let runtimeSource = initialRuntimeSource;
    let resolved = await playerv2RuntimeAdapter.currentManifest(
      {
        sourceUrl: runtimeSource.runtimeSourceUrl,
        slotServer: 2,
        internalOrigin: input.internalOrigin,
      },
      options
    );

    if (!resolved.ok) {
      const refreshedRuntimeSource = await resolveSiiirRuntimeSource(input.sourceUrl, { forceRefresh: true });
      if (refreshedRuntimeSource?.runtimeSourceUrl) {
        runtimeSource = refreshedRuntimeSource;
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
      }
    }

    return mapManifestResult(resolved, runtimeSource.playbackUrl);
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
