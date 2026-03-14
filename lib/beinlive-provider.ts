import axios from "axios";

import { beinRuntimeAdapter } from "@/lib/repack-runtime-adapters/bein";
import type {
  LiveStreamProvider,
  MatchRowLike,
  ProviderAssetResult,
  ProviderContext,
  ProviderManifestResult,
} from "@/lib/live-providers";

const BEINLIVE_DAY_PAGE_URL = "https://www.bein-live.com/matches-today_3/";
const BEINLIVE_HOST_SUFFIXES = ["bein-live.com"] as const;
const DAY_PAGE_CACHE_TTL_MS = 90_000;
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

let cachedDayPage: CachedDayPage | null = null;

function normalizeHttpUrl(rawUrl: string) {
  try {
    const parsed = new URL(String(rawUrl || "").trim());
    return parsed.protocol === "http:" || parsed.protocol === "https:" ? parsed.toString() : "";
  } catch {
    return "";
  }
}

function hostMatchesAnySuffix(host: string, suffixes: readonly string[]) {
  const normalized = String(host || "").trim().toLowerCase().replace(/\.$/, "");
  if (!normalized) return false;
  return suffixes.some((suffix) => normalized === suffix || normalized.endsWith(`.${suffix}`));
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
    /<div[^>]+class=['"][^'"]*\bAY_Match\b[^'"]*['"][\s\S]*?<div[^>]+class=['"][^'"]*\bTM_Name\b[^'"]*['"][^>]*>\s*([^<]+?)\s*<\/div>[\s\S]*?<div[^>]+class=['"][^'"]*\bTM_Name\b[^'"]*['"][^>]*>\s*([^<]+?)\s*<\/div>[\s\S]*?<a[^>]+href=["']([^"'?#]+\/matches\/[^"'?#]+\/?)["']/gi;

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

  const response = await axios.get<string>(BEINLIVE_DAY_PAGE_URL, {
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

export function isAllowedBeinliveSource(rawUrl: string) {
  const normalized = normalizeHttpUrl(rawUrl);
  if (!normalized) return false;
  try {
    const parsed = new URL(normalized);
    return hostMatchesAnySuffix(parsed.hostname, BEINLIVE_HOST_SUFFIXES) && String(parsed.pathname || "").includes("/matches/");
  } catch {
    return false;
  }
}

export async function pickBeinliveSourceUrl(row: MatchRowLike) {
  const direct = String(row?.stream_url || "").trim();
  if (isAllowedBeinliveSource(direct)) return direct;

  const pairKey = unorderedPairKey(row?.home_team, row?.away_team);
  if (!pairKey) return null;

  const dayMatches = await fetchTodayMatches().catch(() => [] as CachedDayPage["matches"]);
  const found = dayMatches.find((candidate) => unorderedPairKey(candidate.homeTeam, candidate.awayTeam) === pairKey);
  return found?.href || null;
}

export function buildBeinlivePublicPlaylistUrl(matchId: number, publicBaseUrl?: string) {
  if (!Number.isFinite(matchId) || matchId <= 0) return null;
  const base =
    String(publicBaseUrl || process.env.LIVEKORA_R2_PUBLIC_BASE_URL || "https://r2.tf-player.site/live")
      .trim()
      .replace(/\/+$/, "");
  if (!base) return null;
  return `${base}/beinlive/m${matchId}/index.m3u8`;
}

export function buildBeinliveSessionManifestUrl(matchId: number, internalOrigin: string) {
  return `${String(internalOrigin || "").replace(/\/+$/, "")}/api/beinlive/session-manifest?matchId=${encodeURIComponent(String(matchId))}`;
}

function mapManifestResult(result: Awaited<ReturnType<typeof beinRuntimeAdapter.currentManifest>>): ProviderManifestResult {
  if (!result.ok) {
    return {
      ok: false,
      error: result.error,
      playbackUrl: result.playbackUrl,
      currentSource: result.currentSource,
      mediaSequence: result.mediaSequence,
      targetDurationSec: result.targetDurationSec,
      refreshed: result.refreshed,
      rotated: result.rotated,
      adapterKind: "bein",
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
    playbackUrl: result.playbackUrl,
    currentSource: result.currentSource,
    mediaSequence: result.mediaSequence,
    targetDurationSec: result.targetDurationSec,
    refreshed: result.refreshed,
    rotated: result.rotated,
    adapterKind: "bein",
    candidatesFound: result.candidatesFound,
    candidatesTried: result.candidatesTried,
    sessionOwned: true,
  };
}

function mapAssetResult(result: Awaited<ReturnType<typeof beinRuntimeAdapter.fetchAsset>>): ProviderAssetResult {
  return {
    ok: !!result.ok,
    status: Number(result.status || 0),
    contentType: String(result.contentType || ""),
    bodyBase64: String(result.bodyBase64 || ""),
    error: String(result.error || ""),
  };
}

export const beinliveProvider: LiveStreamProvider = {
  id: "beinlive",
  label: "bein-live",
  order: 2,
  publicPathPrefix: "live/beinlive",
  sourceSelector: pickBeinliveSourceUrl,
  isAllowedSource: isAllowedBeinliveSource,
  async extractCurrentManifest(input: ProviderContext, options) {
    return mapManifestResult(
      await beinRuntimeAdapter.currentManifest(
        {
          sourceUrl: input.sourceUrl,
          slotServer: 1,
          internalOrigin: input.internalOrigin,
        },
        options
      )
    );
  },
  async fetchAsset(input) {
    return mapAssetResult(
      await beinRuntimeAdapter.fetchAsset({
        sourceUrl: input.sourceUrl,
        slotServer: 1,
        internalOrigin: input.internalOrigin,
        assetUrl: input.assetUrl,
        referrerUrl: input.referrerUrl,
        timeoutMs: input.timeoutMs,
      })
    );
  },
};
