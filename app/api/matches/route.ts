// app/api/matches/route.ts
import { NextResponse } from "next/server";
import { supabaseAdmin } from "../_supabase";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function GET(req: Request) {
  const { searchParams } = new URL(req.url);
  const day = searchParams.get("day");

  if (!day || !/^\d{4}-\d{2}-\d{2}$/.test(day)) {
    return NextResponse.json({ error: "Invalid day" }, { status: 400 });
  }

  const { data, error } = await supabaseAdmin
    .from("match-stream-app")
    .select(
      "id,home_team,away_team,home_logo,away_logo,match_day,match_start,match_time,home_score,away_score,status_key"
    )
    .eq("match_day", day)
    .order("match_start", { ascending: true, nullsFirst: false })
    .order("id", { ascending: true });

  if (error) {
    return NextResponse.json({ error: error.message }, { status: 500 });
  }

  const res = NextResponse.json(data ?? []);
  res.headers.set("Cache-Control", "public, s-maxage=10, stale-while-revalidate=60");
  res.headers.set("Vary", "Accept-Encoding");
  return res;
}