import { execFile } from "node:child_process";
import path from "node:path";
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
const DIRECT_EXTRACT_TIMEOUT_MS = 24_000;
const DEFAULT_USER_AGENT =
  "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/145.0.0.0 Safari/537.36";
const ALBA_SERV_ORDER = ["2", "3", "1", "0", "5", "4"] as const;

type CachedDayPage = {
  fetchedAt: number;
  matches: Array<{
    homeTeam: string;
    awayTeam: string;
    href: string;
  }>;
};

type BeinliveCandidateState = {
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
  updatedAt: number;
  activeIndex: number;
  lastMediaSequence: number | null;
  candidates: BeinliveCandidateState[];
};

type DiscoveredCandidate = {
  manifestUrl: string;
  referrerUrl: string;
  playbackUrl: string;
  priority: number;
};

type DirectExtractorOutput = {
  ok?: boolean;
  serverHtml?: string;
  iframeUrls?: string[];
  error?: string;
};

type ResolvedManifestState = {
  state: CachedSourceState;
  activeIndex: number;
  candidate: BeinliveCandidateState;
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

function normalizeHttpUrl(rawUrl: string) {
  try {
    const parsed = new URL(String(rawUrl || "").trim());
    return parsed.protocol === "http:" || parsed.protocol === "https:" ? parsed.toString() : "";
  } catch {
    return "";
  }
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

function buildSourceStateKey(sourceUrl: string) {
  return normalizeHttpUrl(sourceUrl).toLowerCase();
}

function sanitizeState(state: CachedSourceState | null) {
  if (!state) return null;
  const candidates = state.candidates
    .map((candidate) => ({
      manifestUrl: normalizeHttpUrl(candidate.manifestUrl),
      referrerUrl: normalizeHttpUrl(candidate.referrerUrl),
      playbackUrl: normalizeHttpUrl(candidate.playbackUrl),
      updatedAt: Number(candidate.updatedAt || 0),
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
  if (!key) return null;
  const cached = sanitizeState(beinliveSourceState.get(key) || null);
  if (!cached) {
    beinliveSourceState.delete(key);
    return null;
  }
  if (cached.updatedAt + SOURCE_STATE_TTL_MS <= Date.now()) {
    beinliveSourceState.delete(key);
    return null;
  }
  return cached;
}

function writeSourceState(state: CachedSourceState) {
  const normalized = sanitizeState(state);
  if (!normalized) return null;
  const key = buildSourceStateKey(normalized.sourceUrl);
  if (!key) return null;
  beinliveSourceState.set(key, normalized);
  return normalized;
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
    return normalizeHttpUrl(new URL(value, baseUrl).toString());
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

async function fetchTextWithHeaders(url: string, referrerUrl: string, accept: string) {
  const targetUrl = normalizeHttpUrl(url);
  const headers = buildRequestHeaders(referrerUrl, accept);
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

async function fetchManifestText(url: string, referrerUrl: string) {
  return await fetchTextWithHeaders(
    url,
    referrerUrl,
    "application/vnd.apple.mpegurl,application/x-mpegurl,text/plain,*/*"
  );
}

async function fetchHtmlText(url: string, referrerUrl: string) {
  return await fetchTextWithHeaders(url, referrerUrl, "text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8");
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

    return {
      ok: true,
      status: Number(response.status || 200),
      contentType: String(response.headers["content-type"] || ""),
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

function cloneState(state: CachedSourceState) {
  return {
    ...state,
    candidates: state.candidates.map((candidate) => ({ ...candidate })),
  } satisfies CachedSourceState;
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

async function fetchBeinliveAjaxHtml(sourceUrl: string) {
  const pageHtml = await fetchBeinlivePageHtml(sourceUrl);
  if (!pageHtml) return null;

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
        "x-requested-with": "XMLHttpRequest",
      },
    }
  );

  if (Number(serverResponse.status || 0) < 200 || Number(serverResponse.status || 0) >= 300) return null;
  const html = String(serverResponse.data || "");
  return html.trim() ? html : null;
}

async function fetchBeinlivePageHtml(sourceUrl: string) {
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
  return pageHtml.trim() ? pageHtml : null;
}

function runDirectBeinliveExtractor(sourceUrl: string) {
  const scriptPath = path.join(process.cwd(), "server", "beinlive-direct-extract.js");
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

function extractBeinliveIframeUrls(serverHtml: string) {
  const out: string[] = [];
  const pushUnique = (raw: string) => {
    const normalized = normalizeHttpUrl(decodeMaybeBase64(raw));
    if (!normalized || out.includes(normalized)) return;
    out.push(normalized);
  };

  for (const match of serverHtml.matchAll(/\b(?:data-vload|data-initial|data-id|data-url)=['"]([^'"]+)['"]/gi)) {
    pushUnique(String(match[1] || ""));
  }
  for (const match of serverHtml.matchAll(/\bhref=['"]([^'"]*\/albaplayer\/[^'"]+)['"]/gi)) {
    pushUnique(String(match[1] || ""));
  }
  return out;
}

function inferBeinliveChannelSlug(pageHtml: string) {
  const channelText = String(
    pageHtml.match(/<th>\s*اسم القناة\s*<\/th>\s*<td>\s*([^<]+?)\s*<\/td>/i)?.[1] ||
      pageHtml.match(/<th>\s*اسم القناه\s*<\/th>\s*<td>\s*([^<]+?)\s*<\/td>/i)?.[1] ||
      ""
  )
    .replace(/&nbsp;/gi, " ")
    .trim()
    .toLowerCase();
  if (!channelText) return "";

  const sportsMatch = channelText.match(/bein\s*sports?\s*(\d+)/i);
  if (sportsMatch?.[1]) return `sports-${sportsMatch[1]}`;

  const premiumMatch = channelText.match(/bein\s*premium\s*(\d+)/i);
  if (premiumMatch?.[1]) return `ad-premium-${premiumMatch[1]}`;

  return "";
}

function buildDirectBeinliveIframeUrls(pageHtml: string) {
  const slug = inferBeinliveChannelSlug(pageHtml);
  if (!slug) return [] as string[];
  return expandBeinliveIframeVariants(`https://aaa.yallashoot2026.com/albaplayer/${slug}/`);
}

function expandBeinliveIframeVariants(rawIframeUrl: string) {
  const iframeUrl = normalizeHttpUrl(rawIframeUrl);
  if (!iframeUrl) return [] as string[];

  const out: string[] = [];
  const pushUnique = (raw: string) => {
    const normalized = normalizeHttpUrl(raw);
    if (!normalized || out.includes(normalized)) return;
    out.push(normalized);
  };

  pushUnique(iframeUrl);
  try {
    const parsed = new URL(iframeUrl);
    const parts = String(parsed.pathname || "")
      .split("/")
      .map((item) => item.trim())
      .filter(Boolean);
    const slug = String(parts[0] === "albaplayer" ? parts[1] || "" : parts[0] || "").trim();
    if (!slug) return out;

    for (const serv of ALBA_SERV_ORDER) {
      pushUnique(`${parsed.origin}/albaplayer/${slug}/?serv=${serv}`);
    }
    pushUnique(`${parsed.origin}/albaplayer/${slug}/`);
  } catch {}

  return out;
}

function parseIframeDomains(iframeHtml: string) {
  const domainsMatch = iframeHtml.match(/const\s+D\s*=\s*\[([^\]]+)\]/i);
  return (domainsMatch?.[1] || "")
    .split(",")
    .map((value) => value.replace(/['"`]/g, "").trim())
    .filter(Boolean);
}

function parseIframeChannelKey(iframeHtml: string, currentSource?: string | null) {
  const fromHtml =
    String(iframeHtml.match(/\/hls\/([^/]+)\/(?:master\.m3u8|live\/index\.m3u8)/i)?.[1] || "").trim() ||
    String(iframeHtml.match(/return['"`]\s*ch(\d+)/i)?.[1] || "").trim();
  const fromCurrent = String(String(currentSource || "").match(/\/hls\/([^/]+)\//i)?.[1] || "").trim();
  const resolved = fromHtml || fromCurrent;
  return resolved ? resolved.replace(/^ch/i, "ch") : "";
}

function buildCandidateManifestUrls(input: {
  iframeHtml: string;
  currentSource?: string | null;
}) {
  const out: Array<{ manifestUrl: string; priority: number }> = [];
  const seen = new Set<string>();
  const pushUnique = (rawUrl: string, priority: number) => {
    const normalized = normalizeHttpUrl(rawUrl);
    if (!normalized || seen.has(normalized)) return;
    seen.add(normalized);
    out.push({ manifestUrl: normalized, priority });
  };

  const currentSource = normalizeHttpUrl(String(input.currentSource || "").trim());
  if (currentSource) {
    pushUnique(currentSource, 2_400);
    if (/\/master\.m3u8(?:$|\?)/i.test(currentSource)) {
      pushUnique(currentSource.replace(/\/master\.m3u8(?:$|\?)/i, "/live/index.m3u8"), 2_600);
    }
  }

  for (const match of input.iframeHtml.matchAll(/https?:\/\/[^"'`\s]+\/hls\/[^"'`\s]+(?:master\.m3u8|live\/index\.m3u8)/gi)) {
    const raw = String(match[0] || "").trim();
    pushUnique(raw, /\/live\/index\.m3u8/i.test(raw) ? 2_300 : 2_050);
  }

  const channelKey = parseIframeChannelKey(input.iframeHtml, currentSource);
  const domains = parseIframeDomains(input.iframeHtml);
  const subdomain = computeAlbaSubdomain();

  if (channelKey && domains.length) {
    for (const domain of domains) {
      pushUnique(`https://${subdomain}.${domain}/hls/${channelKey}/live/index.m3u8`, 2_200);
      pushUnique(`https://${subdomain}.${domain}/hls/${channelKey}/master.m3u8`, 1_950);
    }
  }

  return out;
}

function computeCandidatePriority(input: {
  manifestUrl: string;
  referrerUrl: string;
  currentSource?: string | null;
  basePriority: number;
  order: number;
}) {
  let score = Number(input.basePriority || 0);
  const manifestUrl = String(input.manifestUrl || "").toLowerCase();
  const currentSource = String(input.currentSource || "").toLowerCase();

  if (manifestUrl.includes("/live/index.m3u8")) score += 120;
  if (currentSource && manifestUrl === currentSource) score += 1_200;
  try {
    if (currentSource && new URL(input.manifestUrl).hostname === new URL(input.currentSource || input.manifestUrl).hostname) {
      score += 140;
    }
  } catch {}
  score -= input.order * 8;
  return score;
}

async function discoverBeinliveSourceState(input: {
  sourceUrl: string;
  currentSource?: string | null;
}) {
  const pageHtml = await fetchBeinlivePageHtml(input.sourceUrl).catch(() => null);
  let serverHtml = await fetchBeinliveAjaxHtml(input.sourceUrl);
  let iframeUrls = serverHtml ? extractBeinliveIframeUrls(serverHtml) : [];
  if (!iframeUrls.length && pageHtml) {
    iframeUrls = buildDirectBeinliveIframeUrls(pageHtml);
  }
  if (!iframeUrls.length) {
    const extracted = await runDirectBeinliveExtractor(input.sourceUrl).catch(() => null);
    const extractedHtml = String(extracted?.serverHtml || "").trim();
    if (extractedHtml) serverHtml = extractedHtml;
    for (const rawUrl of Array.isArray(extracted?.iframeUrls) ? extracted?.iframeUrls : []) {
      const normalized = normalizeHttpUrl(String(rawUrl || "").trim());
      if (normalized && !iframeUrls.includes(normalized)) iframeUrls.push(normalized);
    }
    if (!iframeUrls.length && serverHtml) {
      iframeUrls = extractBeinliveIframeUrls(serverHtml);
    }
  }
  if (!iframeUrls.length) return null;

  const iframeVariants: string[] = [];
  for (const iframeUrl of iframeUrls) {
    for (const variant of expandBeinliveIframeVariants(iframeUrl)) {
      if (!iframeVariants.includes(variant)) iframeVariants.push(variant);
    }
  }

  const discovered: DiscoveredCandidate[] = [];
  const now = Date.now();
  for (const iframeUrl of iframeVariants.slice(0, 12)) {
    const iframeHtml = await fetchHtmlText(iframeUrl, input.sourceUrl).catch(() => null);
    if (!iframeHtml) continue;

    for (const candidate of buildCandidateManifestUrls({
      iframeHtml,
      currentSource: input.currentSource,
    })) {
      discovered.push({
        manifestUrl: candidate.manifestUrl,
        referrerUrl: iframeUrl,
        playbackUrl: iframeUrl,
        priority: computeCandidatePriority({
          manifestUrl: candidate.manifestUrl,
          referrerUrl: iframeUrl,
          currentSource: input.currentSource,
          basePriority: candidate.priority,
          order: discovered.length,
        }),
      });
    }
  }

  const deduped = new Map<string, DiscoveredCandidate>();
  for (const candidate of discovered) {
    const key = `${candidate.manifestUrl}|${candidate.referrerUrl}`;
    const previous = deduped.get(key);
    if (!previous || candidate.priority > previous.priority) {
      deduped.set(key, candidate);
    }
  }

  const candidates = Array.from(deduped.values())
    .sort((left, right) => right.priority - left.priority)
    .map(
      (candidate) =>
        ({
          manifestUrl: candidate.manifestUrl,
          referrerUrl: candidate.referrerUrl,
          playbackUrl: candidate.playbackUrl,
          updatedAt: now,
          lastMediaSequence: null,
          lastError: "",
          failureCount: 0,
        }) satisfies BeinliveCandidateState
    );
  if (!candidates.length) return null;

  return writeSourceState({
    sourceUrl: input.sourceUrl,
    updatedAt: now,
    activeIndex: 0,
    lastMediaSequence: null,
    candidates,
  });
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
}): ProviderManifestResult {
  const candidate = input.state.candidates[input.activeIndex];
  return {
    ok: true,
    manifestBody: rewriteManifestForSessionMirror(input.manifestBody, input.finalUrl, input.internalOrigin, input.sourceUrl, 1),
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
    adapterKind: "bein",
    candidatesFound: input.state.candidates.length,
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
    const allowRotate = options?.allowRotate !== false;

    let state = options?.forceRefresh ? null : readSourceState(input.sourceUrl);
    let attempts = 0;
    let candidatesTried = 0;
    let lastError = "beinlive-manifest-unavailable";
    let rotated = false;
    let refreshed = !!options?.forceRefresh;

    while (attempts < 4) {
      attempts += 1;
      if (!state || !state.candidates.length) {
        state = await discoverBeinliveSourceState({
          sourceUrl: input.sourceUrl,
          currentSource: state?.candidates[state.activeIndex]?.manifestUrl || "",
        }).catch(() => null);
        if (!state) {
          clearSourceState(input.sourceUrl);
          lastError = "beinlive-iframe-manifest-missing";
          break;
        }
        refreshed = true;
      }

      const order = candidateAttemptOrder(state.activeIndex, state.candidates.length, allowRotate);
      let shouldRetry = false;
      for (const candidateIndex of order) {
        candidatesTried += 1;
        const resolved = await resolveManifestFromCandidate(state, candidateIndex).catch(() => null);
        if (!resolved) {
          state = recordCandidateFailure(state, candidateIndex, "beinlive-candidate-failed");
          lastError = "beinlive-candidate-failed";
          if (candidateIndex !== state.activeIndex) rotated = true;
          continue;
        }

        state = recordCandidateSuccess(state, candidateIndex, {
          finalUrl: resolved.finalUrl,
          mediaSequence: resolved.mediaSequence,
        });
        const updatedState = readSourceState(input.sourceUrl) || state;
        const unchangedSequence =
          waitForMediaSequence !== null &&
          resolved.mediaSequence !== null &&
          resolved.mediaSequence <= waitForMediaSequence &&
          !isSequenceRollback(resolved.mediaSequence, waitForMediaSequence);

        if (unchangedSequence) {
          lastError = "media-sequence-unchanged";
          if (Date.now() < waitDeadlineAt) {
            shouldRetry = true;
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
        });
      }

      if (shouldRetry && Date.now() < waitDeadlineAt) continue;

      state = await discoverBeinliveSourceState({
        sourceUrl: input.sourceUrl,
        currentSource: state?.candidates[state.activeIndex]?.manifestUrl || "",
      }).catch(() => null);
      refreshed = true;
      if (!state) {
        clearSourceState(input.sourceUrl);
        break;
      }
    }

    const fallbackState = readSourceState(input.sourceUrl) || state;
    return {
      ok: false,
      error: lastError,
      playbackUrl: fallbackState?.candidates[fallbackState.activeIndex]?.playbackUrl || input.sourceUrl,
      currentSource: fallbackState?.candidates[fallbackState.activeIndex]?.manifestUrl || "",
      mediaSequence: fallbackState?.lastMediaSequence ?? null,
      targetDurationSec: 0,
      refreshed,
      rotated,
      adapterKind: "bein",
      candidatesFound: fallbackState?.candidates.length || 0,
      candidatesTried,
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
