import axios from "axios";

import { rewriteManifestForSessionMirror } from "@/lib/repack-runtime-adapters/shared";
import type {
  LiveStreamProvider,
  MatchRowLike,
  ProviderAssetResult,
  ProviderContext,
  ProviderManifestResult,
} from "@/lib/live-providers";
import { createTimingSummary } from "@/lib/live-providers";

const YALLASHOOT_MATCHES_API_BASE = "https://ws.kora-api.space/api/matches";
const YALLASHOOT_MATCH_API_BASE = "https://kora-api.space/api/matche";
const YALLASHOOT_REDIRECT_BASE = "https://xyzyalla-shootx-space.smartagro.mov/";
const YALLASHOOT_ALLOWED_HOST_SUFFIXES = [
  "yalla-shoot.mov",
  "smartagro.mov",
  "sports-flash.space",
  "sport-arab.space",
  "sports-lights.space",
  "sports-burst.space",
  "sports-echo.space",
  "sports-mania.space",
  "sports-wave.space",
  "sports-edge.space",
  "sports-nova.space",
  "sports-center.space",
] as const;
const YALLASHOOT_FRAME_HOSTS = [
  "https://ar.kora-top.zip",
  "https://vsys.kora-top.zip",
  "https://yalla.kora-top.zip",
  "https://live.kora-top.zip",
  "https://vip.kora-top.zip",
] as const;
const DAY_PAGE_CACHE_TTL_MS = 90_000;
const SOURCE_STATE_TTL_MS = 30 * 60_000;
const TOKENIZED_MANIFEST_REFRESH_WINDOW_MS = 90_000;
const WAIT_RETRY_INTERVAL_MS = 700;
const DEFAULT_USER_AGENT =
  "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/145.0.0.0 Safari/537.36";

type CachedDayPage = {
  fetchedAt: number;
  matches: Array<{
    matchId: number;
    homeTeam: string;
    homeTeamEn: string;
    awayTeam: string;
    awayTeamEn: string;
    href: string;
  }>;
};

type YallashootCandidateState = {
  channelKey: string;
  manifestUrl: string;
  referrerUrl: string;
  playbackUrl: string;
  updatedAt: number;
  lastMediaSequence: number | null;
  lastError: string;
  failureCount: number;
};

type CachedSourceState = {
  sourceUrl: string;
  matchId: number;
  articleUrl: string;
  updatedAt: number;
  activeIndex: number;
  lastMediaSequence: number | null;
  candidates: YallashootCandidateState[];
};

type ResolvedManifestState = {
  state: CachedSourceState;
  activeIndex: number;
  candidate: YallashootCandidateState;
  manifestBody: string;
  finalUrl: string;
  mediaSequence: number | null;
  targetDurationSec: number;
};

let cachedDayPage: CachedDayPage | null = null;
const yallashootSourceState = new Map<string, CachedSourceState>();

function sleep(ms: number) {
  return new Promise((resolve) => setTimeout(resolve, Math.max(0, ms)));
}

