import type { SlotServerId } from "./server-source-policy";
import { isValidHttpUrl } from "./server-source-policy";

export function resolveInternalPlayerOrigin(req?: Request | null) {
  const configuredInternal = String(
    process.env.REPACK_INTERNAL_PLAYER_ORIGIN || process.env.INTERNAL_APP_ORIGIN || ""
  ).trim();
  if (configuredInternal && isValidHttpUrl(configuredInternal)) return configuredInternal.replace(/\/+$/, "");

  const appPort = Number.parseInt(String(process.env.PORT || "3000"), 10) || 3000;
  const localhostOrigin = `http://127.0.0.1:${appPort}`;
  if (isValidHttpUrl(localhostOrigin)) return localhostOrigin;

  const configuredPublic = String(process.env.REPACK_PLAYER_ORIGIN || "").trim();
  if (configuredPublic && isValidHttpUrl(configuredPublic)) return configuredPublic.replace(/\/+$/, "");

  try {
    const reqOrigin = new URL(String(req?.url || "")).origin;
    if (isValidHttpUrl(reqOrigin)) return reqOrigin.replace(/\/+$/, "");
  } catch {}

  return localhostOrigin;
}

export function toAbsoluteInternalUrl(rawUrl: string, internalOrigin: string) {
  const value = String(rawUrl || "").trim();
  if (!value) return "";
  if (/^https?:\/\//i.test(value)) return value;
  if (value.startsWith("/")) {
    const base = resolveInternalPlayerOrigin();
    return `${base}${value}`;
  }
  try {
    return new URL(value, internalOrigin).toString();
  } catch {
    return "";
  }
}

export function buildRepackGatewayManifestUrl(input: {
  matchId: number;
  slotServer: SlotServerId;
  internalOrigin?: string;
}) {
  const origin = (input.internalOrigin || resolveInternalPlayerOrigin()).replace(/\/+$/, "");
  return `${origin}/api/repack/session-manifest?matchId=${encodeURIComponent(String(input.matchId))}&slotServer=${encodeURIComponent(String(input.slotServer))}`;
}
