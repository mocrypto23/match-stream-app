import { NextResponse } from "next/server";

import { fetchLivekoraMatchRow } from "@/lib/livekora-match";
import { resolveInternalAppOrigin } from "@/lib/live-providers";
import { buildSiiirStatus, bootstrapSiiirAgent } from "@/lib/siiir-agent";
import { buildSiiirSessionManifestUrl, siiirProvider } from "@/lib/siiir-provider";
import { resolveProviderSourceUrl } from "@/lib/stream-provider-registry";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function POST(req: Request) {
  const body = (await req.json().catch(() => null)) as { matchId?: number } | null;
  const matchId = Number.parseInt(String(body?.matchId ?? "").trim(), 10);
  if (!Number.isFinite(matchId) || matchId <= 0) {
    return NextResponse.json({ accepted: false, error: "invalid-match-id" }, { status: 400 });
  }

  const { data, error } = await fetchLivekoraMatchRow(matchId);
  if (error) {
    return NextResponse.json({ accepted: false, error: String(error.message || "db-error") }, { status: 500 });
  }
  if (!data) {
    return NextResponse.json({ accepted: false, error: "match-not-found" }, { status: 404 });
  }

  const sourceUrl = await resolveProviderSourceUrl(siiirProvider, data);
  if (!sourceUrl) {
    const siiirStatus = await buildSiiirStatus({ matchId, row: data, sourceUrl: null });
    return NextResponse.json({ accepted: false, siiirStatus }, { status: 409 });
  }

  const internalOrigin = resolveInternalAppOrigin(req);
  const ingestUrl = buildSiiirSessionManifestUrl(matchId, internalOrigin);
  const bootstrapped = await bootstrapSiiirAgent({
    matchId,
    sourceUrl,
    ingestUrl,
  });

  const siiirStatus = await buildSiiirStatus({
    matchId,
    row: data,
    sourceUrl,
  });
  return NextResponse.json(
    {
      accepted: bootstrapped.accepted,
      reason: bootstrapped.reason,
      siiirStatus,
    },
    { status: bootstrapped.ok ? 200 : 502, headers: { "Cache-Control": "no-store" } }
  );
}
