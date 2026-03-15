import {
  ensureLiveEmbedSessionRuntime,
  fetchLiveEmbedAsset,
  fetchLiveEmbedText,
  peekLiveEmbedSessionState,
  refreshLiveEmbedRuntime,
  rotateLiveEmbedRuntime,
  type LiveEmbedSessionCandidate,
  type LiveEmbedSessionRuntimeState,
} from "@/lib/repack-embed-session";
import {
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
export const PLAYERV2_RUNTIME_MANIFEST_MAX_AGE_MS = Math.max(
  4_000,
  Number.parseInt(String(process.env.REPACK_PLAYERV2_RUNTIME_MANIFEST_MAX_AGE_MS || "12000"), 10) || 12_000
);
export const DEFAULT_RUNTIME_MANIFEST_MAX_AGE_MS = Math.max(
  6_000,
  Number.parseInt(String(process.env.REPACK_DEFAULT_RUNTIME_MANIFEST_MAX_AGE_MS || "24000"), 10) || 24_000
);
const ACTIVE_RUNTIME_HINT_TTL_MS = Math.max(
  8_000,
  Number.parseInt(String(process.env.REPACK_ACTIVE_RUNTIME_HINT_TTL_MS || "30000"), 10) || 30_000
);

type SessionCandidate = LiveEmbedSessionCandidate;

type RuntimeResolutionOptions = {
  adapterKind: RuntimeAdapterKind;
  candidateMaxAgeMs: number;
  maxCandidatesToTry: number;
  forceFreshManifest?: boolean;
  preferUrlIncludes?: string[];
  preferReferrerIncludes?: string[];
  preferManifestIncludes?: string[];
  readyManifestMaxAgeMs?: number;
  warmingRuntimeMaxAgeMs?: number;
  warmingProgressMaxAgeMs?: number;
  runtimeWatchdogReadyStates?: string[];
  runtimeWatchdogWarmingStates?: string[];
};

type RuntimeManifestQueryOptions = {
  waitForMediaSequence?: number | null;
  waitTimeoutMs?: number | null;
  allowRotate?: boolean;
  forceRefresh?: boolean;
};

type RuntimePeekState = ReturnType<typeof peekLiveEmbedSessionState>;

type ActiveRuntimeHint = {
  targetUrl: string;
  fetchUrl?: string;
  referrerUrl: string;
  updatedAt: number;
};

export type RuntimeHintCandidate = {
  targetUrl: string;
  fetchUrl?: string;
  referrerUrl: string;
};

function isSequenceRollback(nextMediaSequence: number | null, previousMediaSequence: number | null) {
  if (!Number.isFinite(nextMediaSequence) || !Number.isFinite(previousMediaSequence)) return false;
  return Number(nextMediaSequence) + 2 < Number(previousMediaSequence);
}

export type RuntimeAdapterKind = "playerv2" | "bein" | "livehd" | "alba" | "default";

export type RuntimeAdapterInput = {
  sourceUrl: string;
  slotServer: SlotServerId;
  internalOrigin: string;
};

export type RuntimeManifestResult =
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
      adapterKind: RuntimeAdapterKind;
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
      adapterKind: RuntimeAdapterKind;
      candidatesFound: number;
      candidatesTried: number;
    };

export type RuntimeCurrentSourceResult = {
  ok: boolean;
  currentSource: string;
  fetchUrl?: string;
  referrerUrl: string;
  playbackUrl: string;
  adapterKind: RuntimeAdapterKind;
  candidatesFound: number;
  freshManifestCount: number;
  error?: string;
};

export type RuntimeControlResult = {
  ok: boolean;
  adapterKind: RuntimeAdapterKind;
  currentSource: string;
  playbackUrl: string;
  runtimeState: LiveEmbedSessionRuntimeState | RuntimePeekState;
};

export type RuntimeAdapterPeekResult = {
  state: "ready" | "warming" | "down";
  reason: string;
  recoverable: boolean;
  adapterKind: RuntimeAdapterKind;
  playbackUrl: string;
  currentSource: string;
  runtimePath: string;
  sourceCount: number;
  sourceIndex: number | null;
  tabIndex: number | null;
  mediaSequence: number | null;
  targetDurationSec: number;
  activeManifestAgeMs: number | null;
  lastRefreshReason: string;
  lastRefreshAt: number;
  lastRotateReason: string;
  lastRotateAt: number;
  watchdogState: string;
  lastRuntimeEvent: string;
  lastRuntimeEventReason: string;
  lastRuntimeEventAt: number;
  freshManifestCount: number;
  freshCandidateCount: number;
  candidateCount: number;
  lastError: string;
  runtimeState: RuntimePeekState;
};

