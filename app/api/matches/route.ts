import { NextResponse } from "next/server";

import { MATCHES_CACHE_TTL_SECONDS, readMatchesForDay } from "@/lib/home-matches";

export const runtime = "nodejs";

export async function GET(req: Request) {
  const { searchParams } = new URL(req.url);
  const day = searchParams.get("day");

  if (!day || !/^\d{4}-\d{2}-\d{2}$/.test(day)) {
    return NextResponse.json({ error: "Invalid day" }, { status: 400 });
  }

  try {
    const normalized = await readMatchesForDay(day);
    const res = NextResponse.json(normalized);
    res.headers.set(
      "Cache-Control",
      `public, s-maxage=${MATCHES_CACHE_TTL_SECONDS}, stale-while-revalidate=120`
    );
    res.headers.set("X-Matches-Cache-TTL", String(MATCHES_CACHE_TTL_SECONDS));
    res.headers.set("Vary", "Accept-Encoding");
    return res;
  } catch (error) {
    const message = error instanceof Error ? error.message : "Failed to load matches";
    return NextResponse.json({ error: message }, { status: 500 });
  }
}
