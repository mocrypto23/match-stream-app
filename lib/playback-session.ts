import { createHash, createHmac, timingSafeEqual } from "node:crypto";
import { posix as pathPosix } from "node:path";

import { NextResponse } from "next/server";

import { buildProviderPublicPlaylistUrl } from "@/lib/live-providers";
import type { StreamProviderId, StreamSourceStatus } from "@/lib/stream-source-types";

const PLAYBACK_SESSION_SECRET =
  String(process.env.PLAYBACK_SESSION_SECRET || "").trim() || "dev-playback-session-secret-change-me";
const PLAYBACK_SESSION_TTL_MS = Math.max(
  10 * 60 * 1000,
  Number.parseInt(String(process.env.PLAYBACK_SESSION_TTL_MS || "7200000"), 10) || 7_200_000
);
const VALID_PROVIDER_IDS = new Set<StreamProviderId>(["livekora", "beinlive", "siiir", "yallashoot"]);

type PlaybackSessionClaims = {
  v: 1;
  m: number;
  p: StreamProviderId;
  exp: number;
  ua: string;
};

type PlaybackAccessState = {
  hits: number[];
  ipBuckets: Map<string, number>;
  lastSeenAt: number;
};

type PlaybackSessionIssueState = {
  hits: number[];
  lastSeenAt: number;
};

const playbackAccessBySession = new Map<string, PlaybackAccessState>();
const playbackSessionIssueByKey = new Map<string, PlaybackSessionIssueState>();
const playbackLogThrottle = new Map<string, number>();
const PLAYBACK_RATE_WINDOW_MS = 10_000;
const PLAYBACK_MAX_REQUESTS_PER_WINDOW = 600;
const PLAYBACK_IP_BUCKET_WINDOW_MS = 10 * 60 * 1000;
const PLAYBACK_MAX_IP_BUCKETS = 8;
const PLAYBACK_ACCESS_IDLE_TTL_MS = 30 * 60 * 1000;
const PLAYBACK_SESSION_WINDOW_MS = 60_000;
const PLAYBACK_MAX_SESSION_ISSUES_PER_WINDOW = 30;
const PLAYBACK_ISSUE_IDLE_TTL_MS = 15 * 60 * 1000;