export type RuntimeAdapter = {
  kind: RuntimeAdapterKind;
  matches: (input: RuntimeAdapterInput) => boolean;
  currentSource: (input: RuntimeAdapterInput) => Promise<RuntimeCurrentSourceResult>;
  currentManifest: (input: RuntimeAdapterInput, options?: RuntimeManifestQueryOptions) => Promise<RuntimeManifestResult>;
  refresh: (input: RuntimeAdapterInput, reason?: string) => Promise<RuntimeControlResult>;
  rotate: (input: RuntimeAdapterInput, reason?: string) => Promise<RuntimeControlResult>;
  fetchAsset: (input: RuntimeAdapterInput & { assetUrl: string; referrerUrl?: string | null; timeoutMs?: number }) => ReturnType<typeof fetchLiveEmbedAsset>;
  peek: (input: RuntimeAdapterInput) => RuntimePeekState;
  peekStatus: (input: RuntimeAdapterInput) => RuntimeAdapterPeekResult;
};

const activeRuntimeHints = new Map<string, ActiveRuntimeHint>();

function safeDecodeURIComponent(value: string) {
  try {
    return decodeURIComponent(String(value || ""));
  } catch {
    return String(value || "");
  }
}

function buildRuntimeKey(input: RuntimeAdapterInput) {
  return `${input.slotServer}|${String(input.sourceUrl || "").trim()}`;
}

function readActiveHint(input: RuntimeAdapterInput) {
  const key = buildRuntimeKey(input);
  const hint = activeRuntimeHints.get(key);
  if (!hint) return null;
  if (Date.now() - hint.updatedAt > ACTIVE_RUNTIME_HINT_TTL_MS) {
    activeRuntimeHints.delete(key);
    return null;
  }
  return hint;
}

function writeActiveHint(input: RuntimeAdapterInput, resolved: { targetUrl: string; fetchUrl?: string; referrerUrl: string }) {
  activeRuntimeHints.set(buildRuntimeKey(input), {
    targetUrl: resolved.targetUrl,
    fetchUrl: resolved.fetchUrl,
    referrerUrl: resolved.referrerUrl,
    updatedAt: Date.now(),
  });
}

export function primeRuntimeHint(input: RuntimeAdapterInput, resolved: RuntimeHintCandidate) {
  const targetUrl = String(resolved.targetUrl || "").trim();
  const referrerUrl = String(resolved.referrerUrl || input.sourceUrl).trim() || input.sourceUrl;
  const fetchUrl = String(resolved.fetchUrl || targetUrl).trim() || undefined;
  if (!isValidHttpUrl(targetUrl) || !isValidHttpUrl(referrerUrl)) return false;
  writeActiveHint(input, {
    targetUrl,
    fetchUrl: fetchUrl && isValidHttpUrl(fetchUrl) ? fetchUrl : undefined,
    referrerUrl,
  });
  return true;
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
    if (!(childHost === "cdn.live.easybroadcast.io" || childHost.endsWith(".easybroadcast.io"))) return rawChildAbsoluteUrl;
    if (child.searchParams.get("token")) return rawChildAbsoluteUrl;

    const token = String(parent.searchParams.get("token") || "").trim();
    const expires = String(parent.searchParams.get("expires") || "").trim();
    const tokenPath = String(parent.searchParams.get("token_path") || "").trim();
    if (!token || !expires) return rawChildAbsoluteUrl;

    if (tokenPath) {
      const decoded = safeDecodeURIComponent(tokenPath).trim().replace(/\/+$/, "");
      if (decoded && !child.pathname.toLowerCase().startsWith(decoded.toLowerCase())) return rawChildAbsoluteUrl;
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
  if (isValidHttpUrl(String(input.referrerUrl || "").trim())) params.set("referrerUrl", String(input.referrerUrl || "").trim());
  return `${String(input.internalOrigin || "").replace(/\/+$/, "")}/api/livekora/session-asset?${params.toString()}`;
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

export function rewriteManifestForSessionMirror(
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
  timeoutMs?: number;
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
      const timeoutMs = Math.max(
        4_000,
        Math.min(
          DEFAULT_RESOLVE_TIMEOUT_MS,
          Number.isFinite(Number(input.timeoutMs)) ? Number(input.timeoutMs) : DEFAULT_RESOLVE_TIMEOUT_MS
        )
      );
      const fetched = await fetchLiveEmbedText({
        sourceUrl: input.sourceUrl,
        requestOrigin: input.internalOrigin,
        slotServerId: input.slotServer,
        targetUrl: currentUrl,
        fetchUrl: currentFetchUrl,
        referrerUrl: currentReferrerUrl,
        timeoutMs,
      });
      if (!fetched.ok || !looksLikeManifestResponse(fetched.contentType, fetched.body, fetched.finalUrl || currentUrl)) {
        return { ok: false as const, error: fetched.error || `manifest-http-${fetched.status || 0}` };
      }
      currentBody = fetched.body;
      currentFetchUrl = fetched.finalUrl || currentFetchUrl;
      currentUrl = unwrapProxyTarget(currentFetchUrl) || currentUrl;
    }

    if (hasMediaSegments(currentBody, currentUrl)) {
      return { ok: true as const, body: currentBody, finalUrl: currentUrl };
    }

    const variantUrl = pickVariantManifestUrl(currentBody, currentUrl);
    if (!variantUrl) return { ok: false as const, error: "manifest-no-media-playlist" };

    const nextVariantUrl = inheritEmbeddedManifestAuth(variantUrl, currentUrl);
    currentReferrerUrl = currentUrl;
    currentUrl = unwrapProxyTarget(nextVariantUrl) || nextVariantUrl;
    currentFetchUrl = nextVariantUrl;
    currentBody = "";
  }

  return { ok: false as const, error: "manifest-recursion-limit" };
}

