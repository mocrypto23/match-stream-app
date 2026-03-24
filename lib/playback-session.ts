import { createHash, createHmac, timingSafeEqual } from "node:crypto";

import { NextResponse } from "next/server";

import { buildProviderPublicPlaylistUrl } from "@/lib/live-providers";
import type { StreamProviderId, StreamSourceStatus } from "@/lib/stream-source-types";

const PLAYBACK_SESSION_SECRET =
  String(process.env.PLAYBACK_SESSION_SECRET || "").trim() || "dev-playback-session-secret-change-me";
const PLAYBACK_SESSION_TTL_MS = Math.max(
  10 * 60 * 1000,
  Number.parseInt(String(process.env.PLAYBACK_SESSION_TTL_MS || "7200000"), 10) || 7_200_000
);
const VALID_PROVIDER_IDS = new Set<StreamProviderId>(["livekora", "beinlive", "siiir"]);

type PlaybackSessionClaims = {
  v: 1;
  m: number;
  p: StreamProviderId;
  exp: number;
  ua: string;
};

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

export function rewriteManifestForPlaybackGateway(manifestText: string, upstreamManifestUrl: string) {
  const out = String(manifestText || "")
    .split(/\r?\n/)
    .map((line) => {
      const trimmed = String(line || "").trim();
      if (!trimmed) return line;
      if (trimmed.startsWith("#")) {
        return line.replace(/URI="([^"]+)"/gi, (_match, rawUri) => `URI="${resolveManifestUrl(rawUri, upstreamManifestUrl)}"`);
      }
      return resolveManifestUrl(trimmed, upstreamManifestUrl);
    })
    .join("\n");
  return out;
}

export function buildUpstreamPlaybackManifestUrl(provider: StreamProviderId, matchId: number) {
  return buildProviderPublicPlaylistUrl(provider, matchId);
}

