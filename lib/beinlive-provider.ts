import axios from "axios";

import { rewriteManifestForSessionMirror } from "@/lib/repack-runtime-adapters/shared";
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
const SOURCE_STATE_TTL_MS = 10 * 60_000;
const WAIT_RETRY_INTERVAL_MS = 700;
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

type CachedSourceState = {
  sourceUrl: string;
  manifestUrl: string;
  referrerUrl: string;
  playbackUrl: string;
  updatedAt: number;
  lastMediaSequence: number | null;
};

type ResolvedManifestState = {
  state: CachedSourceState;
  manifestBody: string;
  finalUrl: string;
  mediaSequence: number | null;
  targetDurationSec: number;
};

let cachedDayPage: CachedDayPage | null = null;
const beinliveSourceState = new Map<string, CachedSourceState>();

function sleep(ms: number) {
  return new Promise((resolve) => setTimeout(resolve, Math.max(0, ms)));
}

function decodeMaybeBase64(rawValue: string) {
  const value = String(rawValue || "").trim();
  if (!value) return "";
  try {
    const decoded = Buffer.from(value, "base64").toString("utf8").trim();
    return /^https?:\/\//i.test(decoded) ? decoded : value;
  } catch {
    return value;
  }
}

function normalizeHttpUrl(rawUrl: string) {
  try {
    const parsed = new URL(String(rawUrl || "").trim());
    return parsed.protocol === "http:" || parsed.protocol === "https:" ? parsed.toString() : "";
  } catch {
    return "";
  }
}

function buildSourceStateKey(sourceUrl: string) {
  return normalizeHttpUrl(sourceUrl).toLowerCase();
}

function readSourceState(sourceUrl: string) {
  const key = buildSourceStateKey(sourceUrl);
  if (!key) return null;
  const cached = beinliveSourceState.get(key);
  if (!cached) return null;
  if (cached.updatedAt + SOURCE_STATE_TTL_MS <= Date.now()) {
    beinliveSourceState.delete(key);
    return null;
  }
  return cached;
}

function writeSourceState(state: CachedSourceState) {
  const key = buildSourceStateKey(state.sourceUrl);
  if (!key) return state;
  beinliveSourceState.set(key, state);
  return state;
}

