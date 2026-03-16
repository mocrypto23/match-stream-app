export type DayKey = "yesterday" | "today" | "tomorrow";

export type MatchRow = {
  id: number;
  match_key?: string | null;
  home_team: string;
  away_team: string;
  home_logo?: string | null;
  away_logo?: string | null;
  stream_url?: string | null;
  match_day: string;
  match_start: string | null;
  match_time: string | null;
  home_score: number | null;
  away_score: number | null;
  status_key?: string | null;
  status_text?: string | null;
};

const TZ = "Africa/Cairo";

export function cairoDayStringFromOffset(offsetDays: number) {
  const now = new Date();
  const shifted = new Date(now.getTime() + offsetDays * 24 * 60 * 60 * 1000);

  const parts = new Intl.DateTimeFormat("en", {
    timeZone: TZ,
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
  }).formatToParts(shifted);

  const y = parts.find((p) => p.type === "year")?.value;
  const m = parts.find((p) => p.type === "month")?.value;
  const d = parts.find((p) => p.type === "day")?.value;

  return `${y}-${m}-${d}`;
}

export function dayToOffset(day: DayKey) {
  return day === "yesterday" ? -1 : day === "tomorrow" ? 1 : 0;
}