function normalizeHttpUrl(rawUrl: string) {
  try {
    const parsed = new URL(String(rawUrl || "").trim());
    return parsed.protocol === "http:" || parsed.protocol === "https:" ? parsed.toString() : "";
  } catch {
    return "";
  }
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

function parseMatchSlugCandidates(rawUrl: unknown) {
  const normalized = normalizeHttpUrl(String(rawUrl || "").trim());
  if (!normalized) return [];
  try {
    const parsed = new URL(normalized);
    const slugMatch = parsed.pathname.match(/\/matches\/([^/?#]+)/i);
    const slug = String(slugMatch?.[1] || "").trim().toLowerCase();
    if (!slug || !slug.includes("-vs-")) return [];
    const [homeSlug, awaySlug] = slug.split("-vs-").map((part) => part.replace(/[^a-z0-9-]+/g, " ").trim());
    if (!homeSlug || !awaySlug) return [];
    return [
      unorderedPairKey(homeSlug, awaySlug),
      unorderedPairKey(homeSlug.replace(/-/g, " "), awaySlug.replace(/-/g, " ")),
    ].filter(Boolean);
  } catch {
    return [];
  }
}

function hostMatchesAnySuffix(host: string, suffixes: readonly string[]) {
  const normalized = String(host || "").trim().toLowerCase().replace(/\.$/, "");
  if (!normalized) return false;
  return suffixes.some((suffix) => normalized === suffix || normalized.endsWith(`.${suffix}`));
}

function isDynamicYallashootRedirectHost(host: string) {
  const normalized = String(host || "").trim().toLowerCase().replace(/\.$/, "");
  return !!normalized && normalized.endsWith(".mov") && normalized.includes("yalla-shootx-space");
}

function buildSourceStateKey(sourceUrl: string) {
  return normalizeHttpUrl(sourceUrl).toLowerCase();
}

function parseManifestExpiresAt(manifestUrl: string) {
  const normalized = normalizeHttpUrl(manifestUrl);
  if (!normalized) return 0;
  try {
    const raw = String(new URL(normalized).searchParams.get("expires") || "").trim();
    if (!raw) return 0;
    const parsed = Number.parseInt(raw, 10);
    if (!Number.isFinite(parsed) || parsed <= 0) return 0;
    return raw.length >= 13 ? parsed : parsed * 1000;
  } catch {
    return 0;
  }
}

function isManifestExpiringSoon(manifestUrl: string, windowMs = TOKENIZED_MANIFEST_REFRESH_WINDOW_MS) {
  const expiresAt = parseManifestExpiresAt(manifestUrl);
  return expiresAt > 0 && expiresAt - Date.now() <= Math.max(15_000, windowMs);
}

function shouldRefreshState(state: CachedSourceState) {
  if (!state.candidates.length) return true;
  const activeCandidate = state.candidates[state.activeIndex] || state.candidates[0];
  if (activeCandidate?.manifestUrl && isManifestExpiringSoon(activeCandidate.manifestUrl)) {
    return true;
  }
  const tokenizedCandidates = state.candidates.filter((candidate) => parseManifestExpiresAt(candidate.manifestUrl) > 0);
  if (!tokenizedCandidates.length) return false;
  return tokenizedCandidates.every((candidate) => isManifestExpiringSoon(candidate.manifestUrl));
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
    return normalizeHttpUrl(new URL(value, baseUrl).toString());
  } catch {
    return "";
  }
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

function isSequenceRollback(nextMediaSequence: number | null, previousMediaSequence: number | null) {
  if (!Number.isFinite(nextMediaSequence) || !Number.isFinite(previousMediaSequence)) return false;
  return Number(nextMediaSequence) + 2 < Number(previousMediaSequence);
}

function candidateAttemptOrder(activeIndex: number, count: number, allowRotate: boolean) {
  if (count <= 0) return [] as number[];
  if (!allowRotate) return [Math.max(0, Math.min(count - 1, activeIndex))];
  const start = Math.max(0, Math.min(count - 1, activeIndex));
  const order: number[] = [];
  for (let offset = 0; offset < count; offset += 1) {
    order.push((start + offset) % count);
  }
  return order;
}

function cloneState(state: CachedSourceState) {
  return {
    ...state,
    candidates: state.candidates.map((candidate) => ({ ...candidate })),
  } satisfies CachedSourceState;
}

function sanitizeState(state: CachedSourceState | null) {
  if (!state) return null;
  const candidates = state.candidates
    .map((candidate) => ({
      channelKey: String(candidate.channelKey || "").trim(),
      manifestUrl: normalizeHttpUrl(candidate.manifestUrl),
      referrerUrl: normalizeHttpUrl(candidate.referrerUrl),
      playbackUrl: normalizeHttpUrl(candidate.playbackUrl),
      updatedAt: Number(candidate.updatedAt || 0),
      lastMediaSequence: Number.isFinite(candidate.lastMediaSequence) ? Number(candidate.lastMediaSequence) : null,
      lastError: String(candidate.lastError || ""),
      failureCount: Math.max(0, Number(candidate.failureCount || 0)),
    }))
    .filter((candidate) => candidate.channelKey && candidate.manifestUrl && candidate.referrerUrl && candidate.playbackUrl);
  if (!candidates.length) return null;

  return {
    sourceUrl: normalizeHttpUrl(state.sourceUrl),
    matchId: Number.isFinite(state.matchId) ? Number(state.matchId) : 0,
    articleUrl: normalizeHttpUrl(state.articleUrl),
    updatedAt: Number(state.updatedAt || Date.now()),
    activeIndex: Math.max(0, Math.min(candidates.length - 1, Number(state.activeIndex || 0))),
    lastMediaSequence: Number.isFinite(state.lastMediaSequence) ? Number(state.lastMediaSequence) : null,
    candidates,
  } satisfies CachedSourceState;
}

function readSourceState(sourceUrl: string) {
  const key = buildSourceStateKey(sourceUrl);
  if (!key) return null;
  const cached = sanitizeState(yallashootSourceState.get(key) || null);
  if (!cached) {
    yallashootSourceState.delete(key);
    return null;
  }
  if (cached.updatedAt + SOURCE_STATE_TTL_MS <= Date.now()) {
    yallashootSourceState.delete(key);
    return null;
  }
  if (shouldRefreshState(cached)) {
    yallashootSourceState.delete(key);
    return null;
  }
  return cached;
}

function writeSourceState(state: CachedSourceState) {
  const normalized = sanitizeState(state);
  if (!normalized) return null;
  const key = buildSourceStateKey(normalized.sourceUrl);
  if (!key) return null;
  yallashootSourceState.set(key, normalized);
  return normalized;
}

function clearSourceState(sourceUrl: string) {
  const key = buildSourceStateKey(sourceUrl);
  if (!key) return;
  yallashootSourceState.delete(key);
}

function buildArticleUrl(matchId: number) {
  return `${YALLASHOOT_REDIRECT_BASE}?m=${encodeURIComponent(String(matchId))}&lang=ar`;
}

async function fetchDayMatches(dayKey: string) {
  if (cachedDayPage && cachedDayPage.fetchedAt + DAY_PAGE_CACHE_TTL_MS > Date.now()) {
    return cachedDayPage.matches;
  }

  const response = await axios.get(`${YALLASHOOT_MATCHES_API_BASE}/${encodeURIComponent(dayKey)}/1`, {
    responseType: "json",
    timeout: 15_000,
    maxRedirects: 5,
    validateStatus: () => true,
    headers: {
      "user-agent": DEFAULT_USER_AGENT,
      accept: "application/json,text/plain,*/*",
      "accept-language": "ar,en;q=0.9",
    },
  });

  const payload = (response.data || {}) as {
    matches?: Array<Record<string, unknown>>;
  };
  const matches = Array.isArray(payload.matches)
    ? payload.matches
        .map((item) => {
          const matchId = Number.parseInt(String(item?.id || "").trim(), 10);
          const homeTeam = String(item?.home || "").trim();
          const homeTeamEn = String(item?.home_en || "").trim();
          const awayTeam = String(item?.away || "").trim();
          const awayTeamEn = String(item?.away_en || "").trim();
          const hasChannels = String(item?.has_channels || "").trim() === "1";
          const isActive = String(item?.active || "").trim() === "1";
          if (!Number.isFinite(matchId) || matchId <= 0 || !homeTeam || !awayTeam || (!hasChannels && !isActive)) {
            return null;
          }
          return {
            matchId,
            homeTeam,
            homeTeamEn,
            awayTeam,
            awayTeamEn,
            href: buildArticleUrl(matchId),
          };
        })
        .filter(Boolean) as CachedDayPage["matches"]
    : [];

  cachedDayPage = {
    fetchedAt: Date.now(),
    matches,
  };
  return matches;
}

function extractMatchIdFromSourceUrl(sourceUrl: string) {
  const normalized = normalizeHttpUrl(sourceUrl);
  if (!normalized) return 0;
  try {
    const parsed = new URL(normalized);
    const direct = Number.parseInt(String(parsed.searchParams.get("m") || "").trim(), 10);
    if (Number.isFinite(direct) && direct > 0) return direct;
  } catch {}
  return 0;
}

async function resolveArticleContext(sourceUrl: string) {
  const normalized = normalizeHttpUrl(sourceUrl);
  if (!normalized) return null;

  const directMatchId = extractMatchIdFromSourceUrl(normalized);
  let articleUrl = normalized;
  let articleHtml = "";

  try {
    const response = await axios.get<string>(normalized, {
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
    if (Number(response.status || 0) >= 200 && Number(response.status || 0) < 400) {
      articleUrl = normalizeHttpUrl(String(response.request?.res?.responseUrl || normalized)) || normalized;
      articleHtml = String(response.data || "");
    }
  } catch {}

  const htmlMatchId =
    Number.parseInt(String(articleHtml.match(/api\/matche\/(\d+)\/ar/i)?.[1] || "").trim(), 10) ||
    Number.parseInt(String(articleHtml.match(/[?&]m=(\d+)/i)?.[1] || "").trim(), 10);
  const articleMatchId =
    Number.isFinite(htmlMatchId) && htmlMatchId > 0
      ? htmlMatchId
      : Number.isFinite(directMatchId) && directMatchId > 0
      ? directMatchId
      : 0;
  if (!articleMatchId) return null;

  return {
    matchId: articleMatchId,
    articleUrl,
  };
}

function parseFrameToken(frameHtml: string) {
  const tokenMatch =
    String(frameHtml.match(/token\s*:\s*"([^"]+)"/i)?.[1] || "").trim() ||
    String(frameHtml.match(/["']token["']\s*,\s*["']([^"']+)["']/i)?.[1] || "").trim();
  if (!tokenMatch) return "";
  try {
    const decoded = Buffer.from(tokenMatch, "base64").toString("utf8").trim();
    return normalizeHttpUrl(decoded);
  } catch {
    return "";
  }
}

async function fetchFrameManifestUrl(frameUrl: string, articleUrl: string) {
  const response = await axios.get<string>(frameUrl, {
    responseType: "text",
    timeout: 12_000,
    maxRedirects: 5,
    validateStatus: () => true,
    headers: {
      "user-agent": DEFAULT_USER_AGENT,
      accept: "text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8",
      "accept-language": "ar,en;q=0.9",
      referer: articleUrl,
      origin: new URL(articleUrl).origin,
    },
  });
  if (Number(response.status || 0) < 200 || Number(response.status || 0) >= 300) return "";
  return parseFrameToken(String(response.data || ""));
}

async function fetchMatchCandidates(sourceUrl: string) {
  const context = await resolveArticleContext(sourceUrl);
  if (!context?.matchId || !context.articleUrl) return null;

  const timestamp = Date.now();
  const apiUrl = `${YALLASHOOT_MATCH_API_BASE}/${context.matchId}/ar?t=${timestamp}`;
  const response = await axios.get(apiUrl, {
    responseType: "json",
    timeout: 14_000,
    maxRedirects: 5,
    validateStatus: () => true,
    headers: {
      "user-agent": DEFAULT_USER_AGENT,
      accept: "application/json,text/plain,*/*",
      "accept-language": "ar,en;q=0.9",
      referer: context.articleUrl,
      origin: new URL(context.articleUrl).origin,
    },
  });
  if (Number(response.status || 0) < 200 || Number(response.status || 0) >= 300) return null;

  const payload = (response.data || {}) as {
    channels?: Array<Record<string, unknown>>;
  };
  const channels = Array.isArray(payload.channels) ? payload.channels : [];
  const chosenChannels = channels
    .map((channel) => ({
      key: String(channel?.key || channel?.ch || "").trim(),
      channelKey: String(channel?.ch || channel?.key || "").trim(),
    }))
    .filter((channel) => channel.key && channel.channelKey)
    .slice(0, 2);
  if (!chosenChannels.length) return null;

  const discovered: Array<{
    channelKey: string;
    manifestUrl: string;
    referrerUrl: string;
    playbackUrl: string;
  }> = [];
  for (const channel of chosenChannels) {
    for (const frameHost of YALLASHOOT_FRAME_HOSTS) {
      const frameUrl = `${frameHost}/frame.php?ch=${encodeURIComponent(channel.channelKey)}&p=12&token=${encodeURIComponent(crypto.randomUUID())}&kt=${Date.now()}`;
      const manifestUrl = await fetchFrameManifestUrl(frameUrl, context.articleUrl).catch(() => "");
      if (!manifestUrl) continue;
      discovered.push({
        channelKey: channel.channelKey,
        manifestUrl,
        referrerUrl: frameUrl,
        playbackUrl: context.articleUrl,
      });
      break;
    }
  }

  const deduped = new Map<string, YallashootCandidateState>();
  const now = Date.now();
  for (const candidate of discovered) {
    const key = normalizeHttpUrl(candidate.manifestUrl);
    if (!key || deduped.has(key)) continue;
    deduped.set(key, {
      channelKey: candidate.channelKey,
      manifestUrl: key,
      referrerUrl: candidate.referrerUrl,
      playbackUrl: candidate.playbackUrl,
      updatedAt: now,
      lastMediaSequence: null,
      lastError: "",
      failureCount: 0,
    });
  }

  const candidates = Array.from(deduped.values()).slice(0, 2);
  if (!candidates.length) return null;

  return writeSourceState({
    sourceUrl,
    matchId: context.matchId,
    articleUrl: context.articleUrl,
    updatedAt: now,
    activeIndex: 0,
    lastMediaSequence: null,
    candidates,
  });
}

async function fetchManifestText(url: string, referrerUrl: string) {
  const response = await axios.get<string>(url, {
    responseType: "text",
    timeout: 15_000,
    maxRedirects: 5,
    validateStatus: () => true,
    headers: {
      "user-agent": DEFAULT_USER_AGENT,
      accept: "application/vnd.apple.mpegurl,application/x-mpegurl,text/plain,*/*",
      "accept-language": "ar,en;q=0.9",
      referer: referrerUrl,
      origin: new URL(referrerUrl).origin,
    },
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
  const referrerUrl = normalizeHttpUrl(input.referrerUrl);
  if (!targetUrl) {
    return { ok: false, status: 0, contentType: "", bodyBase64: "", error: "invalid-asset-url" };
  }
  if (!referrerUrl) {
    return { ok: false, status: 0, contentType: "", bodyBase64: "", error: "invalid-referrer-url" };
  }

  try {
    const response = await axios.get<ArrayBuffer>(targetUrl, {
      responseType: "arraybuffer",
      timeout: Math.max(8_000, Number(input.timeoutMs || 22_000)),
      maxRedirects: 5,
      validateStatus: () => true,
      headers: {
        "user-agent": DEFAULT_USER_AGENT,
        accept: "*/*",
        referer: referrerUrl,
        origin: new URL(referrerUrl).origin,
      },
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

    return {
      ok: true,
      status: Number(response.status || 200),
      contentType: String(response.headers["content-type"] || "application/octet-stream"),
      bodyBase64: Buffer.from(response.data).toString("base64"),
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

function recordCandidateFailure(state: CachedSourceState, index: number, error: string) {
  const next = cloneState(state);
  const candidate = next.candidates[index];
  if (!candidate) return next;
  candidate.lastError = String(error || "");
  candidate.failureCount += 1;
  candidate.updatedAt = Date.now();
  next.updatedAt = Date.now();
  return writeSourceState(next) || next;
}

function recordCandidateSuccess(
  state: CachedSourceState,
  index: number,
  resolved: { finalUrl: string; mediaSequence: number | null }
) {
  const next = cloneState(state);
  const candidate = next.candidates[index];
  if (!candidate) return next;
  candidate.manifestUrl = normalizeHttpUrl(resolved.finalUrl) || candidate.manifestUrl;
  candidate.lastMediaSequence = resolved.mediaSequence;
  candidate.lastError = "";
  candidate.failureCount = 0;
  candidate.updatedAt = Date.now();
  next.activeIndex = index;
  next.lastMediaSequence = resolved.mediaSequence;
  next.updatedAt = Date.now();
  return writeSourceState(next) || next;
}

async function resolveManifestFromCandidate(
  state: CachedSourceState,
  candidateIndex: number
): Promise<Omit<ResolvedManifestState, "state" | "activeIndex"> | null> {
  const candidate = state.candidates[candidateIndex];
  if (!candidate) return null;

  let manifestBody = await fetchManifestText(candidate.manifestUrl, candidate.referrerUrl);
  if (!manifestBody || !/^\s*#EXTM3U/im.test(manifestBody)) return null;

  let finalUrl = candidate.manifestUrl;
  if (!hasMediaSegments(manifestBody, finalUrl)) {
    const variantUrl = pickVariantManifestUrl(manifestBody, finalUrl);
    if (!variantUrl) return null;
    const variantBody = await fetchManifestText(variantUrl, candidate.referrerUrl);
    if (!variantBody || !hasMediaSegments(variantBody, variantUrl)) return null;
    manifestBody = variantBody;
    finalUrl = variantUrl;
  }

  return {
    candidate: {
      ...candidate,
      manifestUrl: finalUrl,
      lastMediaSequence: parseMediaSequence(manifestBody),
      updatedAt: Date.now(),
      lastError: "",
      failureCount: 0,
    },
    manifestBody,
    finalUrl,
    mediaSequence: parseMediaSequence(manifestBody),
    targetDurationSec: parseTargetDurationSec(manifestBody),
  };
}

function buildManifestResult(input: {
  sourceUrl: string;
  internalOrigin: string;
  state: CachedSourceState;
  activeIndex: number;
  manifestBody: string;
  finalUrl: string;
  mediaSequence: number | null;
  targetDurationSec: number;
  refreshed: boolean;
  rotated: boolean;
  candidatesTried: number;
  timingSummary?: string;
}): ProviderManifestResult {
  const candidate = input.state.candidates[input.activeIndex];
  return {
    ok: true,
    manifestBody: rewriteManifestForSessionMirror(input.manifestBody, input.finalUrl, input.internalOrigin, input.sourceUrl, 5),
    finalUrl: input.finalUrl,
    targetUrl: input.finalUrl,
    fetchUrl: input.finalUrl,
    referrerUrl: candidate?.referrerUrl || input.sourceUrl,
    playbackUrl: candidate?.playbackUrl || input.sourceUrl,
    currentSource: input.finalUrl,
    mediaSequence: input.mediaSequence,
    targetDurationSec: input.targetDurationSec,
    refreshed: input.refreshed,
    rotated: input.rotated,
    adapterKind: "playerv2",
    candidatesFound: input.state.candidates.length,
    candidatesTried: input.candidatesTried,
    sessionOwned: true,
    timingSummary: input.timingSummary,
  };
}

export function isAllowedYallashootSource(rawUrl: string) {
  const normalized = normalizeHttpUrl(rawUrl);
  if (!normalized) return false;
  try {
    const parsed = new URL(normalized);
    const host = parsed.hostname;
    const matchId = String(parsed.searchParams.get("m") || "").trim();
    if (hostMatchesAnySuffix(host, YALLASHOOT_ALLOWED_HOST_SUFFIXES)) return true;
    return isDynamicYallashootRedirectHost(host) && /^\d+$/.test(matchId);
  } catch {
    return false;
  }
}

export async function pickYallashootSourceUrl(row: MatchRowLike) {
  const direct = String(row?.stream_url_5 || "").trim();
  if (isAllowedYallashootSource(direct)) return direct;

  const pairKey = unorderedPairKey(row?.home_team, row?.away_team);
  const slugKeys = parseMatchSlugCandidates(row?.stream_url);
  if (!pairKey && !slugKeys.length) return null;
  const dayKey = String(row?.match_day || "").trim() || new Date().toISOString().slice(0, 10);
  const matches = await fetchDayMatches(dayKey).catch(() => [] as CachedDayPage["matches"]);
  const found = matches.find((candidate) => {
    const candidateKeys = [
      unorderedPairKey(candidate.homeTeam, candidate.awayTeam),
      unorderedPairKey(candidate.homeTeamEn, candidate.awayTeamEn),
    ].filter(Boolean);
    if (pairKey && candidateKeys.includes(pairKey)) return true;
    if (!slugKeys.length) return false;
    return slugKeys.some((key) => candidateKeys.includes(key));
  });
  return found?.href || null;
}

export function buildYallashootPublicPlaylistUrl(matchId: number, publicBaseUrl?: string) {
  if (!Number.isFinite(matchId) || matchId <= 0) return null;
  const base =
    String(publicBaseUrl || process.env.LIVEKORA_R2_PUBLIC_BASE_URL || "https://r2.tf-player.site/live")
      .trim()
      .replace(/\/+$/, "");
  if (!base) return null;
  return `${base}/yallashoot/m${matchId}/index.m3u8`;
}

export function buildYallashootSessionManifestUrl(matchId: number, internalOrigin: string) {
  return `${String(internalOrigin || "").replace(/\/+$/, "")}/api/yallashoot/session-manifest?matchId=${encodeURIComponent(String(matchId))}`;
}

export const yallashootProvider: LiveStreamProvider = {
  id: "yallashoot",
  label: "yalla-shoot",
  order: 4,
  publicPathPrefix: "live/yallashoot",
  sourceSelector: pickYallashootSourceUrl,
  isAllowedSource: isAllowedYallashootSource,
  async extractCurrentManifest(input: ProviderContext, options): Promise<ProviderManifestResult> {
    const startedAt = Date.now();
    const waitForMediaSequence =
      Number.isFinite(Number(options?.waitForMediaSequence)) ? Number(options?.waitForMediaSequence) : null;
    const waitDeadlineAt =
      waitForMediaSequence !== null
        ? Date.now() + Math.max(1_000, Math.min(12_000, Number(options?.waitTimeoutMs || 5_000)))
        : 0;
    const allowRotate = options?.allowRotate !== false;

    let state = options?.forceRefresh ? null : readSourceState(input.sourceUrl);
    let preservedState = state;
    let attempts = 0;
    let candidatesTried = 0;
    let lastError = "yallashoot-manifest-unavailable";
    let rotated = false;
    let refreshed = !!options?.forceRefresh;
    let discoveryMs = 0;
    let candidateResolveMs = 0;

    while (attempts < 4) {
      attempts += 1;
      if (!state || !state.candidates.length) {
        const discoveryStartedAt = Date.now();
        state = await fetchMatchCandidates(input.sourceUrl).catch(() => null);
        discoveryMs += Date.now() - discoveryStartedAt;
        if (!state) {
          clearSourceState(input.sourceUrl);
          break;
        }
        preservedState = state;
        refreshed = true;
      }

      const order = candidateAttemptOrder(state.activeIndex, state.candidates.length, allowRotate);
      let shouldRetry = false;

      for (const candidateIndex of order) {
        candidatesTried += 1;
        const resolveStartedAt = Date.now();
        const resolved = await resolveManifestFromCandidate(state, candidateIndex).catch(() => null);
        candidateResolveMs += Date.now() - resolveStartedAt;
        if (!resolved) {
          state = recordCandidateFailure(state, candidateIndex, "yallashoot-candidate-failed");
          lastError = "yallashoot-candidate-failed";
          if (candidateIndex !== state.activeIndex) rotated = true;
          continue;
        }

        state = recordCandidateSuccess(state, candidateIndex, {
          finalUrl: resolved.finalUrl,
          mediaSequence: resolved.mediaSequence,
        });
        const updatedState = readSourceState(input.sourceUrl) || state;
        preservedState = updatedState;
        const unchangedSequence =
          waitForMediaSequence !== null &&
          resolved.mediaSequence !== null &&
          resolved.mediaSequence <= waitForMediaSequence &&
          !isSequenceRollback(resolved.mediaSequence, waitForMediaSequence);

        if (unchangedSequence) {
          lastError = "media-sequence-unchanged";
          if (Date.now() < waitDeadlineAt && updatedState.candidates.length > 1 && allowRotate) {
            shouldRetry = true;
            rotated = true;
            await sleep(WAIT_RETRY_INTERVAL_MS);
            break;
          }
        }

        return buildManifestResult({
          sourceUrl: input.sourceUrl,
          internalOrigin: input.internalOrigin,
          state: updatedState,
          activeIndex: updatedState.activeIndex,
          manifestBody: resolved.manifestBody,
          finalUrl: resolved.finalUrl,
          mediaSequence: resolved.mediaSequence,
          targetDurationSec: resolved.targetDurationSec,
          refreshed,
          rotated,
          candidatesTried,
          timingSummary: createTimingSummary(
            updatedState.candidates.length > 1 ? "dual_candidate" : "single_candidate",
            {
              total: Date.now() - startedAt,
              discover: discoveryMs,
              candidateResolve: candidateResolveMs,
            },
            {
              attempts,
              candidates: updatedState.candidates.length,
              activeIndex: updatedState.activeIndex,
            }
          ),
        });
      }

      if (shouldRetry && Date.now() < waitDeadlineAt) continue;

      const rediscoveryStartedAt = Date.now();
      state = await fetchMatchCandidates(input.sourceUrl).catch(() => null);
      discoveryMs += Date.now() - rediscoveryStartedAt;
      refreshed = true;
      if (!state) break;
      preservedState = state;
    }

    const fallbackState = readSourceState(input.sourceUrl) || preservedState || state;
    return {
      ok: false,
      error: lastError,
      playbackUrl: fallbackState?.candidates[fallbackState.activeIndex]?.playbackUrl || input.sourceUrl,
      currentSource: fallbackState?.candidates[fallbackState.activeIndex]?.manifestUrl || "",
      mediaSequence: fallbackState?.lastMediaSequence ?? null,
      targetDurationSec: 0,
      refreshed,
      rotated,
      adapterKind: "playerv2",
      candidatesFound: fallbackState?.candidates.length || 0,
      candidatesTried,
      timingSummary: createTimingSummary("resolved_failed", {
        total: Date.now() - startedAt,
        discover: discoveryMs,
        candidateResolve: candidateResolveMs,
      }),
    };
  },
  async fetchAsset(input) {
    const state = readSourceState(input.sourceUrl);
    const activeCandidate = state?.candidates[state.activeIndex];
    const referrerUrl =
      normalizeHttpUrl(String(input.referrerUrl || "").trim()) ||
      activeCandidate?.manifestUrl ||
      activeCandidate?.referrerUrl ||
      input.sourceUrl;
    return await fetchBinaryWithHeaders({
      url: input.assetUrl,
      referrerUrl,
      timeoutMs: input.timeoutMs,
    });
  },
};