function clearSourceState(sourceUrl: string) {
  const key = buildSourceStateKey(sourceUrl);
  if (!key) return;
  beinliveSourceState.delete(key);
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

function computeAlbaSubdomain() {
  let value = Math.floor(Date.now() / 14_400_000) + Math.floor((Date.now() / 86_400_000) * 1.5);
  let length = (value % 7) + 6;
  const alphabet = "abcdefghijklmnopqrstuvwxyz";
  let out = "";
  while (length > 0) {
    out += alphabet[value % 26] || "";
    value = Math.floor(value / 26);
    length -= 1;
  }
  return out;
}

function buildRequestHeaders(referrerUrl: string, accept: string) {
  const referer = normalizeHttpUrl(referrerUrl);
  if (!referer) return null;
  return {
    "user-agent": DEFAULT_USER_AGENT,
    accept,
    referer,
    origin: new URL(referer).origin,
  };
}

async function fetchTextWithHeaders(url: string, referrerUrl: string) {
  const targetUrl = normalizeHttpUrl(url);
  const headers = buildRequestHeaders(referrerUrl, "application/vnd.apple.mpegurl,application/x-mpegurl,text/plain,*/*");
  if (!targetUrl || !headers) return null;
  const response = await axios.get<string>(targetUrl, {
    responseType: "text",
    timeout: 14_000,
    maxRedirects: 5,
    validateStatus: () => true,
    headers,
  });
  if (Number(response.status || 0) < 200 || Number(response.status || 0) >= 300) return null;
  const body = String(response.data || "").trim();
  return body || null;
}

async function fetchBinaryWithHeaders(input: {
  url: string;
  referrerUrl: string;
  timeoutMs?: number;
}): Promise<ProviderAssetResult> {
  const targetUrl = normalizeHttpUrl(input.url);
  const headers = buildRequestHeaders(input.referrerUrl, "*/*");
  if (!targetUrl) {
    return { ok: false, status: 0, contentType: "", bodyBase64: "", error: "invalid-asset-url" };
  }
  if (!headers) {
    return { ok: false, status: 0, contentType: "", bodyBase64: "", error: "invalid-referrer-url" };
  }

  try {
    const response = await axios.get<ArrayBuffer>(targetUrl, {
      responseType: "arraybuffer",
      timeout: Math.max(8_000, Number(input.timeoutMs || 22_000)),
      maxRedirects: 5,
      validateStatus: () => true,
      headers,
    });
    if (Number(response.status || 0) < 200 || Number(response.status || 0) >= 300) {
      return {
        ok: false,
        status: Number(response.status || 0),
        contentType: String(response.headers["content-type"] || ""),
        bodyBase64: "",
        error: `asset-http-${Number(response.status || 0)}`,
      };
    }
    const bytes = Buffer.from(response.data);
    return {
      ok: true,
      status: Number(response.status || 200),
      contentType: String(response.headers["content-type"] || ""),
      bodyBase64: bytes.toString("base64"),
      error: "",
    };
  } catch (error) {
    return {
      ok: false,
      status: 0,
      contentType: "",
      bodyBase64: "",
      error: error instanceof Error ? error.message : String(error || "asset-fetch-failed"),
    };
  }
}

async function resolveManifestFromState(state: CachedSourceState): Promise<ResolvedManifestState | null> {
  let manifestBody = await fetchTextWithHeaders(state.manifestUrl, state.referrerUrl);
  if (!manifestBody || !/^\s*#EXTM3U/im.test(manifestBody)) {
    return null;
  }

  let finalUrl = state.manifestUrl;
  if (!hasMediaSegments(manifestBody, finalUrl)) {
    const variantUrl = pickVariantManifestUrl(manifestBody, finalUrl);
    if (!variantUrl) return null;
    const variantBody = await fetchTextWithHeaders(variantUrl, state.referrerUrl);
    if (!variantBody || !hasMediaSegments(variantBody, variantUrl)) return null;
    manifestBody = variantBody;
    finalUrl = variantUrl;
  }

  const mediaSequence = parseMediaSequence(manifestBody);
  const nextState = writeSourceState({
    ...state,
    manifestUrl: finalUrl,
    updatedAt: Date.now(),
    lastMediaSequence: mediaSequence,
  });

  return {
    state: nextState,
    manifestBody,
    finalUrl,
    mediaSequence,
    targetDurationSec: parseTargetDurationSec(manifestBody),
  };
}

async function fetchBeinliveAjaxHtml(sourceUrl: string) {
  const pageResponse = await axios.get<string>(sourceUrl, {
    responseType: "text",
    timeout: 14_000,
    maxRedirects: 5,
    validateStatus: () => true,
    headers: {
      "user-agent": DEFAULT_USER_AGENT,
      accept: "text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8",
      "accept-language": "ar,en;q=0.9",
      referer: sourceUrl,
    },
  });
  if (Number(pageResponse.status || 0) < 200 || Number(pageResponse.status || 0) >= 300) return null;

  const pageHtml = String(pageResponse.data || "");
  const ajaxUrl =
    normalizeHttpUrl(String(pageHtml.match(/AlbaAjax\s*=\s*\{[^}]*"ajax_url":"([^"]+)"/i)?.[1] || "").trim()) ||
    "https://www.bein-live.com/wp-admin/admin-ajax.php";
  const matchId = String(pageHtml.match(/alba-ajax-servers-container[^>]*data-match-id=['"](\d+)['"]/i)?.[1] || "").trim();
  if (!matchId) return null;

  const serverResponse = await axios.post<string>(
    ajaxUrl,
    new URLSearchParams({
      action: "load_match_servers",
      match_id: matchId,
    }).toString(),
    {
      responseType: "text",
      timeout: 14_000,
      maxRedirects: 5,
      validateStatus: () => true,
      headers: {
        "user-agent": DEFAULT_USER_AGENT,
        "content-type": "application/x-www-form-urlencoded",
        referer: sourceUrl,
        origin: new URL(sourceUrl).origin,
      },
    }
  );

  if (Number(serverResponse.status || 0) < 200 || Number(serverResponse.status || 0) >= 300) return null;
  return String(serverResponse.data || "");
}

function extractBeinliveIframeUrl(serverHtml: string) {
  const raw =
    String(serverHtml.match(/data-vload=['"]([^'"]+)['"]/i)?.[1] || "").trim() ||
    String(serverHtml.match(/data-initial=['"]([^'"]+)['"]/i)?.[1] || "").trim() ||
    String(serverHtml.match(/data-id=['"]([^'"]+)['"]/i)?.[1] || "").trim() ||
    String(serverHtml.match(/data-url=['"]([^'"]+)['"]/i)?.[1] || "").trim();
  return normalizeHttpUrl(decodeMaybeBase64(raw));
}

function buildCandidateManifestUrls(input: {
  iframeHtml: string;
  currentSource?: string | null;
}) {
  const out: string[] = [];
  const pushUnique = (rawUrl: string) => {
    const normalized = normalizeHttpUrl(rawUrl);
    if (!normalized || out.includes(normalized)) return;
    out.push(normalized);
  };

  const currentSource = normalizeHttpUrl(String(input.currentSource || "").trim());
  if (currentSource) {
    pushUnique(currentSource);
    if (/\/master\.m3u8(?:$|\?)/i.test(currentSource)) {
      pushUnique(currentSource.replace(/\/master\.m3u8(?:$|\?)/i, "/live/index.m3u8"));
    }
  }

  const domainsMatch = input.iframeHtml.match(/const\s+D\s*=\s*\[([^\]]+)\]/i);
  const domains = (domainsMatch?.[1] || "")
    .split(",")
    .map((value) => value.replace(/['"`]/g, "").trim())
    .filter(Boolean);
  const channelKey =
    String(input.iframeHtml.match(/\/hls\/([^/]+)\/master\.m3u8/i)?.[1] || "").trim() ||
    String(currentSource.match(/\/hls\/([^/]+)\//i)?.[1] || "").trim();
  const subdomain = computeAlbaSubdomain();

  if (channelKey && domains.length) {
    for (const domain of domains) {
      pushUnique(`https://${subdomain}.${domain}/hls/${channelKey}/master.m3u8`);
      pushUnique(`https://${subdomain}.${domain}/hls/${channelKey}/live/index.m3u8`);
    }
  }

  return out;
}

async function resolveBeinliveIframeManifest(input: {
  sourceUrl: string;
  currentSource?: string | null;
}): Promise<(ResolvedManifestState & { candidatesFound: number; candidatesTried: number }) | null> {
  const serverHtml = await fetchBeinliveAjaxHtml(input.sourceUrl);
  if (!serverHtml) return null;

  const iframeUrl = extractBeinliveIframeUrl(serverHtml);
  if (!iframeUrl) return null;

  const iframeHtmlResponse = await axios.get<string>(iframeUrl, {
    responseType: "text",
    timeout: 14_000,
    maxRedirects: 5,
    validateStatus: () => true,
    headers: {
      "user-agent": DEFAULT_USER_AGENT,
      accept: "text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8",
      referer: input.sourceUrl,
      origin: new URL(input.sourceUrl).origin,
    },
  });
  if (Number(iframeHtmlResponse.status || 0) < 200 || Number(iframeHtmlResponse.status || 0) >= 300) return null;
  const iframeHtml = String(iframeHtmlResponse.data || "");

  const candidates = buildCandidateManifestUrls({
    iframeHtml,
    currentSource: input.currentSource,
  });

  for (const [index, candidateUrl] of candidates.entries()) {
    const candidateBody = await fetchTextWithHeaders(candidateUrl, iframeUrl).catch(() => null);
    if (!candidateBody || !/^\s*#EXTM3U/im.test(candidateBody)) continue;

    let finalUrl = candidateUrl;
    let manifestBody = candidateBody;
    if (!hasMediaSegments(manifestBody, finalUrl)) {
      const variantUrl = pickVariantManifestUrl(manifestBody, finalUrl);
      if (!variantUrl) continue;
      const variantBody = await fetchTextWithHeaders(variantUrl, iframeUrl).catch(() => null);
      if (!variantBody || !hasMediaSegments(variantBody, variantUrl)) continue;
      finalUrl = variantUrl;
      manifestBody = variantBody;
    }

    const mediaSequence = parseMediaSequence(manifestBody);
    const state = writeSourceState({
      sourceUrl: input.sourceUrl,
      manifestUrl: finalUrl,
      referrerUrl: iframeUrl,
      playbackUrl: iframeUrl,
      updatedAt: Date.now(),
      lastMediaSequence: mediaSequence,
    });

    return {
      state,
      manifestBody,
      finalUrl,
      mediaSequence,
      targetDurationSec: parseTargetDurationSec(manifestBody),
      candidatesFound: candidates.length,
      candidatesTried: index + 1,
    };
  }

  return null;
}

function buildManifestResult(input: {
  sourceUrl: string;
  internalOrigin: string;
  state: CachedSourceState;
  manifestBody: string;
  finalUrl: string;
  mediaSequence: number | null;
  targetDurationSec: number;
  refreshed: boolean;
  candidatesFound: number;
  candidatesTried: number;
}): ProviderManifestResult {
  return {
    ok: true,
    manifestBody: rewriteManifestForSessionMirror(input.manifestBody, input.finalUrl, input.internalOrigin, input.sourceUrl, 1),
    finalUrl: input.finalUrl,
    targetUrl: input.finalUrl,
    fetchUrl: input.finalUrl,
    referrerUrl: input.state.referrerUrl,
    playbackUrl: input.state.playbackUrl || input.sourceUrl,
    currentSource: input.finalUrl,
    mediaSequence: input.mediaSequence,
    targetDurationSec: input.targetDurationSec,
    refreshed: input.refreshed,
    rotated: false,
    adapterKind: "bein",
    candidatesFound: input.candidatesFound,
    candidatesTried: input.candidatesTried,
    sessionOwned: true,
  };
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

export const beinliveProvider: LiveStreamProvider = {
  id: "beinlive",
  label: "bein-live",
  order: 2,
  publicPathPrefix: "live/beinlive",
  sourceSelector: pickBeinliveSourceUrl,
  isAllowedSource: isAllowedBeinliveSource,
  async extractCurrentManifest(input: ProviderContext, options) {
    const waitForMediaSequence =
      Number.isFinite(Number(options?.waitForMediaSequence)) ? Number(options?.waitForMediaSequence) : null;
    const waitDeadlineAt =
      waitForMediaSequence !== null
        ? Date.now() + Math.max(1_000, Math.min(12_000, Number(options?.waitTimeoutMs || 5_000)))
        : 0;

    let state = options?.forceRefresh ? null : readSourceState(input.sourceUrl);
    let attempts = 0;
    let lastError = "beinlive-manifest-unavailable";

    while (attempts < 4) {
      attempts += 1;
      const candidateCurrentSource = state?.manifestUrl || "";

      if (state) {
        const resolvedFromState = await resolveManifestFromState(state).catch(() => null);
        if (!resolvedFromState) {
          clearSourceState(input.sourceUrl);
          state = null;
          lastError = "beinlive-sticky-manifest-failed";
        } else {
          state = resolvedFromState.state;
          if (
            waitForMediaSequence !== null &&
            resolvedFromState.mediaSequence !== null &&
            resolvedFromState.mediaSequence <= waitForMediaSequence &&
            !isSequenceRollback(resolvedFromState.mediaSequence, waitForMediaSequence) &&
            Date.now() < waitDeadlineAt
          ) {
            await sleep(WAIT_RETRY_INTERVAL_MS);
            continue;
          }

          return buildManifestResult({
            sourceUrl: input.sourceUrl,
            internalOrigin: input.internalOrigin,
            state,
            manifestBody: resolvedFromState.manifestBody,
            finalUrl: resolvedFromState.finalUrl,
            mediaSequence: resolvedFromState.mediaSequence,
            targetDurationSec: resolvedFromState.targetDurationSec,
            refreshed: attempts > 1,
            candidatesFound: 1,
            candidatesTried: attempts,
          });
        }
      }

      const resolvedFromIframe = await resolveBeinliveIframeManifest({
        sourceUrl: input.sourceUrl,
        currentSource: candidateCurrentSource,
      }).catch(() => null);
      if (!resolvedFromIframe) {
        lastError = "beinlive-iframe-manifest-missing";
        break;
      }

      state = resolvedFromIframe.state;
      if (
        waitForMediaSequence !== null &&
        resolvedFromIframe.mediaSequence !== null &&
        resolvedFromIframe.mediaSequence <= waitForMediaSequence &&
        !isSequenceRollback(resolvedFromIframe.mediaSequence, waitForMediaSequence) &&
        Date.now() < waitDeadlineAt
      ) {
        await sleep(WAIT_RETRY_INTERVAL_MS);
        continue;
      }

      return buildManifestResult({
        sourceUrl: input.sourceUrl,
        internalOrigin: input.internalOrigin,
        state,
        manifestBody: resolvedFromIframe.manifestBody,
        finalUrl: resolvedFromIframe.finalUrl,
        mediaSequence: resolvedFromIframe.mediaSequence,
        targetDurationSec: resolvedFromIframe.targetDurationSec,
        refreshed: attempts > 1,
        candidatesFound: resolvedFromIframe.candidatesFound,
        candidatesTried: resolvedFromIframe.candidatesTried,
      });
    }

    return {
      ok: false,
      error: lastError,
      playbackUrl: state?.playbackUrl || input.sourceUrl,
      currentSource: state?.manifestUrl || "",
      mediaSequence: state?.lastMediaSequence ?? null,
      targetDurationSec: 0,
      refreshed: attempts > 1,
      rotated: false,
      adapterKind: "bein",
      candidatesFound: state ? 1 : 0,
      candidatesTried: attempts,
    };
  },
  async fetchAsset(input) {
    const state = readSourceState(input.sourceUrl);
    const referrerUrl =
      normalizeHttpUrl(String(input.referrerUrl || "").trim()) || state?.manifestUrl || state?.referrerUrl || input.sourceUrl;
    return await fetchBinaryWithHeaders({
      url: input.assetUrl,
      referrerUrl,
      timeoutMs: input.timeoutMs,
    });
  },
};
