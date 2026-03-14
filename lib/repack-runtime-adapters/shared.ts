import { extractLiveEmbedSessionSnapshot, fetchLiveEmbedText } from "@/lib/repack-embed-session";
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

type SessionCandidate = {
  fetchUrl?: string;
  targetUrl: string;
  referrerUrl: string;
  manifestBody?: string;
  manifestBaseUrl?: string;
  score?: number;
  via?: "network-manifest" | "network-request" | "dom";
  seenAt: number;
};

type RuntimeResolutionOptions = {
  adapterKind: RuntimeAdapterKind;
  candidateMaxAgeMs: number;
  maxCandidatesToTry: number;
  forceFreshManifest?: boolean;
  preferUrlIncludes?: string[];
  preferReferrerIncludes?: string[];
  preferManifestIncludes?: string[];
};

type ActiveRuntimeHint = {
  targetUrl: string;
  fetchUrl?: string;
  referrerUrl: string;
  updatedAt: number;
};

export type RuntimeAdapterKind = "playerv2" | "bein" | "alba" | "default";

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
      referrerUrl: string;
      playbackUrl: string;
      adapterKind: RuntimeAdapterKind;
      candidatesFound: number;
      candidatesTried: number;
      sessionOwned: true;
    }
  | {
      ok: false;
      error: string;
      playbackUrl: string;
      adapterKind: RuntimeAdapterKind;
      candidatesFound: number;
      candidatesTried: number;
    };

export type RuntimeAdapter = {
  kind: RuntimeAdapterKind;
  matches: (input: RuntimeAdapterInput) => boolean;
  resolve: (input: RuntimeAdapterInput) => Promise<RuntimeManifestResult>;
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
  let score = 0;
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

function buildCandidateQueue(input: RuntimeAdapterInput, snapshotCandidates: SessionCandidate[], options: RuntimeResolutionOptions) {
  const now = Date.now();
  const hint = readActiveHint(input);
  const queue = new Map<string, SessionCandidate>();
  if (hint) {
    const hinted = buildHintCandidate(hint);
    queue.set(`${hinted.targetUrl}|${String(hinted.fetchUrl || "")}`, hinted);
  }

  for (const candidate of snapshotCandidates) {
    const key = `${String(candidate.targetUrl || "").trim()}|${String(candidate.fetchUrl || "").trim()}`;
    if (!key || queue.has(key)) continue;
    queue.set(key, candidate);
  }

  return Array.from(queue.values())
    .filter((candidate) => {
      const ageMs = Math.max(0, now - Number(candidate.seenAt || 0));
      return ageMs <= options.candidateMaxAgeMs || (!!hint && candidate.targetUrl === hint.targetUrl);
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

export async function resolveSessionBackedManifest(
  input: RuntimeAdapterInput,
  options: RuntimeResolutionOptions
): Promise<RuntimeManifestResult> {
  const snapshot = await extractLiveEmbedSessionSnapshot({
    sourceUrl: input.sourceUrl,
    requestOrigin: input.internalOrigin,
    slotServerId: input.slotServer,
    timeoutMs: DEFAULT_RESOLVE_TIMEOUT_MS,
  });
  const playbackUrl = String(snapshot.playbackUrl || "").trim();
  const rawCandidates = Array.isArray(snapshot.candidates) ? (snapshot.candidates as SessionCandidate[]) : [];
  const candidates = buildCandidateQueue(input, rawCandidates, options);
  if (!candidates.length) {
    return {
      ok: false,
      error: snapshot.error || "embed-session-empty",
      playbackUrl,
      adapterKind: options.adapterKind,
      candidatesFound: 0,
      candidatesTried: 0,
    };
  }

  let candidatesTried = 0;
  let lastError = snapshot.error || "embed-session-empty";
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
      manifestBody: options.forceFreshManifest ? undefined : candidate.manifestBody,
      manifestSeenAt: Number(candidate.seenAt || 0),
    });
    if (!resolved.ok) {
      lastError = resolved.error || lastError;
      continue;
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
      referrerUrl,
      playbackUrl,
      adapterKind: options.adapterKind,
      candidatesFound: candidates.length,
      candidatesTried,
      sessionOwned: true,
    };
  }

  return {
    ok: false,
    error: lastError || "embed-session-no-verified-manifest",
    playbackUrl,
    adapterKind: options.adapterKind,
    candidatesFound: candidates.length,
    candidatesTried,
  };
}
