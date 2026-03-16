import HomePageClient from "@/components/HomePageClient";
import { readMatchesForDay } from "@/lib/home-matches";
import { cairoDayStringFromOffset, type MatchRow } from "@/lib/home-page-shared";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export default async function HomePage() {
  const today = cairoDayStringFromOffset(0);

  let initialMatches: MatchRow[] = [];
  let initialLoadError: string | null = null;

  try {
    initialMatches = await readMatchesForDay(today);
  } catch {
    initialLoadError = "تعذر تحميل مباريات اليوم الآن. حاول مرة أخرى بعد لحظات.";
  }

  return <HomePageClient initialDay="today" initialMatches={initialMatches} initialLoadError={initialLoadError} />;
}
