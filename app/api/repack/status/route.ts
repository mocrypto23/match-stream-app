import { NextResponse } from "next/server";
import { supabaseAdmin } from "../../_supabase";
import { getRuntimeRepackFlags } from "@/lib/repack-flags";
import { buildMatchR2Status } from "@/lib/r2-status";
import { listRepackSeedRuntimeStateForMatch } from "@/lib/repack-runtime-state";
import { getServerStreamMode } from "@/lib/stream-mode";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

type MatchStatusRow = {
  id: number;
  match_start?: string | null;
  status_key?: string | null;
  stream_url?: string | null;
  stream_url_2?: string | null;
  stream_url_3?: string | null;
  stream_url_4?: string | null;
};

function toInt(raw: unknown) {
  const value = Number.parseInt(String(raw ?? ""), 10);
  return Number.isFinite(value) ? value : NaN;
}

async function fetchMatchStatusRow(matchId: number) {
  const { data, error } = await supabaseAdmin
    .from("match-stream-app")
    .select("id,match_start,status_key,stream_url,stream_url_2,stream_url_3,stream_url_4")
    .eq("id", matchId)
    .maybeSingle();
  return {
    data: (data || null) as MatchStatusRow | null,
    error: (error || null) as { message?: string } | null,
  };
}

export async function GET(req: Request) {
  const url = new URL(req.url);
  const matchId = toInt(url.searchParams.get("matchId"));
  if (!Number.isFinite(matchId) || matchId <= 0) {
    return NextResponse.json({ ok: false, error: "invalid-match-id" }, { status: 400 });
  }

  const { data: row, error } = await fetchMatchStatusRow(matchId);
  if (error) return NextResponse.json({ ok: false, error: String(error.message || "db-error") }, { status: 500 });
  if (!row) return NextResponse.json({ ok: false, error: "match-not-found" }, { status: 404 });

  const mode = getServerStreamMode();
  const repackFlags = getRuntimeRepackFlags();
  const r2Status = await buildMatchR2Status({
    mode,
    matchId,
    row,
    repackBaseUrl: repackFlags.publicBaseUrl,
  });

  return NextResponse.json({
    ok: true,
    mode,
    matchId,
    r2Status,
    seedRuntime: listRepackSeedRuntimeStateForMatch(matchId),
  });
}
