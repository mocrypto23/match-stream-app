import { NextResponse } from "next/server";

import { resolveInternalPlayerOrigin } from "@/lib/repack-ingest-gateway";
import { pickRuntimeAdapter } from "@/lib/repack-runtime-adapters";
import { isAllowedSourceForSlotServer, isValidHttpUrl, type SlotServerId } from "@/lib/server-source-policy";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

const DEFAULT_SESSION_ASSET_TIMEOUT_MS = Math.max(
  8_000,
  Number.parseInt(String(process.env.REPACK_SESSION_ASSET_TIMEOUT_MS || "22000"), 10) || 22_000
);

function toSlotServerId(raw: string | null): SlotServerId | null {
  const value = Number.parseInt(String(raw || "").trim(), 10);
  if (value === 1 || value === 2 || value === 3 || value === 4) return value;
  return null;
}

export async function GET(req: Request) {
  const url = new URL(req.url);
  const sourceUrl = String(url.searchParams.get("sourceUrl") || "").trim();
  const assetUrl = String(url.searchParams.get("assetUrl") || "").trim();
  const referrerUrl = String(url.searchParams.get("referrerUrl") || "").trim();
  const slotServer = toSlotServerId(url.searchParams.get("slotServer"));
  if (!slotServer) {
    return NextResponse.json({ ok: false, error: "invalid-slot-server" }, { status: 400 });
  }
  if (!isValidHttpUrl(sourceUrl)) {
    return NextResponse.json({ ok: false, error: "invalid-source-url" }, { status: 400 });
  }
  if (!isAllowedSourceForSlotServer(slotServer, sourceUrl)) {
    return NextResponse.json({ ok: false, error: "source-not-allowed" }, { status: 403 });
  }
  if (!isValidHttpUrl(assetUrl)) {
    return NextResponse.json({ ok: false, error: "invalid-asset-url" }, { status: 400 });
  }

  const internalOrigin = resolveInternalPlayerOrigin(req);
  const adapter = pickRuntimeAdapter({
    sourceUrl,
    slotServer,
    internalOrigin,
  });
  const fetched = await adapter.fetchAsset({
    sourceUrl,
    slotServer,
    internalOrigin,
    assetUrl,
    referrerUrl: isValidHttpUrl(referrerUrl) ? referrerUrl : undefined,
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
      "x-repack-session-asset": "1",
    },
  });
}
