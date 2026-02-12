// app/api/matches/route.ts
import { NextResponse } from "next/server";
import { supabaseAdmin } from "../_supabase";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";
const TABLE = "match-stream-app";

type MatchApiRow = {
  id: number;
  home_team?: string | null;
  away_team?: string | null;
  home_logo?: string | null;
  away_logo?: string | null;
  match_day?: string | null;
  match_start?: string | null;
  match_time?: string | null;
  home_score?: number | null;
  away_score?: number | null;
  status_key?: string | null;
};

type HomeLogoLookupRow = {
  id: number;
  match_day?: string | null;
  home_team?: string | null;
  home_logo?: string | null;
};

type AwayLogoLookupRow = {
  id: number;
  match_day?: string | null;
  away_team?: string | null;
  away_logo?: string | null;
};

function asNonEmptyString(raw: unknown) {
  return typeof raw === "string" ? raw.trim() : "";
}

async function hydrateMissingLogos(rows: MatchApiRow[]) {
  if (!rows.length) return rows;

  const missingTeams = new Set<string>();
  for (const row of rows) {
    const homeTeam = asNonEmptyString(row.home_team);
    const awayTeam = asNonEmptyString(row.away_team);
    const homeLogo = asNonEmptyString(row.home_logo);
    const awayLogo = asNonEmptyString(row.away_logo);

    if (!homeLogo && homeTeam) missingTeams.add(homeTeam);
    if (!awayLogo && awayTeam) missingTeams.add(awayTeam);
  }

  const teams = Array.from(missingTeams);
  if (!teams.length) return rows;

  const [homeRes, awayRes] = await Promise.all([
    supabaseAdmin
      .from(TABLE)
      .select("id,match_day,home_team,home_logo")
      .in("home_team", teams)
      .not("home_logo", "is", null)
      .order("match_day", { ascending: false, nullsFirst: false })
      .order("id", { ascending: false }),
    supabaseAdmin
      .from(TABLE)
      .select("id,match_day,away_team,away_logo")
      .in("away_team", teams)
      .not("away_logo", "is", null)
      .order("match_day", { ascending: false, nullsFirst: false })
      .order("id", { ascending: false }),
  ]);

  if (homeRes.error || awayRes.error) return rows;

  const logoByTeam = new Map<string, string>();
  for (const row of (homeRes.data ?? []) as HomeLogoLookupRow[]) {
    const team = asNonEmptyString(row.home_team);
    const logo = asNonEmptyString(row.home_logo);
    if (team && logo && !logoByTeam.has(team)) logoByTeam.set(team, logo);
  }
  for (const row of (awayRes.data ?? []) as AwayLogoLookupRow[]) {
    const team = asNonEmptyString(row.away_team);
    const logo = asNonEmptyString(row.away_logo);
    if (team && logo && !logoByTeam.has(team)) logoByTeam.set(team, logo);
  }

  return rows.map((row) => {
    const homeTeam = asNonEmptyString(row.home_team);
    const awayTeam = asNonEmptyString(row.away_team);
    const homeLogo = asNonEmptyString(row.home_logo) || logoByTeam.get(homeTeam) || null;
    const awayLogo = asNonEmptyString(row.away_logo) || logoByTeam.get(awayTeam) || null;
    return { ...row, home_logo: homeLogo, away_logo: awayLogo };
  });
}

export async function GET(req: Request) {
  const { searchParams } = new URL(req.url);
  const day = searchParams.get("day");

  if (!day || !/^\d{4}-\d{2}-\d{2}$/.test(day)) {
    return NextResponse.json({ error: "Invalid day" }, { status: 400 });
  }

  const { data, error } = await supabaseAdmin
    .from(TABLE)
    .select(
      "id,home_team,away_team,home_logo,away_logo,match_day,match_start,match_time,home_score,away_score,status_key"
    )
    .eq("match_day", day)
    .order("match_start", { ascending: true, nullsFirst: false })
    .order("id", { ascending: true });

  if (error) {
    return NextResponse.json({ error: error.message }, { status: 500 });
  }

  const hydrated = await hydrateMissingLogos((data ?? []) as MatchApiRow[]);
  const res = NextResponse.json(hydrated);
  res.headers.set("Cache-Control", "public, s-maxage=10, stale-while-revalidate=60");
  res.headers.set("Vary", "Accept-Encoding");
  return res;
}
