import { NextResponse } from "next/server";

import { supabaseAdmin } from "@/app/api/_supabase";
import { extractLiveEmbedSessionSnapshot, fetchLiveEmbedText } from "@/lib/repack-embed-session";
import { resolveInternalPlayerOrigin } from "@/lib/repack-ingest-gateway";
import {
  getSlotSourceUrlFromRow,
  getSourceFamilyForSlotServer,
  isAllowedSourceForSlotServer,
  isIngestCandidateAlignedWithSlotServer,
  isValidHttpUrl,
  type SlotServerId,
} from "@/lib/server-source-policy";

const DEFAULT_RESOLVE_TIMEOUT_MS =
  Math.max(20_000, Number.parseInt(String(process.env.REPACK_RESOLVE_TIMEOUT_MS || "20000"), 10) || 20_000);
const INLINE_SESSION_MANIFEST_MAX_AGE_MS = Math.max(
  500,
  Number.parseInt(String(process.env.REPACK_INLINE_SESSION_MANIFEST_MAX_AGE_MS || "1500"), 10) || 1_500
);
const PLAYERV2_RUNTIME_MANIFEST_MAX_AGE_MS = Math.max(
  4_000,
  Number.parseInt(String(process.env.REPACK_PLAYERV2_RUNTIME_MANIFEST_MAX_AGE_MS || "12000"), 10) || 12_000
);
const DEFAULT_RUNTIME_MANIFEST_MAX_AGE_MS = Math.max(
  6_000,
  Number.parseInt(String(process.env.REPACK_DEFAULT_RUNTIME_MANIFEST_MAX_AGE_MS || "24000"), 10) || 24_000
);

type MatchRow = {
  id: number;
  match_key?: string | null;
  home_team?: string | null;
  away_team?: string | null;
  match_start?: string | null;
  match_day?: string | null;
  status_key?: string | null;
  stream_url?: string | null;
  stream_url_2?: string | null;
  stream_url_3?: string | null;
  stream_url_4?: string | null;
};

type RuntimeManifestResult =
  | {
      ok: true;
      manifestBody: string;
      finalUrl: string;
      targetUrl: string;
      referrerUrl: string;
      playbackUrl: string;
      adapterKind: RuntimeAdapterKind;
      candidatesFound: number;
      candidatesTried: number;
    }
  | {
      ok: false;
      error: string;
      playbackUrl: string;
      adapterKind: RuntimeAdapterKind;
      candidatesFound: number;
      candidatesTried: number;
    };

type SessionManifestResolution =
  | {
      ok: true;
      body: string;
      finalUrl: string;
    }
  | {
      ok: false;
      error: string;
    };

type RuntimeAdapterKind = "playerv2" | "bein" | "alba" | "default";

type RuntimeAdapterInput = {
  sourceUrl: string;
  slotServer: SlotServerId;
  internalOrigin: string;
};

type RuntimeAdapter = {
  kind: RuntimeAdapterKind;
  matches: (input: RuntimeAdapterInput) => boolean;
  resolve: (input: RuntimeAdapterInput) => Promise<RuntimeManifestResult>;
};

function toInt(raw: unknown) {
  const value = Number.parseInt(String(raw ?? ""), 10);
  return Number.isFinite(value) ? value : NaN;
}

