import { NextResponse } from "next/server";

import { resolveInternalPlayerOrigin, toAbsoluteInternalUrl } from "@/lib/repack-ingest-gateway";
import { fetchPlayerv2AssetThroughBrowser } from "@/lib/repack-playerv2-browser";
import { isValidHttpUrl } from "@/lib/server-source-policy";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

const DEFAULT_BROWSER_ASSET_TIMEOUT_MS = Math.max(
  8_000,
  Number.parseInt(String(process.env.REPACK_BROWSER_ASSET_TIMEOUT_MS || "22000"), 10) || 22_000
);

export async function GET(req: Request) {
  const url = new URL(req.url);
  const sourceUrl = String(url.searchParams.get("sourceUrl") || "").trim();
  const assetUrl = String(url.searchParams.get("assetUrl") || "").trim();
  if (!isValidHttpUrl(sourceUrl)) {
    return NextResponse.json({ ok: false, error: "invalid-source-url" }, { status: 400 });
  }
  if (!assetUrl) {
    return NextResponse.json({ ok: false, error: "missing-asset-url" }, { status: 400 });
  }

  const internalOrigin = resolveInternalPlayerOrigin(req);
  const absoluteAssetUrl = toAbsoluteInternalUrl(assetUrl, internalOrigin);
  if (!isValidHttpUrl(absoluteAssetUrl)) {
    return NextResponse.json({ ok: false, error: "invalid-asset-url" }, { status: 400 });
  }

  const fetched = await fetchPlayerv2AssetThroughBrowser({
    sourceUrl,
    requestOrigin: internalOrigin,
    assetUrl: absoluteAssetUrl,
    timeoutMs: DEFAULT_BROWSER_ASSET_TIMEOUT_MS,
  });
  if (!fetched.ok || !String(fetched.bodyBase64 || "").trim()) {
    return NextResponse.json(
      {
        ok: false,
        error: fetched.error || "browser-asset-fetch-failed",
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
      "x-repack-browser-asset": "1",
    },
  });
}
