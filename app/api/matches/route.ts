// app/api/matches/route.ts
import { NextResponse } from "next/server";
import { unstable_cache } from "next/cache";
import { supabaseAdmin } from "../_supabase";

export const runtime = "nodejs";
const TABLE = "match-stream-app";
const MATCHES_CACHE_TTL_SECONDS = Math.max(
  60,
  Number.parseInt(process.env.MATCHES_CACHE_TTL_SECONDS ?? "1200", 10) || 1200
);

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
const DUPLICATE_MATCH_START_WINDOW_MS = 6 * 60 * 60 * 1000;

function asNonEmptyString(raw: unknown) {
  return typeof raw === "string" ? raw.trim() : "";
}

function sanitizeMatchTimeForClient(raw: unknown) {
  const value = asNonEmptyString(raw);
  if (!value) return null as string | null;

  const normalized = value
    .replace(/â€”|â€“|â€"|â€|â€˜|â€™/g, "—")
    .replace(/[‐‑‒–—―]+/g, "—")
    .replace(/\s+/g, " ")
    .trim();
  if (!normalized) return null;

  if (/^[-—]+$/.test(normalized.replace(/\s+/g, ""))) return "—";
  return normalized;
}

function normalizeTeamNameForCompare(value: unknown) {
  return String(value || "")
    .toLowerCase()
    .replace(/[\u064b-\u065f\u0670\u0610-\u061a]/g, "")
    .replace(/[\u0623\u0625\u0622]/g, "\u0627")
    .replace(/\u0649/g, "\u064a")
    .replace(/\u0624/g, "\u0648")
    .replace(/\u0626/g, "\u064a")
    .replace(/\u0629/g, "\u0647")
    .replace(/[^a-z0-9\u0600-\u06ff]+/g, "");
}

function normalizeTeamAliasForCompare(value: unknown, opts?: { stripGeo?: boolean }) {
  let s = normalizeTeamNameForCompare(value);
  if (!s) return "";
  s = s
    .replace(/^(?:\u0646\u0627\u062f\u064a|\u0641\u0631\u064a\u0642|\u0627\u0644\u0634\u0628\u0627\u0628|\u0633\u064a\u062f\u0627\u062a|\u0627\u0644\u0631\u064a\u0627\u0636\u064a|\u0627\u0644\u0631\u064a\u0627\u0636\u064a\u0647|\u0645\u0646\u062a\u062e\u0628)/, "")
    .replace(/(?:club|fc|sc|u\d{1,2}|women|youth)$/g, "");
  if (opts?.stripGeo) {
    s = s.replace(
      /(?:\u0627\u0644\u0633\u0639\u0648\u062f\u064a|\u0627\u0644\u0645\u0635\u0631\u064a|\u0627\u0644\u0627\u0645\u0627\u0631\u0627\u062a\u064a|\u0627\u0644\u0625\u0645\u0627\u0631\u0627\u062a\u064a|\u0627\u0644\u0645\u063a\u0631\u0628\u064a|\u0627\u0644\u062c\u0632\u0627\u0626\u0631\u064a|\u0627\u0644\u0642\u0637\u0631\u064a|\u0627\u0644\u0643\u0648\u064a\u062a\u064a|\u0627\u0644\u0628\u062d\u0631\u064a\u0646\u064a|\u0627\u0644\u0639\u0645\u0627\u0646\u064a|\u0627\u0644\u0639\u0631\u0627\u0642\u064a|\u0627\u0644\u0633\u0648\u0631\u064a|\u0627\u0644\u0627\u0631\u062f\u0646\u064a|\u0627\u0644\u0623\u0631\u062f\u0646\u064a|\u0627\u0644\u0644\u0628\u0646\u0627\u0646\u064a|\u0627\u0644\u0644\u064a\u0628\u064a|\u0627\u0644\u062a\u0648\u0646\u0633\u064a|\u0627\u0644\u0641\u0644\u0633\u0637\u064a\u0646\u064a|\u0627\u0644\u0645\u0648\u0631\u064a\u062a\u0627\u0646\u064a)$/g,
      ""
    );
  }
  return s.trim();
}

function buildUnorderedTeamPairKey(home: unknown, away: unknown, opts?: { stripGeo?: boolean }) {
  const a = normalizeTeamAliasForCompare(home, opts);
  const b = normalizeTeamAliasForCompare(away, opts);
  if (!a || !b) return "";
  return [a, b].sort().join("|");
}

function matchStartMs(raw: unknown) {
  const value = typeof raw === "string" ? raw : "";
  if (!value) return null as number | null;
  const ms = new Date(value).getTime();
  return Number.isFinite(ms) ? ms : null;
}

function areMatchStartsClose(aRaw: unknown, bRaw: unknown) {
  const a = matchStartMs(aRaw);
  const b = matchStartMs(bRaw);
  if (a === null || b === null) return true;
  return Math.abs(a - b) <= DUPLICATE_MATCH_START_WINDOW_MS;
}

function duplicateGroupKey(row: MatchApiRow, opts?: { stripGeo?: boolean }) {
  return buildUnorderedTeamPairKey(row.home_team, row.away_team, opts);
}

function countryQualifierCountForRow(row: MatchApiRow) {
  const homeStrict = normalizeTeamAliasForCompare(row.home_team);
  const awayStrict = normalizeTeamAliasForCompare(row.away_team);
  const homeLoose = normalizeTeamAliasForCompare(row.home_team, { stripGeo: true });
  const awayLoose = normalizeTeamAliasForCompare(row.away_team, { stripGeo: true });
  let count = 0;
  if (homeStrict && homeLoose && homeStrict !== homeLoose) count += 1;
  if (awayStrict && awayLoose && awayStrict !== awayLoose) count += 1;
  return count;
}

function matchRowInfoScore(row: MatchApiRow) {
  let score = 0;
  if (asNonEmptyString(row.home_logo)) score += 2;
  if (asNonEmptyString(row.away_logo)) score += 2;
  if (asNonEmptyString(row.match_start)) score += 1;
  if (row.home_score !== null && row.home_score !== undefined) score += 1;
  if (row.away_score !== null && row.away_score !== undefined) score += 1;
  const status = asNonEmptyString(row.status_key).toLowerCase();
  if (status === "live") score += 3;
  else if (status === "finished") score += 2;
  else if (status === "upcoming") score += 1;
  return score;
}

function pickPreferredStatus(baseRaw: unknown, donorRaw: unknown) {
  const rank = (raw: unknown) => {
    const s = asNonEmptyString(raw).toLowerCase();
    if (s === "live") return 4;
    if (s === "finished") return 3;
    if (s === "upcoming") return 2;
    if (s) return 1;
    return 0;
  };
  return rank(baseRaw) >= rank(donorRaw) ? asNonEmptyString(baseRaw) || null : asNonEmptyString(donorRaw) || null;
}

function mergeDuplicateGroup(base: MatchApiRow, donor: MatchApiRow) {
  return {
    ...base,
    match_key: asNonEmptyString(base.match_key) || asNonEmptyString(donor.match_key) || null,
    home_logo: asNonEmptyString(base.home_logo) || asNonEmptyString(donor.home_logo) || null,
    away_logo: asNonEmptyString(base.away_logo) || asNonEmptyString(donor.away_logo) || null,
    match_day: asNonEmptyString(base.match_day) || asNonEmptyString(donor.match_day) || null,
    match_start: asNonEmptyString(base.match_start) || asNonEmptyString(donor.match_start) || null,
    match_time: asNonEmptyString(base.match_time) || asNonEmptyString(donor.match_time) || null,
    home_score:
      base.home_score !== null && base.home_score !== undefined ? base.home_score : (donor.home_score ?? null),
    away_score:
      base.away_score !== null && base.away_score !== undefined ? base.away_score : (donor.away_score ?? null),
    status_key: pickPreferredStatus(base.status_key, donor.status_key),
  };
}

function dedupeLikelyDuplicateMatches(rows: MatchApiRow[]) {
  if (rows.length <= 1) return rows;
  const used = new Array<boolean>(rows.length).fill(false);
  const out: MatchApiRow[] = [];

  for (let i = 0; i < rows.length; i += 1) {
    if (used[i]) continue;
    used[i] = true;
    const group: MatchApiRow[] = [rows[i]];

    for (let j = i + 1; j < rows.length; j += 1) {
      if (used[j]) continue;
      const candidate = rows[j];
      const shouldMerge = group.some((base) => {
        if (!areMatchStartsClose(base.match_start, candidate.match_start)) return false;
        const strictA = duplicateGroupKey(base);
        const strictB = duplicateGroupKey(candidate);
        if (strictA && strictB && strictA === strictB) return true;
        const looseA = duplicateGroupKey(base, { stripGeo: true });
        const looseB = duplicateGroupKey(candidate, { stripGeo: true });
        return !!(looseA && looseB && looseA === looseB);
      });
      if (!shouldMerge) continue;
      used[j] = true;
      group.push(candidate);
    }

    if (group.length === 1) {
      out.push(group[0]);
      continue;
    }

    const ordered = [...group].sort((a, b) => {
      const qA = countryQualifierCountForRow(a);
      const qB = countryQualifierCountForRow(b);
      if (qA !== qB) return qA - qB;
      const infoDelta = matchRowInfoScore(b) - matchRowInfoScore(a);
      if (infoDelta !== 0) return infoDelta;
      const aStart = matchStartMs(a.match_start) ?? Number.MAX_SAFE_INTEGER;
      const bStart = matchStartMs(b.match_start) ?? Number.MAX_SAFE_INTEGER;
      if (aStart !== bStart) return aStart - bStart;
      return Number(a.id || 0) - Number(b.id || 0);
    });

    let merged = ordered[0];
    for (let k = 1; k < ordered.length; k += 1) {
      merged = mergeDuplicateGroup(merged, ordered[k]);
    }
    out.push(merged);
  }

  return out.sort((a, b) => {
    const aStart = matchStartMs(a.match_start) ?? Number.MAX_SAFE_INTEGER;
    const bStart = matchStartMs(b.match_start) ?? Number.MAX_SAFE_INTEGER;
    if (aStart !== bStart) return aStart - bStart;
    return Number(a.id || 0) - Number(b.id || 0);
  });
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

async function fetchMatchesForDay(day: string) {
  const { data, error } = await supabaseAdmin
    .from(TABLE)
    .select(
      "id,match_key,home_team,away_team,home_logo,away_logo,match_day,match_start,match_time,home_score,away_score,status_key"
    )
    .eq("match_day", day)
    .order("match_start", { ascending: true, nullsFirst: false })
    .order("id", { ascending: true });

  if (error) {
    throw new Error(error.message);
  }

  const hydrated = await hydrateMissingLogos((data ?? []) as MatchApiRow[]);
  const deduped = dedupeLikelyDuplicateMatches(hydrated);
  return deduped.map((row) => ({
    ...row,
    match_time: sanitizeMatchTimeForClient(row.match_time),
  }));
}

function getCachedMatchesFetcher(day: string) {
  return unstable_cache(() => fetchMatchesForDay(day), [`matches-day:${day}`], {
    revalidate: MATCHES_CACHE_TTL_SECONDS,
    tags: ["matches-list", `matches-day:${day}`],
  });
}

export async function GET(req: Request) {
  const { searchParams } = new URL(req.url);
  const day = searchParams.get("day");

  if (!day || !/^\d{4}-\d{2}-\d{2}$/.test(day)) {
    return NextResponse.json({ error: "Invalid day" }, { status: 400 });
  }

  try {
    const normalized = await getCachedMatchesFetcher(day)();
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