function normalizeTeamNameForCompare(value: unknown) {
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

function normalizeTeamAliasForCompare(value: unknown, opts?: { stripGeo?: boolean }) {
  let s = normalizeTeamNameForCompare(value);
  if (!s) return "";
  s = s
    .replace(/^(?:\u0646\u0627\u062f\u064a|\u0641\u0631\u064a\u0642|\u0627\u0644\u0634\u0628\u0627\u0628|\u0633\u064a\u062f\u0627\u062a|\u0627\u0644\u0631\u064a\u0627\u0636\u064a|\u0627\u0644\u0631\u064a\u0627\u0636\u064a\u0647|\u0645\u0646\u062a\u062e\u0628)/, "")
    .replace(/(?:club|fc|sc|u\d{1,2}|women|youth)$/g, "");
  if (opts?.stripGeo) {
    s = s.replace(
      /(?:\u0627\u0644\u0633\u0639\u0648\u062f\u064a|\u0627\u0644\u0645\u0635\u0631\u064a|\u0627\u0644\u0627\u0645\u0627\u0631\u0627\u062a\u064a|\u0627\u0644\u0625\u0645\u0627\u0631\u0627\u062a\u064a|\u0627\u0644\u0645\u063a\u0631\u0628\u064a|\u0627\u0644\u062c\u0632\u0627\u0626\u0631\u064a|\u0627\u0644\u0642\u0637\u0631\u064a|\u0627\u0644\u0643\u0648\u064a\u062a\u064a|\u0627\u0644\u0628\u062d\u0631\u064a\u0646\u064a|\u0627\u0644\u0639\u0645\u0627\u0646\u064a|\u0627\u0644\u0639\u0631\u0627\u0642\u064a|\u0627\u0644\u0633\u0648\u0631\u064a|\u0627\u0644\u0627\u0631\u062f\u0646\u064a|\u0627\u0644\u0623\u0631\u062f\u0646\u064a|\u0627\u0644\u0644\u0628\u0646\u0627\u0646\u064a|\u0627\u0644\u0644\u064a\u0628\u064a|\u0627\u0644\u062a\u0648\u0646\u0633\u064a|\u0627\u0644\u0641\u0644\u0633\u0637\u064a\u0646\u064a|\u0627\u0644\u0645\u0648\u0631\u064a\u062a\u0627\u0646\u064a)$/g,
      ""
    );
  }
  return s.trim();
}

function buildUnorderedTeamPairKey(home: unknown, away: unknown, opts?: { stripGeo?: boolean }) {
  const a = normalizeTeamAliasForCompare(home, opts);
  const b = normalizeTeamAliasForCompare(away, opts);
  if (!a || !b) return "";
  return [a, b].sort().join("|");
}

function matchStartMs(raw: unknown) {
  const value = typeof raw === "string" ? raw : "";
  if (!value) return null as number | null;
  const ms = new Date(value).getTime();
  return Number.isFinite(ms) ? ms : null;
}

function areSiblingKickoffsClose(left: MatchRow, right: MatchRow) {
  const leftMs = matchStartMs(left.match_start);
  const rightMs = matchStartMs(right.match_start);
  if (leftMs === null || rightMs === null) return true;
  return Math.abs(leftMs - rightMs) <= 6 * 60 * 60 * 1000;
}

function extractDayKeyFromRow(row: MatchRow) {
  const matchDay = String(row.match_day || "").trim();
  if (/^\d{4}-\d{2}-\d{2}$/.test(matchDay)) return matchDay;
  const key = String(row.match_key || "");
  const fromKey = key.split("||")[0] || "";
  if (/^\d{4}-\d{2}-\d{2}$/.test(fromKey)) return fromKey;
  if (row.match_start) {
    return new Date(row.match_start).toLocaleDateString("en-CA", { timeZone: "Africa/Cairo" });
  }
  return new Date().toLocaleDateString("en-CA", { timeZone: "Africa/Cairo" });
}

function countPresentStreams(row: MatchRow) {
  const urls = [row.stream_url, row.stream_url_2, row.stream_url_3, row.stream_url_4];
  return urls.reduce((n, u) => (isValidHttpUrl(u) ? n + 1 : n), 0);
}

function mergeMissingStreams(base: MatchRow, donor: MatchRow) {
  const next: MatchRow = { ...base };
  if (!isValidHttpUrl(next.stream_url) && isValidHttpUrl(donor.stream_url)) next.stream_url = donor.stream_url;
  if (!isValidHttpUrl(next.stream_url_2) && isValidHttpUrl(donor.stream_url_2)) next.stream_url_2 = donor.stream_url_2;
  if (!isValidHttpUrl(next.stream_url_3) && isValidHttpUrl(donor.stream_url_3)) next.stream_url_3 = donor.stream_url_3;
  if (!isValidHttpUrl(next.stream_url_4) && isValidHttpUrl(donor.stream_url_4)) next.stream_url_4 = donor.stream_url_4;
  if (!next.match_start && donor.match_start) next.match_start = donor.match_start;
  if (!next.match_day && donor.match_day) next.match_day = donor.match_day;
  if (!next.status_key && donor.status_key) next.status_key = donor.status_key;
  return next;
}

async function fetchMatchRowsByDayKey(dayKey: string) {
  const safeDayKey = String(dayKey || "").trim();
  if (!/^\d{4}-\d{2}-\d{2}$/.test(safeDayKey)) return [] as MatchRow[];
  const { data, error } = await supabaseAdmin
    .from("match-stream-app")
    .select("id,match_key,home_team,away_team,match_start,match_day,status_key,stream_url,stream_url_2,stream_url_3,stream_url_4")
    .like("match_key", `${safeDayKey}||%`)
    .limit(300);
  if (error || !Array.isArray(data)) return [] as MatchRow[];
  return data as MatchRow[];
}

async function enrichMatchRowWithDuplicateSiblingStreams(row: MatchRow) {
  const currentPair = buildUnorderedTeamPairKey(row.home_team, row.away_team);
  const currentLoosePair = buildUnorderedTeamPairKey(row.home_team, row.away_team, { stripGeo: true });
  if (!currentPair && !currentLoosePair) return row;
  const sameDayRows = await fetchMatchRowsByDayKey(extractDayKeyFromRow(row));
  if (!sameDayRows.length) return row;

  const siblings = sameDayRows
    .filter((candidate) => Number(candidate.id) !== Number(row.id))
    .filter((candidate) => {
      if (!areSiblingKickoffsClose(row, candidate)) return false;
      const strictPair = buildUnorderedTeamPairKey(candidate.home_team, candidate.away_team);
      if (currentPair && strictPair && strictPair === currentPair) return true;
      const loosePair = buildUnorderedTeamPairKey(candidate.home_team, candidate.away_team, { stripGeo: true });
      return !!(currentLoosePair && loosePair && loosePair === currentLoosePair);
    });
  if (!siblings.length) return row;

  const donor = siblings.sort((a, b) => {
    const streamDelta = countPresentStreams(b) - countPresentStreams(a);
    if (streamDelta !== 0) return streamDelta;
    const startA = a.match_start ? new Date(a.match_start).getTime() : 0;
    const startB = b.match_start ? new Date(b.match_start).getTime() : 0;
    if (startB !== startA) return startB - startA;
    return Number(b.id || 0) - Number(a.id || 0);
  })[0];
  if (!donor) return row;
  return mergeMissingStreams(row, donor);
}

function isSlotServerId(value: number): value is SlotServerId {
  return value === 1 || value === 2 || value === 3 || value === 4;
}

function resolveManifestUrl(raw: string, baseUrl: string) {
  const value = String(raw || "").trim();
  if (!value) return "";
  try {
    const absolute = new URL(value, baseUrl).toString();
    return isValidHttpUrl(absolute) ? absolute : "";
  } catch {
    return "";
  }
}

function safeDecodeURIComponent(value: string) {
  try {
    return decodeURIComponent(String(value || ""));
  } catch {
    return String(value || "");
  }
}

function unwrapProxyTarget(rawUrl: string) {
  let current = String(rawUrl || "").trim();
  for (let depth = 0; depth < 4; depth += 1) {
    if (!isValidHttpUrl(current)) return "";
    try {
      const parsed = new URL(current);
      if (!String(parsed.pathname || "").toLowerCase().includes("/api/embed-proxy")) return parsed.toString();
      let target = String(parsed.searchParams.get("url") || "").trim();
      for (let decodeDepth = 0; decodeDepth < 3; decodeDepth += 1) {
        const decoded = safeDecodeURIComponent(target).trim();
        if (decoded === target) break;
        target = decoded;
      }
      if (!isValidHttpUrl(target)) return "";
      current = target;
    } catch {
      return "";
    }
  }
  return isValidHttpUrl(current) ? current : "";
}

function isLikelyChildPlaylistUrl(rawUrl: string) {
  if (!isValidHttpUrl(rawUrl)) return false;
  try {
    const parsed = new URL(rawUrl);
    const pathname = String(parsed.pathname || "").toLowerCase();
    const search = String(parsed.search || "").toLowerCase();
    const combined = `${pathname}${search}`;
    if (/\.(?:ts|m4s|m4a|mp4|aac|mp3|vtt)(?:$|[?#])/i.test(pathname)) return false;
    if (combined.includes(".mpd")) return false;
    if (combined.includes(".m3u8")) return true;
    if (
      pathname.includes("/kooora/") ||
      pathname.includes("/playlist/") ||
      pathname.includes("/manifest/") ||
      pathname.includes("/stream/") ||
      pathname.includes("/live/") ||
      pathname.includes("/hls/")
    ) {
      return true;
    }
    return (
      search.includes("token=") ||
      search.includes("sid=") ||
      search.includes("session") ||
      search.includes("playlist") ||
      search.includes("m3u8")
    );
  } catch {
    return false;
  }
}

function looksLikeManifestResponse(contentType: string, body: string, finalUrl: string) {
  const ct = String(contentType || "").toLowerCase();
  const text = String(body || "");
  if (/^\s*#extm3u/m.test(text)) return true;
  if (ct.includes("application/vnd.apple.mpegurl") || ct.includes("application/x-mpegurl")) return true;
  return isLikelyChildPlaylistUrl(finalUrl);
}

function hasMediaSegments(manifest: string, baseUrl: string) {
  let previousExtInf = false;
  for (const line of String(manifest || "").split(/\r?\n/)) {
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

function pickVariantManifestUrl(manifest: string, baseUrl: string) {
  let pendingBandwidth = -1;
  const variants: Array<{ url: string; bandwidth: number; order: number }> = [];
  let order = 0;

  for (const line of String(manifest || "").split(/\r?\n/)) {
    const trimmed = String(line || "").trim();
    if (!trimmed) continue;
    if (trimmed.startsWith("#EXT-X-STREAM-INF")) {
      const match = trimmed.match(/BANDWIDTH=(\d+)/i);
      pendingBandwidth = match?.[1] ? Number.parseInt(match[1], 10) : -1;
      continue;
    }
    if (trimmed.startsWith("#")) continue;

    const absolute = resolveManifestUrl(trimmed, baseUrl);
    if (!absolute || !isLikelyChildPlaylistUrl(absolute)) {
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

function inheritEasybroadcastManifestAuth(rawChildAbsoluteUrl: string, baseUrl: string) {
  try {
    const child = new URL(rawChildAbsoluteUrl);
    const parent = new URL(baseUrl);
    const childHost = child.hostname.toLowerCase();
    if (!(childHost === "cdn.live.easybroadcast.io" || childHost.endsWith(".easybroadcast.io"))) {
      return rawChildAbsoluteUrl;
    }
    if (child.searchParams.get("token")) return rawChildAbsoluteUrl;

    const token = String(parent.searchParams.get("token") || "").trim();
    const expires = String(parent.searchParams.get("expires") || "").trim();
    const tokenPath = String(parent.searchParams.get("token_path") || "").trim();
    if (!token || !expires) return rawChildAbsoluteUrl;

    if (tokenPath) {
      const decoded = safeDecodeURIComponent(tokenPath).trim().replace(/\/+$/, "");
      if (decoded && !child.pathname.toLowerCase().startsWith(decoded.toLowerCase())) {
        return rawChildAbsoluteUrl;
      }
    }

    child.searchParams.set("token", token);
    child.searchParams.set("expires", expires);
    if (tokenPath) child.searchParams.set("token_path", tokenPath);
    return child.toString();
  } catch {
    return rawChildAbsoluteUrl;
  }
}

function inheritYallashotManifestAuth(rawChildAbsoluteUrl: string, baseUrl: string) {
  try {
    const child = new URL(rawChildAbsoluteUrl);
    const parent = new URL(baseUrl);
    const childHost = child.hostname.toLowerCase();
    const parentHost = parent.hostname.toLowerCase();
    const childPath = String(child.pathname || "").toLowerCase();
    const parentPath = String(parent.pathname || "").toLowerCase();
    const isYallashotPair =
      (childHost === "yallashot.us" || childHost.endsWith(".yallashot.us")) &&
      (parentHost === "yallashot.us" || parentHost.endsWith(".yallashot.us")) &&
      (childPath.includes("/kooora/") || parentPath.includes("/kooora/"));
    if (!isYallashotPair) return rawChildAbsoluteUrl;

    const token = String(parent.searchParams.get("token") || "").trim();
    const parentSid = String(parent.searchParams.get("sid") || "").trim();
    const sessionId = String(parent.searchParams.get("session_id") || "").trim();
    const sid = parentSid || sessionId;
    if (!token || !sid) return rawChildAbsoluteUrl;
    if (!child.searchParams.get("token")) child.searchParams.set("token", token);
    if (!child.searchParams.get("sid")) child.searchParams.set("sid", sid);
    if (!child.searchParams.get("session_id") && sessionId) child.searchParams.set("session_id", sessionId);

    const ts = String(parent.searchParams.get("ts") || "").trim();
    const nonce = String(parent.searchParams.get("nonce") || "").trim();
    if (ts && !child.searchParams.get("ts")) child.searchParams.set("ts", ts);
    if (nonce && !child.searchParams.get("nonce")) child.searchParams.set("nonce", nonce);
    return child.toString();
  } catch {
    return rawChildAbsoluteUrl;
  }
}

function inheritEmbeddedManifestAuth(rawChildAbsoluteUrl: string, baseUrl: string) {
  return inheritYallashotManifestAuth(inheritEasybroadcastManifestAuth(rawChildAbsoluteUrl, baseUrl), baseUrl);
}

function buildSessionAssetUrl(input: {
  internalOrigin: string;
  slotServer: SlotServerId;
  sourceUrl: string;
  assetUrl: string;
  referrerUrl?: string;
}) {
  if (!isValidHttpUrl(input.internalOrigin) || !isValidHttpUrl(input.sourceUrl) || !isValidHttpUrl(input.assetUrl)) return "";
  const params = new URLSearchParams();
  params.set("slotServer", String(input.slotServer));
  params.set("sourceUrl", input.sourceUrl);
  params.set("assetUrl", input.assetUrl);
  if (isValidHttpUrl(String(input.referrerUrl || "").trim())) {
    params.set("referrerUrl", String(input.referrerUrl || "").trim());
  }
  return `${String(input.internalOrigin || "").replace(/\/+$/, "")}/api/repack/session-asset?${params.toString()}`;
}

function pickSessionFetchUrl(fetchUrl: string | undefined, targetUrl: string, internalOrigin: string) {
  const normalizedTargetUrl = String(targetUrl || "").trim();
  const normalizedFetchUrl = String(fetchUrl || "").trim();
  if (!isValidHttpUrl(normalizedFetchUrl) || !isValidHttpUrl(normalizedTargetUrl)) return normalizedTargetUrl;
  try {
    const parsed = new URL(normalizedFetchUrl);
    if (parsed.origin === String(internalOrigin || "").replace(/\/+$/, "")) return normalizedFetchUrl;
  } catch {}
  return normalizedTargetUrl;
}

function rewriteManifestForSessionMirror(
  manifest: string,
  baseUrl: string,
  internalOrigin: string,
  sourceUrl: string,
  slotServer: SlotServerId
) {
  const lines = String(manifest || "").split(/\r?\n/);
  const out: string[] = [];

  const rewriteAssetUrl = (raw: string) => {
    const absolute = resolveManifestUrl(raw, baseUrl);
    if (!absolute) return raw;
    const inherited = inheritEmbeddedManifestAuth(absolute, baseUrl);
    const unwrapped = unwrapProxyTarget(inherited) || inherited;
    if (!isValidHttpUrl(unwrapped)) return raw;
    return buildSessionAssetUrl({
      internalOrigin,
      slotServer,
      sourceUrl,
      assetUrl: unwrapped,
      referrerUrl: baseUrl,
    });
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

async function resolveSessionCandidateMediaManifest(input: {
  sourceUrl: string;
  slotServer: SlotServerId;
  internalOrigin: string;
  targetUrl: string;
  fetchUrl?: string;
  referrerUrl: string;
  manifestBody?: string;
  manifestSeenAt?: number;
}) {
  let currentUrl = String(input.targetUrl || "").trim();
  let currentFetchUrl = pickSessionFetchUrl(input.fetchUrl, currentUrl, input.internalOrigin);
  let currentReferrerUrl = String(input.referrerUrl || input.sourceUrl).trim() || input.sourceUrl;
  const manifestSeenAt = Number.isFinite(input.manifestSeenAt) ? Number(input.manifestSeenAt) : 0;
  const canReuseInlineManifest =
    !!String(input.manifestBody || "").trim() &&
    manifestSeenAt > 0 &&
    Date.now() - manifestSeenAt <= INLINE_SESSION_MANIFEST_MAX_AGE_MS;
  let currentBody = canReuseInlineManifest ? String(input.manifestBody || "").trim() : "";

  for (let depth = 0; depth < 3; depth += 1) {
    if (!currentBody) {
      const fetched = await fetchLiveEmbedText({
        sourceUrl: input.sourceUrl,
        requestOrigin: input.internalOrigin,
        slotServerId: input.slotServer,
        targetUrl: currentUrl,
        fetchUrl: currentFetchUrl,
        referrerUrl: currentReferrerUrl,
        timeoutMs: DEFAULT_RESOLVE_TIMEOUT_MS,
      });
      if (!fetched.ok || !looksLikeManifestResponse(fetched.contentType, fetched.body, fetched.finalUrl || currentUrl)) {
        return {
          ok: false as const,
          error: fetched.error || `manifest-http-${fetched.status || 0}`,
        };
      }
      currentBody = fetched.body;
      currentFetchUrl = fetched.finalUrl || currentFetchUrl;
      currentUrl = unwrapProxyTarget(currentFetchUrl) || currentUrl;
    }

    if (hasMediaSegments(currentBody, currentUrl)) {
      return {
        ok: true as const,
        body: currentBody,
        finalUrl: currentUrl,
      };
    }

    const variantUrl = pickVariantManifestUrl(currentBody, currentUrl);
    if (!variantUrl) {
      return {
        ok: false as const,
        error: "manifest-no-media-playlist",
      };
    }

    const nextVariantUrl = inheritEmbeddedManifestAuth(variantUrl, currentUrl);
    currentReferrerUrl = currentUrl;
    currentUrl = unwrapProxyTarget(nextVariantUrl) || nextVariantUrl;
    currentFetchUrl = nextVariantUrl;
    currentBody = "";
  }

  return {
    ok: false as const,
    error: "manifest-recursion-limit",
  };
}

function looksLikePlayerv2Source(rawUrl: string) {
  if (!isValidHttpUrl(rawUrl)) return false;
  try {
    const parsed = new URL(rawUrl);
    return String(parsed.pathname || "").toLowerCase().includes("/playerv2.php");
  } catch {
    return false;
  }
}

function looksLikeBeinSource(rawUrl: string) {
  if (!isValidHttpUrl(rawUrl)) return false;
  try {
    const parsed = new URL(rawUrl);
    const host = parsed.hostname.toLowerCase();
    const pathname = String(parsed.pathname || "").toLowerCase();
    return (host === "bein-live.com" || host.endsWith(".bein-live.com")) && pathname.includes("/matches/");
  } catch {
    return false;
  }
}

function looksLikeAlbaSource(rawUrl: string) {
  if (!isValidHttpUrl(rawUrl)) return false;
  try {
    const parsed = new URL(rawUrl);
    const pathname = String(parsed.pathname || "").toLowerCase();
    return pathname.includes("/albaplayer/") || pathname.includes("/alba.php");
  } catch {
    return false;
  }
}

async function resolveSnapshotBackedManifest(
  input: RuntimeAdapterInput,
  adapterKind: RuntimeAdapterKind,
  candidateMaxAgeMs: number
): Promise<RuntimeManifestResult> {
  const snapshot = await extractLiveEmbedSessionSnapshot({
    sourceUrl: input.sourceUrl,
    requestOrigin: input.internalOrigin,
    slotServerId: input.slotServer,
    timeoutMs: DEFAULT_RESOLVE_TIMEOUT_MS,
  });
  const playbackUrl = String(snapshot.playbackUrl || "").trim();
  const now = Date.now();
  const candidates = (Array.isArray(snapshot.candidates) ? snapshot.candidates : []).filter((candidate) => {
    const ageMs = Math.max(0, now - Number(candidate.seenAt || 0));
    return ageMs <= candidateMaxAgeMs;
  });
  if (!candidates.length) {
    return {
      ok: false,
      error: snapshot.error || "embed-session-empty",
      playbackUrl,
      adapterKind,
      candidatesFound: 0,
      candidatesTried: 0,
    };
  }

  let candidatesTried = 0;
  let lastError = snapshot.error || "embed-session-empty";
  for (const candidate of candidates) {
    const targetUrl = String(candidate.targetUrl || "").trim();
    const referrerUrl = String(candidate.referrerUrl || input.sourceUrl).trim() || input.sourceUrl;
    if (!isValidHttpUrl(targetUrl)) continue;
    if (
      !isIngestCandidateAlignedWithSlotServer({
        slotServerId: input.slotServer,
        sourceUrl: input.sourceUrl,
        ingestUrl: targetUrl,
        probeReferrerUrl: referrerUrl,
        probePlaylistUrl: targetUrl,
      })
    ) {
      continue;
    }

    candidatesTried += 1;
    const resolved = await resolveSessionCandidateMediaManifest({
      sourceUrl: input.sourceUrl,
      slotServer: input.slotServer,
      internalOrigin: input.internalOrigin,
      targetUrl,
      fetchUrl: candidate.fetchUrl,
      referrerUrl,
      manifestBody: candidate.manifestBody,
      manifestSeenAt: Number(candidate.seenAt || 0),
    });
    if (!resolved.ok) {
      lastError = resolved.error || lastError;
      continue;
    }

    return {
      ok: true,
      manifestBody: rewriteManifestForSessionMirror(
        resolved.body,
        resolved.finalUrl,
        input.internalOrigin,
        input.sourceUrl,
        input.slotServer
      ),
      finalUrl: resolved.finalUrl,
      targetUrl,
      referrerUrl,
      playbackUrl,
      adapterKind,
      candidatesFound: candidates.length,
      candidatesTried,
    };
  }

  return {
    ok: false,
    error: lastError || "embed-session-no-verified-manifest",
    playbackUrl,
    adapterKind,
    candidatesFound: candidates.length,
    candidatesTried,
  };
}

const runtimeAdapters: RuntimeAdapter[] = [
  {
    kind: "playerv2",
    matches: (input) => input.slotServer === 2 || looksLikePlayerv2Source(input.sourceUrl) || getSourceFamilyForSlotServer(input.slotServer) === "siiir",
    resolve: async (input) => resolveSnapshotBackedManifest(input, "playerv2", PLAYERV2_RUNTIME_MANIFEST_MAX_AGE_MS),
  },
  {
    kind: "bein",
    matches: (input) => input.slotServer === 1 || looksLikeBeinSource(input.sourceUrl) || getSourceFamilyForSlotServer(input.slotServer) === "bein",
    resolve: async (input) => resolveSnapshotBackedManifest(input, "bein", DEFAULT_RUNTIME_MANIFEST_MAX_AGE_MS),
  },
  {
    kind: "alba",
    matches: (input) =>
      input.slotServer === 3 ||
      input.slotServer === 4 ||
      looksLikeAlbaSource(input.sourceUrl) ||
      getSourceFamilyForSlotServer(input.slotServer) === "livehd" ||
      getSourceFamilyForSlotServer(input.slotServer) === "livekora",
    resolve: async (input) => resolveSnapshotBackedManifest(input, "alba", DEFAULT_RUNTIME_MANIFEST_MAX_AGE_MS),
  },
  {
    kind: "default",
    matches: () => true,
    resolve: async (input) => resolveSnapshotBackedManifest(input, "default", DEFAULT_RUNTIME_MANIFEST_MAX_AGE_MS),
  },
];

function pickRuntimeAdapter(input: RuntimeAdapterInput) {
  return runtimeAdapters.find((adapter) => adapter.matches(input)) || runtimeAdapters[runtimeAdapters.length - 1];
}

async function fetchMatchRow(matchId: number) {
  const { data, error } = await supabaseAdmin
    .from("match-stream-app")
    .select("id,match_key,home_team,away_team,match_start,match_day,status_key,stream_url,stream_url_2,stream_url_3,stream_url_4")
    .eq("id", matchId)
    .maybeSingle();
  const enriched = data ? await enrichMatchRowWithDuplicateSiblingStreams(data as MatchRow) : null;
  return {
    data: (enriched || null) as MatchRow | null,
    error: (error || null) as { message?: string } | null,
  };
}

async function resolveRuntimeManifestForRequest(req: Request) {
  const url = new URL(req.url);
  const matchId = toInt(url.searchParams.get("matchId"));
  const slotServer = toInt(url.searchParams.get("slotServer"));
  if (!Number.isFinite(matchId) || matchId <= 0) {
    return NextResponse.json({ ok: false, error: "invalid-match-id" }, { status: 400 });
  }
  if (!Number.isFinite(slotServer) || !isSlotServerId(slotServer)) {
    return NextResponse.json({ ok: false, error: "invalid-slot-server" }, { status: 400 });
  }

  const internalOrigin = resolveInternalPlayerOrigin(req);
  const { data, error } = await fetchMatchRow(matchId);
  if (error) return NextResponse.json({ ok: false, error: String(error.message || "db-error") }, { status: 500 });
  if (!data) return NextResponse.json({ ok: false, error: "match-not-found" }, { status: 404 });

  const sourceUrl = String(getSlotSourceUrlFromRow(data, slotServer) || "").trim();
  if (!sourceUrl || !isValidHttpUrl(sourceUrl)) {
    return NextResponse.json({ ok: false, error: "missing-source" }, { status: 502 });
  }
  if (!isAllowedSourceForSlotServer(slotServer, sourceUrl)) {
    return NextResponse.json({ ok: false, error: "source-not-allowed" }, { status: 502 });
  }

  const adapter = pickRuntimeAdapter({
    sourceUrl,
    slotServer,
    internalOrigin,
  });
  const resolved = await adapter.resolve({
    sourceUrl,
    slotServer,
    internalOrigin,
  });

  if (resolved.ok) {
    return new Response(resolved.manifestBody, {
      status: 200,
      headers: {
        "content-type": "application/vnd.apple.mpegurl; charset=utf-8",
        "cache-control": "no-store, no-cache, must-revalidate, max-age=0",
        "x-repack-gateway": "1",
        "x-repack-slot-server": String(slotServer),
        "x-repack-source-url": sourceUrl,
        "x-repack-upstream-url": resolved.targetUrl,
        "x-repack-extractor": "embed-session",
        "x-repack-runtime-adapter": resolved.adapterKind,
        "x-repack-extractor-candidates-found": String(resolved.candidatesFound),
        "x-repack-extractor-candidates-tried": String(resolved.candidatesTried),
      },
    });
  }

  return NextResponse.json(
    {
      ok: false,
      error: `embed-session-${resolved.error || "resolution-failed"}`,
      extractor: {
        mode: "embed-session",
        adapter: resolved.adapterKind,
        playbackUrl: resolved.playbackUrl || null,
        candidatesFound: resolved.candidatesFound,
        candidatesTried: resolved.candidatesTried,
      },
    },
    { status: 502 }
  );
}

export async function handleRuntimeSessionManifestRequest(req: Request) {
  return resolveRuntimeManifestForRequest(req);
}
