// app/api/match/[id]/route.ts
import { NextResponse } from "next/server";
import { supabaseAdmin } from "../../_supabase";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

function extractId(req: Request, ctx: { params?: { id?: string } }) {
  const fromParams = ctx?.params?.id;
  if (fromParams) return fromParams;

  // fallback: /api/match/123
  const pathname = new URL(req.url).pathname;
  const parts = pathname.split("/").filter(Boolean);
  return parts[parts.length - 1] || null;
}

export async function GET(req: Request, ctx: { params?: { id?: string } }) {
  const raw = extractId(req, ctx);
  const id = raw ? Number.parseInt(raw, 10) : NaN;

  if (!raw || !Number.isFinite(id) || id <= 0) {
    return NextResponse.json({ error: "Invalid id", raw }, { status: 400 });
  }

  const { data, error } = await supabaseAdmin
    .from("match-stream-app")
    .select(
      "id,home_team,away_team,stream_url,stream_url_2,stream_url_3,stream_url_4,stream_url_5,match_start,status_key"
    )
    .eq("id", id)
    .maybeSingle();

  if (error) return NextResponse.json({ error: error.message }, { status: 500 });
  if (!data) return NextResponse.json({ error: "Not found" }, { status: 404 });

  const res = NextResponse.json(data);
  res.headers.set("Cache-Control", "public, s-maxage=10, stale-while-revalidate=60");
  return res;
}
