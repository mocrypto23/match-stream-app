import { NextResponse } from "next/server";

import { beinliveProvider } from "@/lib/beinlive-provider";
import { livekoraProvider, resolveInternalAppOrigin } from "@/lib/live-providers";
import { siiirProvider } from "@/lib/siiir-provider";
import { yallashootProvider } from "@/lib/yallashoot-provider";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

const DEFAULT_SESSION_ASSET_TIMEOUT_MS = Math.max(
  8_000,
  Number.parseInt(String(process.env.LIVEKORA_SESSION_ASSET_TIMEOUT_MS || "22000"), 10) || 22_000
);

function isHttpUrl(raw: string) {
  try {
    const parsed = new URL(String(raw || "").trim());
    return parsed.protocol === "http:" || parsed.protocol === "https:";
  } catch {
    return false;
  }
}

function decodeRequestHeadersToken(raw: string) {
  const value = String(raw || "").trim();
  if (!value) return null;
  try {
    const text = Buffer.from(value, "base64url").toString("utf8");
    const parsed = JSON.parse(text);
    if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) return null;
    const out: Record<string, string> = {};
    for (const [key, val] of Object.entries(parsed)) {
      const normalizedKey = String(key || "").trim().toLowerCase();
      const normalizedValue = String(val || "").trim();
      if (!normalizedKey || !normalizedValue) continue;
      out[normalizedKey] = normalizedValue;
    }
    return Object.keys(out).length ? out : null;
  } catch {
    return null;
  }
}

export async function GET(req: Request) {
  const url = new URL(req.url);
  const providerId = String(url.searchParams.get("provider") || "").trim().toLowerCase();
  const slotServer = Number.parseInt(String(url.searchParams.get("slotServer") || "").trim(), 10);
  const sourceUrl = String(url.searchParams.get("sourceUrl") || "").trim();
  const assetUrl = String(url.searchParams.get("assetUrl") || "").trim();
  const referrerUrl = String(url.searchParams.get("referrerUrl") || "").trim();
  const requestHeaders = decodeRequestHeadersToken(String(url.searchParams.get("requestHeaders") || "").trim());
  const provider =
    providerId === "yallashoot" || slotServer === 5 || yallashootProvider.isAllowedSource(sourceUrl)
      ? yallashootProvider
      : providerId === "siiir" || slotServer === 2 || siiirProvider.isAllowedSource(sourceUrl)
      ? siiirProvider
      : providerId === "beinlive" || slotServer === 1 || beinliveProvider.isAllowedSource(sourceUrl)
      ? beinliveProvider
      : livekoraProvider;

  if (!provider.isAllowedSource(sourceUrl)) {
    return NextResponse.json({ ok: false, error: "source-not-allowed" }, { status: 403 });
  }
  if (!isHttpUrl(assetUrl)) {
    return NextResponse.json({ ok: false, error: "invalid-asset-url" }, { status: 400 });
  }

  const fetched = await provider.fetchAsset({
    matchId: 0,
    sourceUrl,
    internalOrigin: resolveInternalAppOrigin(req),
    assetUrl,
    referrerUrl: isHttpUrl(referrerUrl) ? referrerUrl : undefined,
    requestHeaders,
    timeoutMs: DEFAULT_SESSION_ASSET_TIMEOUT_MS,
  });

  if (!fetched.ok || !String(fetched.bodyBase64 || "").trim()) {
    return NextResponse.json(
      {
        ok: false,
        error: fetched.error || "session-asset-fetch-failed",
        status: fetched.status || 0,
      },
      { status: fetched.status > 0 ? fetched.status : 502 }
    );
  }

  return new Response(Buffer.from(fetched.bodyBase64, "base64"), {
    status: 200,
    headers: {
      "content-type": String(fetched.contentType || "application/octet-stream").trim() || "application/octet-stream",
      "cache-control": "no-store, no-cache, must-revalidate, max-age=0",
      "x-livekora-session-asset": "1",
      "x-r2-session-asset": "1",
    },
  });
}
