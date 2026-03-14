import { NextResponse } from "next/server";

import { livekoraProvider, resolveInternalAppOrigin } from "@/lib/live-providers";

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

export async function GET(req: Request) {
  const url = new URL(req.url);
  const sourceUrl = String(url.searchParams.get("sourceUrl") || "").trim();
  const assetUrl = String(url.searchParams.get("assetUrl") || "").trim();
  const referrerUrl = String(url.searchParams.get("referrerUrl") || "").trim();

  if (!livekoraProvider.isAllowedSource(sourceUrl)) {
    return NextResponse.json({ ok: false, error: "source-not-allowed" }, { status: 403 });
  }
  if (!isHttpUrl(assetUrl)) {
    return NextResponse.json({ ok: false, error: "invalid-asset-url" }, { status: 400 });
  }

  const fetched = await livekoraProvider.fetchAsset({
    matchId: 0,
    sourceUrl,
    internalOrigin: resolveInternalAppOrigin(req),
    assetUrl,
    referrerUrl: isHttpUrl(referrerUrl) ? referrerUrl : undefined,
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
    },
  });
}