function buildHintCandidate(hint: ActiveRuntimeHint): SessionCandidate {
  return {
    fetchUrl: hint.fetchUrl,
    targetUrl: hint.targetUrl,
    referrerUrl: hint.referrerUrl,
    seenAt: hint.updatedAt,
    score: 0,
    via: "dom",
  };
}

function scoreCandidate(candidate: SessionCandidate, options: RuntimeResolutionOptions, hint: ActiveRuntimeHint | null, now: number) {
  let score = Number(candidate.score || 0);
  const ageMs = Math.max(0, now - Number(candidate.seenAt || 0));
  score -= Math.min(ageMs, options.candidateMaxAgeMs * 2);
  if (candidate.manifestBody) score += 800;
  if (candidate.via === "network-manifest") score += 500;
  if (candidate.via === "network-request") score += 200;
  const target = `${String(candidate.targetUrl || "")} ${String(candidate.fetchUrl || "")}`.toLowerCase();
  const referrer = String(candidate.referrerUrl || "").toLowerCase();
  const manifest = `${String(candidate.manifestBody || "")} ${String(candidate.manifestBaseUrl || "")}`.toLowerCase();
  for (const pattern of options.preferUrlIncludes || []) {
    if (target.includes(pattern.toLowerCase())) score += 300;
  }
  for (const pattern of options.preferReferrerIncludes || []) {
    if (referrer.includes(pattern.toLowerCase())) score += 220;
  }
  for (const pattern of options.preferManifestIncludes || []) {
    if (manifest.includes(pattern.toLowerCase())) score += 180;
  }
  if (
    hint &&
    (candidate.targetUrl === hint.targetUrl || String(candidate.fetchUrl || "").trim() === String(hint.fetchUrl || "").trim())
  ) {
    score += 3_000;
  }
  return score;
}

function buildPseudoCandidate(input: {
  targetUrl: string;
  fetchUrl?: string;
  referrerUrl: string;
  seenAt: number;
  score: number;
}): SessionCandidate {
  return {
    targetUrl: input.targetUrl,
    fetchUrl: input.fetchUrl,
    referrerUrl: input.referrerUrl,
    seenAt: input.seenAt,
    score: input.score,
    via: "dom",
  };
}