function toBase64Url(input: Buffer | string) {
  return Buffer.from(input)
    .toString("base64")
    .replace(/\+/g, "-")
    .replace(/\//g, "_")
    .replace(/=+$/g, "");
}

function fromBase64Url(input: string) {
  const normalized = String(input || "")
    .replace(/-/g, "+")
    .replace(/_/g, "/");
  const padLength = normalized.length % 4 === 0 ? 0 : 4 - (normalized.length % 4);
  return Buffer.from(`${normalized}${"=".repeat(padLength)}`, "base64");
}

function signPlaybackBody(body: string) {
  return createHmac("sha256", PLAYBACK_SESSION_SECRET).update(body).digest();
}

function hashUserAgent(userAgent: string) {
  return createHash("sha1").update(String(userAgent || "").trim().toLowerCase()).digest("hex").slice(0, 16);
}

export function isValidPlaybackProvider(value: string): value is StreamProviderId {
  return VALID_PROVIDER_IDS.has(value as StreamProviderId);
}

export function parsePlaybackMatchId(matchPath: string) {
  const match = String(matchPath || "").trim().match(/^m(\d+)$/i);
  if (!match?.[1]) return null;
  const matchId = Number.parseInt(match[1], 10);
  return Number.isFinite(matchId) && matchId > 0 ? matchId : null;
}

export function buildPlaybackManifestPath(provider: StreamProviderId, matchId: number) {
  return `/play/${provider}/m${matchId}/index.m3u8`;
}

export function buildPlaybackPrefixPath(provider: StreamProviderId, matchId: number) {
  return `/play/${provider}/m${matchId}`;
}

export function buildClientPlaybackUrl(provider: StreamProviderId, matchId: number, hasPlaylistUrl: boolean) {
  if (!hasPlaylistUrl || !Number.isFinite(matchId) || matchId <= 0) return null;
  return buildPlaybackManifestPath(provider, matchId);
}

export function protectClientStatus(status: StreamSourceStatus | null | undefined) {
  if (!status) return null;
  const hasPlaylistUrl = !!String(status.playlistUrl || "").trim();
  return {
    ...status,
    playlistUrl: buildClientPlaybackUrl(status.provider, status.matchId, hasPlaylistUrl),
  } satisfies StreamSourceStatus;
}

export function createPlaybackSessionToken(input: {
  matchId: number;
  provider: StreamProviderId;
  userAgent: string;
  now?: number;
}) {
  const now = Number.isFinite(input.now) ? Number(input.now) : Date.now();
  const claims: PlaybackSessionClaims = {
    v: 1,
    m: input.matchId,
    p: input.provider,
    exp: now + PLAYBACK_SESSION_TTL_MS,
    ua: hashUserAgent(input.userAgent),
  };
  const body = toBase64Url(JSON.stringify(claims));
  const signature = toBase64Url(signPlaybackBody(body));
  return {
    token: `${body}.${signature}`,
    expiresAt: claims.exp,
  };
}

function throttlePlaybackGuardLog(kind: string, fingerprint: string, details: Record<string, unknown>) {
  const key = `${kind}:${fingerprint}`;
  const now = Date.now();
  const lastLoggedAt = playbackLogThrottle.get(key) || 0;
  if (now - lastLoggedAt < 30_000) return;
  playbackLogThrottle.set(key, now);
  console.warn("[playback-guard]", kind, details);
}

function readRequestHost(req: Request) {
  const forwardedHost = String(req.headers.get("x-forwarded-host") || "").trim().toLowerCase();
  if (forwardedHost) return forwardedHost.split(",")[0]?.trim().toLowerCase() || "";
  const hostHeader = String(req.headers.get("host") || "").trim().toLowerCase();
  if (hostHeader) return hostHeader;
  try {
    return new URL(req.url).host.toLowerCase();
  } catch {
    return "";
  }
}

function hostLooksTrusted(host: string, expectedHost: string) {
  const normalizedHost = String(host || "").trim().toLowerCase();
  const normalizedExpected = String(expectedHost || "").trim().toLowerCase();
  if (!normalizedHost || !normalizedExpected) return false;
  return normalizedHost === normalizedExpected || normalizedHost.endsWith(`.${normalizedExpected}`);
}

function extractHeaderHost(rawValue: string) {
  const value = String(rawValue || "").trim();
  if (!value) return "";
  try {
    return new URL(value).host.toLowerCase();
  } catch {
    return "";
  }
}

export function playbackSessionCookieName(provider: StreamProviderId, matchId: number) {
  return `tfps_${provider}_m${matchId}`;
}

function readCookieValue(req: Request, cookieName: string) {
  const cookieHeader = String(req.headers.get("cookie") || "");
  if (!cookieHeader) return "";
  for (const part of cookieHeader.split(";")) {
    const [rawName, ...rest] = part.split("=");
    if (String(rawName || "").trim() !== cookieName) continue;
    return decodeURIComponent(rest.join("=").trim());
  }
  return "";
}

export function verifyPlaybackSessionToken(input: {
  req: Request;
  matchId: number;
  provider: StreamProviderId;
}) {
  const cookieName = playbackSessionCookieName(input.provider, input.matchId);
  const token = readCookieValue(input.req, cookieName);
  if (!token) return { ok: false as const, reason: "missing-session-cookie" };

  const [body, signature] = token.split(".");
  if (!body || !signature) return { ok: false as const, reason: "invalid-session-token" };

  const expectedSignature = signPlaybackBody(body);
  let providedSignature: Buffer;
  try {
    providedSignature = fromBase64Url(signature);
  } catch {
    return { ok: false as const, reason: "invalid-session-signature" };
  }

  if (
    providedSignature.length !== expectedSignature.length ||
    !timingSafeEqual(providedSignature, expectedSignature)
  ) {
    return { ok: false as const, reason: "session-signature-mismatch" };
  }

  let claims: PlaybackSessionClaims;
  try {
    claims = JSON.parse(fromBase64Url(body).toString("utf8")) as PlaybackSessionClaims;
  } catch {
    return { ok: false as const, reason: "invalid-session-payload" };
  }

  if (claims?.v !== 1 || claims.p !== input.provider || claims.m !== input.matchId) {
    return { ok: false as const, reason: "session-scope-mismatch" };
  }
  if (!Number.isFinite(claims.exp) || Date.now() >= claims.exp) {
    return { ok: false as const, reason: "session-expired" };
  }
  const userAgentHash = hashUserAgent(String(input.req.headers.get("user-agent") || ""));
  if (!claims.ua || claims.ua !== userAgentHash) {
    return { ok: false as const, reason: "session-user-agent-mismatch" };
  }

  return { ok: true as const, claims };
}

function getClientIpBucket(req: Request) {
  const rawIp =
    String(req.headers.get("cf-connecting-ip") || "").trim() ||
    String(req.headers.get("x-forwarded-for") || "")
      .split(",")[0]
      .trim();
  if (!rawIp) return "ip:unknown";
  if (rawIp.includes(":")) {
    return `ip6:${rawIp.split(":").slice(0, 4).join(":")}`;
  }
  const parts = rawIp.split(".");
  if (parts.length === 4) {
    return `ip4:${parts.slice(0, 3).join(".")}`;
  }
  return `ip:${rawIp}`;
}

function cleanupPlaybackAccessState(now: number) {
  for (const [key, state] of playbackAccessBySession.entries()) {
    if (now - state.lastSeenAt > PLAYBACK_ACCESS_IDLE_TTL_MS) {
      playbackAccessBySession.delete(key);
    }
  }
}

function cleanupPlaybackSessionIssueState(now: number) {
  for (const [key, state] of playbackSessionIssueByKey.entries()) {
    if (now - state.lastSeenAt > PLAYBACK_ISSUE_IDLE_TTL_MS) {
      playbackSessionIssueByKey.delete(key);
    }
  }
}

export function guardPlaybackSessionIssueRequest(input: {
  req: Request;
  provider: StreamProviderId;
  matchId: number;
}) {
  const now = Date.now();
  cleanupPlaybackSessionIssueState(now);
  const issueKey = `${input.provider}:${input.matchId}:${getClientIpBucket(input.req)}`;
  const issueState =
    playbackSessionIssueByKey.get(issueKey) ||
    ({
      hits: [],
      lastSeenAt: now,
    } satisfies PlaybackSessionIssueState);
  issueState.lastSeenAt = now;
  issueState.hits = issueState.hits.filter((value) => now - value <= PLAYBACK_SESSION_WINDOW_MS);
  issueState.hits.push(now);
  playbackSessionIssueByKey.set(issueKey, issueState);
  if (issueState.hits.length > PLAYBACK_MAX_SESSION_ISSUES_PER_WINDOW) {
    throttlePlaybackGuardLog("session-rate-limit", issueKey, {
      provider: input.provider,
      matchId: input.matchId,
      hits: issueState.hits.length,
    });
    return { ok: false as const, reason: "playback-session-rate-limit" };
  }
  return { ok: true as const };
}

export function guardPlaybackAssetRequest(input: {
  req: Request;
  provider: StreamProviderId;
  matchId: number;
  claims: PlaybackSessionClaims;
  assetPath: string;
}) {
  const now = Date.now();
  cleanupPlaybackAccessState(now);
  const sessionKey = `${input.provider}:${input.matchId}:${input.claims.ua}:${input.claims.exp}`;
  const accessState =
    playbackAccessBySession.get(sessionKey) ||
    ({
      hits: [],
      ipBuckets: new Map<string, number>(),
      lastSeenAt: now,
    } satisfies PlaybackAccessState);
  accessState.lastSeenAt = now;
  accessState.hits = accessState.hits.filter((value) => now - value <= PLAYBACK_RATE_WINDOW_MS);
  accessState.hits.push(now);
  if (accessState.hits.length > PLAYBACK_MAX_REQUESTS_PER_WINDOW) {
    throttlePlaybackGuardLog("rate-limit", sessionKey, {
      provider: input.provider,
      matchId: input.matchId,
      assetPath: input.assetPath,
      hits: accessState.hits.length,
    });
    playbackAccessBySession.set(sessionKey, accessState);
    return { ok: false as const, reason: "playback-rate-limit" };
  }

  const ipBucket = getClientIpBucket(input.req);
  for (const [bucket, seenAt] of accessState.ipBuckets.entries()) {
    if (now - seenAt > PLAYBACK_IP_BUCKET_WINDOW_MS) {
      accessState.ipBuckets.delete(bucket);
    }
  }
  accessState.ipBuckets.set(ipBucket, now);
  if (accessState.ipBuckets.size > PLAYBACK_MAX_IP_BUCKETS) {
    throttlePlaybackGuardLog("ip-bucket-limit", sessionKey, {
      provider: input.provider,
      matchId: input.matchId,
      assetPath: input.assetPath,
      ipBuckets: accessState.ipBuckets.size,
    });
    playbackAccessBySession.set(sessionKey, accessState);
    return { ok: false as const, reason: "playback-ip-bucket-limit" };
  }

  playbackAccessBySession.set(sessionKey, accessState);
  return { ok: true as const };
}

export function observePlaybackGatewayRequest(input: {
  req: Request;
  provider: StreamProviderId;
  matchId: number;
  assetPath: string;
  reason?: string | null;
}) {
  const expectedHost = readRequestHost(input.req);
  const originHost = extractHeaderHost(String(input.req.headers.get("origin") || ""));
  const refererHost = extractHeaderHost(String(input.req.headers.get("referer") || ""));
  const secFetchSite = String(input.req.headers.get("sec-fetch-site") || "").trim().toLowerCase();
  if (!input.reason && secFetchSite === "same-origin") return;
  const suspicious =
    (!!originHost && !hostLooksTrusted(originHost, expectedHost)) ||
    (!!refererHost && !hostLooksTrusted(refererHost, expectedHost)) ||
    secFetchSite === "cross-site";
  if (!suspicious && !input.reason) return;
  const fingerprint = `${input.provider}:${input.matchId}:${input.assetPath}:${originHost || refererHost || secFetchSite || "unknown"}`;
  throttlePlaybackGuardLog("gateway-observe", fingerprint, {
    provider: input.provider,
    matchId: input.matchId,
    assetPath: input.assetPath,
    reason: input.reason || null,
    originHost: originHost || null,
    refererHost: refererHost || null,
    secFetchSite: secFetchSite || null,
  });
}

export function attachPlaybackSessionCookie(
  response: NextResponse,
  input: {
    matchId: number;
    provider: StreamProviderId;
    token: string;
    expiresAt: number;
  }
) {
  response.cookies.set({
    name: playbackSessionCookieName(input.provider, input.matchId),
    value: input.token,
    httpOnly: true,
    secure: true,
    sameSite: "lax",
    path: buildPlaybackPrefixPath(input.provider, input.matchId),
    expires: new Date(input.expiresAt),
  });
  return response;
}

function resolveManifestUrl(raw: string, baseUrl: string) {
  try {
    return new URL(String(raw || "").trim(), baseUrl).toString();
  } catch {
    return String(raw || "").trim();
  }
}

function buildGatewayRelativeAssetReference(raw: string, baseUrl: string) {
  const value = String(raw || "").trim();
  if (!value) return value;
  if (/^(data:|skd:|urn:)/i.test(value)) return value;

  let absolute: URL;
  try {
    absolute = new URL(value, baseUrl);
  } catch {
    return value;
  }

  let base: URL;
  try {
    base = new URL(baseUrl);
  } catch {
    return value;
  }

  const baseDir = pathPosix.dirname(base.pathname || "/");
  const targetPath = absolute.pathname || "/";
  let relativePath = pathPosix.relative(baseDir, targetPath).replace(/\\/g, "/");
  if (!relativePath || relativePath === ".") {
    relativePath = pathPosix.basename(targetPath) || value;
  }
  if (absolute.search) relativePath += absolute.search;
  if (absolute.hash) relativePath += absolute.hash;
  return relativePath;
}

function isManifestReference(raw: string, baseUrl: string) {
  const value = String(raw || "").trim();
  if (!value) return false;
  const absoluteUrl = resolveManifestUrl(value, baseUrl);
  try {
    return new URL(absoluteUrl).pathname.toLowerCase().endsWith(".m3u8");
  } catch {
    return /\.m3u8(?:$|[?#])/i.test(value);
  }
}

function rewriteManifestReference(raw: string, baseUrl: string) {
  if (isManifestReference(raw, baseUrl)) {
    return buildGatewayRelativeAssetReference(raw, baseUrl);
  }
  return resolveManifestUrl(raw, baseUrl);
}

export function rewriteManifestForPlaybackGateway(manifestText: string, upstreamManifestUrl: string) {
  const out = String(manifestText || "")
    .split(/\r?\n/)
    .map((line) => {
      const trimmed = String(line || "").trim();
      if (!trimmed) return line;
      if (trimmed.startsWith("#")) {
        return line.replace(/URI="([^"]+)"/gi, (_match, rawUri) => `URI="${rewriteManifestReference(rawUri, upstreamManifestUrl)}"`);
      }
      return rewriteManifestReference(trimmed, upstreamManifestUrl);
    })
    .join("\n");
  return out;
}

export function buildUpstreamPlaybackManifestUrl(provider: StreamProviderId, matchId: number) {
  return buildProviderPublicPlaylistUrl(provider, matchId);
}
