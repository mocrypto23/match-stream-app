// app/api/matches/route.ts
import { NextResponse } from "next/server";
import { supabaseAdmin } from "../_supabase";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";
const TABLE = "match-stream-app";

type MatchApiRow = {
  id: number;
  match_key?: string | null;
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
  stream_url?: string | null;
  stream_url_2?: string | null;
  stream_url_3?: string | null;
  stream_url_4?: string | null;
  stream_url_5?: string | null;
  stream_url_6?: string | null;
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

function tryUrl(raw: unknown) {
  const s = asNonEmptyString(raw);
  if (!s) return null;
  try {
    const u = new URL(s);
    if (u.protocol !== "http:" && u.protocol !== "https:") return null;
    return u;
  } catch {
    return null;
  }
}

function isBeinMatchUrl(raw: unknown) {
  const u = tryUrl(raw);
  if (!u) return false;
  const host = u.hostname.toLowerCase();
  const path = u.pathname.toLowerCase();
  return (host === "bein-live.com" || host.endsWith(".bein-live.com")) && path.includes("/matches/");
}

function isWeakServer5GenericUrl(raw: unknown) {
  const u = tryUrl(raw);
  if (!u) return false;
  const host = u.hostname.toLowerCase();
  const path = u.pathname.toLowerCase();
  if (!host.endsWith("pyxq.online")) return false;
  return /^\/albaplayer\/(ontime\d*|bein(?:-?sport)?-?\d+|max\d+|ssc\d+|stars?|beinsports?\d+)\/?$/i.test(path);
}

function hasStrongBackup(row: MatchApiRow) {
  if (tryUrl(row.stream_url_2)) return true;
  if (tryUrl(row.stream_url_3)) return true;
  if (tryUrl(row.stream_url_4)) return true;
  if (tryUrl(row.stream_url_6)) return true;
  if (tryUrl(row.stream_url_5) && !isWeakServer5GenericUrl(row.stream_url_5)) return true;
  return false;
}

function shouldHidePrimaryOnlyWeakRow(row: MatchApiRow) {
  if (!isBeinMatchUrl(row.stream_url)) return false;
  if (hasStrongBackup(row)) return false;
  if (isWeakServer5GenericUrl(row.stream_url_5)) return true;
  if (!tryUrl(row.stream_url_5)) return true;
  return false;
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
      "id,match_key,home_team,away_team,home_logo,away_logo,match_day,match_start,match_time,home_score,away_score,status_key,stream_url,stream_url_2,stream_url_3,stream_url_4,stream_url_5,stream_url_6"
    )
    .eq("match_day", day)
    .order("match_start", { ascending: true, nullsFirst: false })
    .order("id", { ascending: true });

  if (error) {
    return NextResponse.json({ error: error.message }, { status: 500 });
  }

  const rows = (data ?? []) as MatchApiRow[];
  const filtered = rows.filter((row) => !shouldHidePrimaryOnlyWeakRow(row));
  const hydrated = await hydrateMissingLogos(filtered);
  const payload = hydrated.map((row) => ({
    id: row.id,
    match_key: row.match_key ?? null,
    home_team: row.home_team ?? null,
    away_team: row.away_team ?? null,
    home_logo: row.home_logo ?? null,
    away_logo: row.away_logo ?? null,
    match_day: row.match_day ?? null,
    match_start: row.match_start ?? null,
    match_time: row.match_time ?? null,
    home_score: row.home_score ?? null,
    away_score: row.away_score ?? null,
    status_key: row.status_key ?? null,
  }));
  const res = NextResponse.json(payload);
  res.headers.set("Cache-Control", "public, s-maxage=10, stale-while-revalidate=60");
  res.headers.set("Vary", "Accept-Encoding");
  return res;
}