function parseMediaSequence(manifestText: string) {
  const match = String(manifestText || "").match(/#EXT-X-MEDIA-SEQUENCE:(\d+)/i);
  if (!match || !match[1]) return null;
  const value = Number.parseInt(match[1], 10);
  return Number.isFinite(value) ? value : null;
}

function parseTargetDurationSec(manifestText: string) {
  for (const line of String(manifestText || "").split(/\r?\n/)) {
    const trimmed = String(line || "").trim();
    const match = trimmed.match(/^#EXT-X-TARGETDURATION:(\d+(?:\.\d+)?)/i);
    if (!match || !match[1]) continue;
    const value = Number.parseFloat(match[1]);
    if (Number.isFinite(value) && value > 0) return value;
  }
  return 0;
}

function buildCandidateQueue(
  input: RuntimeAdapterInput,
  runtimeState: LiveEmbedSessionRuntimeState,
  options: RuntimeResolutionOptions
) {
  const now = Date.now();
  const hint = readActiveHint(input);
  const queue = new Map<string, SessionCandidate>();
  const addCandidate = (candidate: SessionCandidate | null | undefined) => {
    if (!candidate) return;
    const key = `${String(candidate.targetUrl || "").trim()}|${String(candidate.fetchUrl || "").trim()}`;
    if (!key || queue.has(key)) return;
    queue.set(key, candidate);
  };

  if (runtimeState.activeManifestUrl) {
    addCandidate(
      buildPseudoCandidate({
        targetUrl: runtimeState.activeManifestUrl,
        fetchUrl: runtimeState.activeManifestFetchUrl || runtimeState.activeManifestUrl,
        referrerUrl: runtimeState.activeManifestReferrerUrl || input.sourceUrl,
        seenAt: runtimeState.activeManifestUpdatedAt || now,
        score: 9_000,
      })
    );
  }

  if (runtimeState.runtimeActiveSource) {
    addCandidate(
      buildPseudoCandidate({
        targetUrl: runtimeState.runtimeActiveSource,
        fetchUrl: runtimeState.runtimeActiveSource,
        referrerUrl: runtimeState.activeManifestReferrerUrl || input.sourceUrl,
        seenAt: runtimeState.runtimeUpdatedAt || now,
        score: 7_000,
      })
    );
  }

  runtimeState.runtimeSources.forEach((runtimeSource, idx) => {
    addCandidate(
      buildPseudoCandidate({
        targetUrl: runtimeSource,
        fetchUrl: runtimeSource,
        referrerUrl: runtimeState.activeManifestReferrerUrl || input.sourceUrl,
        seenAt: runtimeState.runtimeUpdatedAt || now,
        score: 6_000 - idx * 40,
      })
    );
  });

  if (hint) {
    const hinted = buildHintCandidate(hint);
    hinted.score = 4_000;
    addCandidate(hinted);
  }

  for (const candidate of runtimeState.candidates) {
    addCandidate(candidate);
  }

  return Array.from(queue.values())
    .filter((candidate) => {
      const ageMs = Math.max(0, now - Number(candidate.seenAt || 0));
      return (
        ageMs <= options.candidateMaxAgeMs ||
        (!!hint && candidate.targetUrl === hint.targetUrl) ||
        candidate.score >= 4_000
      );
    })
    .filter((candidate) => {
      const targetUrl = String(candidate.targetUrl || "").trim();
      const referrerUrl = String(candidate.referrerUrl || input.sourceUrl).trim() || input.sourceUrl;
      return (
        isValidHttpUrl(targetUrl) &&
        isIngestCandidateAlignedWithSlotServer({
          slotServerId: input.slotServer,
          sourceUrl: input.sourceUrl,
          ingestUrl: targetUrl,
          probeReferrerUrl: referrerUrl,
          probePlaylistUrl: targetUrl,
        })
      );
    })
    .map((candidate) => ({
      ...candidate,
      score: scoreCandidate(candidate, options, hint, now),
    }))
    .sort((left, right) => {
      const scoreDelta = Number(right.score || 0) - Number(left.score || 0);
      if (scoreDelta !== 0) return scoreDelta;
      return Number(right.seenAt || 0) - Number(left.seenAt || 0);
    });
}

async function currentSourceFromRuntimeState(
  input: RuntimeAdapterInput,
  runtimeState: LiveEmbedSessionRuntimeState,
  options: RuntimeResolutionOptions
): Promise<RuntimeCurrentSourceResult> {
  const candidates = buildCandidateQueue(input, runtimeState, options);
  const current = candidates[0];
  return {
    ok: !!current,
    currentSource: String(current?.targetUrl || runtimeState.runtimeActiveSource || runtimeState.activeManifestUrl || ""),
    fetchUrl: String(current?.fetchUrl || runtimeState.activeManifestFetchUrl || "").trim() || undefined,
    referrerUrl:
      String(current?.referrerUrl || runtimeState.activeManifestReferrerUrl || input.sourceUrl).trim() || input.sourceUrl,
    playbackUrl: String(runtimeState.playbackUrl || "").trim(),
    adapterKind: options.adapterKind,
    candidatesFound: candidates.length,
    freshManifestCount: runtimeState.freshManifestCount,
    error: current ? undefined : runtimeState.lastError || "embed-session-empty",
  };
}

function buildPeekStatus(
  runtimeState: RuntimePeekState,
  options: RuntimeResolutionOptions
): RuntimeAdapterPeekResult {
  const now = Date.now();
  const readyManifestMaxAgeMs = Math.max(2_000, Number(options.readyManifestMaxAgeMs || options.candidateMaxAgeMs || 8_000));
  const warmingRuntimeMaxAgeMs = Math.max(4_000, Number(options.warmingRuntimeMaxAgeMs || readyManifestMaxAgeMs * 2 || 16_000));
  const warmingProgressMaxAgeMs = Math.max(
    4_000,
    Number(options.warmingProgressMaxAgeMs || Math.max(readyManifestMaxAgeMs, 8_000))
  );
  const activeManifestAgeMs =
    Number.isFinite(Number(runtimeState?.activeManifestUpdatedAt || 0)) && Number(runtimeState?.activeManifestUpdatedAt || 0) > 0
      ? Math.max(0, now - Number(runtimeState?.activeManifestUpdatedAt || 0))
      : null;
  const runtimeAgeMs =
    Number.isFinite(Number(runtimeState?.runtimeUpdatedAt || 0)) && Number(runtimeState?.runtimeUpdatedAt || 0) > 0
      ? Math.max(0, now - Number(runtimeState?.runtimeUpdatedAt || 0))
      : null;
  const progressAgeMs =
    Number.isFinite(Number(runtimeState?.runtimeLastProgressAt || 0)) && Number(runtimeState?.runtimeLastProgressAt || 0) > 0
      ? Math.max(0, now - Number(runtimeState?.runtimeLastProgressAt || 0))
      : null;
  const sourceCount = Math.max(
    Number.parseInt(String(runtimeState?.runtimeSourceCount || 0), 10) || 0,
    Array.isArray(runtimeState?.runtimeSources) ? runtimeState.runtimeSources.length : 0
  );
  const currentSource = String(runtimeState?.runtimeActiveSource || runtimeState?.activeManifestUrl || "").trim();
  const watchdogState = String(runtimeState?.runtimeWatchdogState || "").trim().toLowerCase();
  const readyWatchdogStates = new Set((options.runtimeWatchdogReadyStates || ["healthy"]).map((value) => String(value || "").toLowerCase()));
  const warmingWatchdogStates = new Set(
    (options.runtimeWatchdogWarmingStates || ["refreshing", "recovering", "stalled"]).map((value) => String(value || "").toLowerCase())
  );
  const lastError = String(runtimeState?.lastError || "").trim();
  const base: Omit<RuntimeAdapterPeekResult, "state" | "reason" | "recoverable"> = {
    adapterKind: options.adapterKind,
    playbackUrl: String(runtimeState?.playbackUrl || "").trim(),
    currentSource,
    runtimePath: String(runtimeState?.runtimePath || "").trim(),
    sourceCount,
    sourceIndex:
      Number.isFinite(Number(runtimeState?.runtimeSourceIndex)) ? Number(runtimeState?.runtimeSourceIndex) : null,
    tabIndex: Number.isFinite(Number(runtimeState?.runtimeTabIndex)) ? Number(runtimeState?.runtimeTabIndex) : null,
    mediaSequence:
      Number.isFinite(Number(runtimeState?.activeMediaSequence)) && runtimeState?.activeMediaSequence !== null
        ? Number(runtimeState?.activeMediaSequence)
        : null,
    targetDurationSec: Number.isFinite(Number(runtimeState?.activeTargetDurationSec))
      ? Number(runtimeState?.activeTargetDurationSec)
      : 0,
    activeManifestAgeMs,
    lastRefreshReason: String(runtimeState?.lastRefreshReason || "").trim(),
    lastRefreshAt: Number.isFinite(Number(runtimeState?.lastRefreshAt)) ? Number(runtimeState?.lastRefreshAt) : 0,
    lastRotateReason: String(runtimeState?.lastRotateReason || "").trim(),
    lastRotateAt: Number.isFinite(Number(runtimeState?.lastRotateAt)) ? Number(runtimeState?.lastRotateAt) : 0,
    watchdogState,
    lastRuntimeEvent: String(runtimeState?.lastRuntimeEvent || "").trim(),
    lastRuntimeEventReason: String(runtimeState?.lastRuntimeEventReason || "").trim(),
    lastRuntimeEventAt: Number.isFinite(Number(runtimeState?.lastRuntimeEventAt)) ? Number(runtimeState?.lastRuntimeEventAt) : 0,
    freshManifestCount: Math.max(0, Number.parseInt(String(runtimeState?.freshManifestCount || 0), 10) || 0),
    freshCandidateCount: Math.max(0, Number.parseInt(String(runtimeState?.freshCandidateCount || 0), 10) || 0),
    candidateCount: Math.max(0, Number.parseInt(String(runtimeState?.candidateCount || 0), 10) || 0),
    lastError,
    runtimeState,
  };

  if (!runtimeState) {
    return {
      ...base,
      state: "down",
      reason: "runtime-missing",
      recoverable: false,
    };
  }

  if (lastError.includes("missing-source")) {
    return {
      ...base,
      state: "down",
      reason: "missing-source",
      recoverable: false,
    };
  }

  if (
    activeManifestAgeMs !== null &&
    activeManifestAgeMs <= readyManifestMaxAgeMs &&
    (base.mediaSequence !== null || readyWatchdogStates.has(watchdogState) || base.freshManifestCount > 0)
  ) {
    return {
      ...base,
      state: "ready",
      reason: "runtime-active-manifest",
      recoverable: true,
    };
  }

  if (
    base.freshManifestCount > 0 ||
    (currentSource &&
      runtimeAgeMs !== null &&
      runtimeAgeMs <= warmingRuntimeMaxAgeMs &&
      (warmingWatchdogStates.has(watchdogState) ||
        readyWatchdogStates.has(watchdogState) ||
        (progressAgeMs !== null && progressAgeMs <= warmingProgressMaxAgeMs)))
  ) {
    return {
      ...base,
      state: "warming",
      reason: currentSource ? "runtime-source-active" : "runtime-manifest-fresh",
      recoverable: true,
    };
  }

  if (
    base.freshCandidateCount > 0 ||
    base.candidateCount > 0 ||
    sourceCount > 0 ||
    String(runtimeState?.state || "").trim().toLowerCase() === "starting" ||
    String(runtimeState?.state || "").trim().toLowerCase() === "running"
  ) {
    return {
      ...base,
      state: "warming",
      reason: lastError || "runtime-candidates-present",
      recoverable: true,
    };
  }

  return {
    ...base,
    state: "down",
    reason: lastError || "runtime-idle",
    recoverable: false,
  };
}

export async function resolveRuntimeOwnedManifest(
  input: RuntimeAdapterInput,
  options: RuntimeResolutionOptions,
  queryOptions?: RuntimeManifestQueryOptions
): Promise<RuntimeManifestResult> {
  const waitForMediaSequence =
    Number.isFinite(Number(queryOptions?.waitForMediaSequence)) ? Number(queryOptions?.waitForMediaSequence) : null;
  const deadlineAt =
    waitForMediaSequence !== null
      ? Date.now() + Math.max(1_000, Math.min(15_000, Number(queryOptions?.waitTimeoutMs || 6_000)))
      : 0;
  let refreshed = false;
  let rotated = false;
  let candidatesTried = 0;
  let lastError = "embed-session-empty";
  let lastPlaybackUrl = "";
  let lastCurrentSource = "";
  let lastTargetDurationSec = 0;
  let lastMediaSequence: number | null = null;
  let lastCandidatesFound = 0;
  const overallDeadlineAt =
    Date.now() +
    Math.max(
      10_000,
      Math.min(
        30_000,
        DEFAULT_RESOLVE_TIMEOUT_MS +
          Math.max(0, Math.min(10_000, Number.isFinite(Number(queryOptions?.waitTimeoutMs)) ? Number(queryOptions?.waitTimeoutMs) : 0))
      )
    );

  for (let attempt = 0; attempt < 4; attempt += 1) {
    const remainingBudgetMs = overallDeadlineAt - Date.now();
    if (remainingBudgetMs <= 0) break;
    const opTimeoutMs = Math.max(4_000, Math.min(DEFAULT_RESOLVE_TIMEOUT_MS, remainingBudgetMs));
    const runtimeState = await ensureLiveEmbedSessionRuntime({
      sourceUrl: input.sourceUrl,
      requestOrigin: input.internalOrigin,
      slotServerId: input.slotServer,
      timeoutMs: opTimeoutMs,
    });
    lastPlaybackUrl = String(runtimeState.playbackUrl || "").trim();
    const currentSource = await currentSourceFromRuntimeState(input, runtimeState, options);
    lastCurrentSource = currentSource.currentSource;
    const candidates = buildCandidateQueue(input, runtimeState, options);
    lastCandidatesFound = candidates.length;
    if (!candidates.length) {
      lastError = runtimeState.lastError || currentSource.error || "embed-session-empty";
    } else {
      for (const candidate of candidates.slice(0, Math.max(1, options.maxCandidatesToTry))) {
        candidatesTried += 1;
        const referrerUrl = String(candidate.referrerUrl || input.sourceUrl).trim() || input.sourceUrl;
        const targetUrl = String(candidate.targetUrl || "").trim();
        const resolved = await resolveSessionCandidateMediaManifest({
          sourceUrl: input.sourceUrl,
          slotServer: input.slotServer,
          internalOrigin: input.internalOrigin,
          targetUrl,
          fetchUrl: String(candidate.fetchUrl || "").trim() || undefined,
          referrerUrl,
          manifestBody: options.forceFreshManifest || queryOptions?.forceRefresh ? undefined : candidate.manifestBody,
          manifestSeenAt: Number(candidate.seenAt || 0),
          timeoutMs: opTimeoutMs,
        });
        if (!resolved.ok) {
          lastError = resolved.error || lastError;
          continue;
        }

        const mediaSequence = parseMediaSequence(resolved.body);
        const targetDurationSec = parseTargetDurationSec(resolved.body);
        lastMediaSequence = mediaSequence;
        lastTargetDurationSec = targetDurationSec;
        if (
          waitForMediaSequence !== null &&
          mediaSequence !== null &&
          mediaSequence <= waitForMediaSequence &&
          !isSequenceRollback(mediaSequence, waitForMediaSequence) &&
          Date.now() < deadlineAt
        ) {
          lastError = "media-sequence-unchanged";
          break;
        }

        writeActiveHint(input, {
          targetUrl,
          fetchUrl: String(candidate.fetchUrl || "").trim() || undefined,
          referrerUrl,
        });
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
          fetchUrl: String(candidate.fetchUrl || "").trim() || undefined,
          referrerUrl,
          playbackUrl: lastPlaybackUrl,
          currentSource: currentSource.currentSource || targetUrl,
          mediaSequence,
          targetDurationSec,
          refreshed,
          rotated,
          adapterKind: options.adapterKind,
          candidatesFound: candidates.length,
          candidatesTried,
          sessionOwned: true,
        };
      }
    }

    const shouldWaitForSequence =
      waitForMediaSequence !== null &&
      lastMediaSequence !== null &&
      lastMediaSequence <= waitForMediaSequence &&
      !isSequenceRollback(lastMediaSequence, waitForMediaSequence) &&
      Date.now() < deadlineAt;
    if (shouldWaitForSequence) {
      if (!refreshed) {
        const refreshedState = await refreshLiveEmbedRuntime({
          sourceUrl: input.sourceUrl,
          requestOrigin: input.internalOrigin,
          slotServerId: input.slotServer,
          timeoutMs: opTimeoutMs,
          reason: "wait_for_media_sequence",
        }).catch(() => null);
        refreshed = !!refreshedState?.ok;
      }
      await new Promise((resolve) => setTimeout(resolve, 350));
      continue;
    }

    if (!refreshed) {
      const refreshedState = await refreshLiveEmbedRuntime({
        sourceUrl: input.sourceUrl,
        requestOrigin: input.internalOrigin,
        slotServerId: input.slotServer,
        timeoutMs: opTimeoutMs,
        reason: queryOptions?.forceRefresh ? "forced_runtime_refresh" : "manifest_refresh",
      }).catch(() => null);
      refreshed = !!refreshedState?.ok;
      if (refreshed) continue;
    }

    if (queryOptions?.allowRotate !== false && !rotated) {
      const rotatedState = await rotateLiveEmbedRuntime({
        sourceUrl: input.sourceUrl,
        requestOrigin: input.internalOrigin,
        slotServerId: input.slotServer,
        timeoutMs: opTimeoutMs,
        reason: "manifest_rotate",
      }).catch(() => null);
      rotated = !!rotatedState?.ok;
      if (rotated) continue;
    }

    break;
  }

  return {
    ok: false,
    error: lastError || "embed-session-no-verified-manifest",
    playbackUrl: lastPlaybackUrl,
    currentSource: lastCurrentSource,
    mediaSequence: lastMediaSequence,
    targetDurationSec: lastTargetDurationSec,
    refreshed,
    rotated,
    adapterKind: options.adapterKind,
    candidatesFound: lastCandidatesFound,
    candidatesTried,
  };
}

export function buildSessionOwnedRuntimeAdapter(
  kind: RuntimeAdapterKind,
  matches: RuntimeAdapter["matches"],
  options: RuntimeResolutionOptions
): RuntimeAdapter {
  return {
    kind,
    matches,
    currentSource: async (input) => {
      const runtimeState = await ensureLiveEmbedSessionRuntime({
        sourceUrl: input.sourceUrl,
        requestOrigin: input.internalOrigin,
        slotServerId: input.slotServer,
        timeoutMs: DEFAULT_RESOLVE_TIMEOUT_MS,
      });
      return currentSourceFromRuntimeState(input, runtimeState, options);
    },
    currentManifest: async (input, queryOptions) => resolveRuntimeOwnedManifest(input, options, queryOptions),
    refresh: async (input, reason) => {
      const refreshed = await refreshLiveEmbedRuntime({
        sourceUrl: input.sourceUrl,
        requestOrigin: input.internalOrigin,
        slotServerId: input.slotServer,
        timeoutMs: DEFAULT_RESOLVE_TIMEOUT_MS,
        reason: String(reason || "adapter_refresh"),
      }).catch(() => null);
      return {
        ok: !!refreshed?.ok,
        adapterKind: kind,
        currentSource: String(refreshed?.state?.runtimeActiveSource || refreshed?.state?.activeManifestUrl || ""),
        playbackUrl: String(refreshed?.state?.playbackUrl || ""),
        runtimeState: refreshed?.state || null,
      };
    },
    rotate: async (input, reason) => {
      const rotatedState = await rotateLiveEmbedRuntime({
        sourceUrl: input.sourceUrl,
        requestOrigin: input.internalOrigin,
        slotServerId: input.slotServer,
        timeoutMs: DEFAULT_RESOLVE_TIMEOUT_MS,
        reason: String(reason || "adapter_rotate"),
      }).catch(() => null);
      return {
        ok: !!rotatedState?.ok,
        adapterKind: kind,
        currentSource: String(rotatedState?.state?.runtimeActiveSource || rotatedState?.state?.activeManifestUrl || ""),
        playbackUrl: String(rotatedState?.state?.playbackUrl || ""),
        runtimeState: rotatedState?.state || null,
      };
    },
    fetchAsset: (input) =>
      fetchLiveEmbedAsset({
        sourceUrl: input.sourceUrl,
        requestOrigin: input.internalOrigin,
        slotServerId: input.slotServer,
        assetUrl: input.assetUrl,
        referrerUrl: input.referrerUrl,
        timeoutMs: Math.max(8_000, Number.parseInt(String(input.timeoutMs || DEFAULT_RESOLVE_TIMEOUT_MS), 10) || DEFAULT_RESOLVE_TIMEOUT_MS),
      }),
    peek: (input) =>
      peekLiveEmbedSessionState({
        sourceUrl: input.sourceUrl,
        requestOrigin: input.internalOrigin,
        slotServerId: input.slotServer,
      }),
    peekStatus: (input) => {
      const runtimeState = peekLiveEmbedSessionState({
        sourceUrl: input.sourceUrl,
        requestOrigin: input.internalOrigin,
        slotServerId: input.slotServer,
      });
      return buildPeekStatus(runtimeState, options);
    },
  };
}
