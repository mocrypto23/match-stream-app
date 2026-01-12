"use client";
import { useEffect, useMemo, useState } from "react";
import { supabase } from "@/lib/supabase";

type DayKey = "yesterday" | "today" | "tomorrow";
const TZ = "Africa/Cairo";

type MatchRow = {
  id: number;
  home_team: string;
  away_team: string;
  home_logo: string;
  away_logo: string;
  stream_url: string;
  match_day: string;
  match_start: string | null;
  match_time: string | null;
  home_score: number | null;
  away_score: number | null;
  status_key?: string | null;
  status_text?: string | null;
};

function cairoDayStringFromOffset(offsetDays: number) {
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

function dayToOffset(day: DayKey) {
  return day === "yesterday" ? -1 : day === "tomorrow" ? 1 : 0;
}

function safeDate(v: any): Date | null {
  if (!v) return null;
  const d = new Date(v);
  return Number.isNaN(d.getTime()) ? null : d;
}

function hasScores(m: MatchRow) {
  return m.home_score !== null && m.away_score !== null;
}

// fallback only (if status_key missing)
function isLiveWindow(matchStart: any) {
  const start = safeDate(matchStart);
  if (!start) return false;

  const now = new Date();
  const earlyMs = 10 * 60 * 1000;
  const lateMs = 2 * 60 * 60 * 1000 + 15 * 60 * 1000;

  return now.getTime() >= start.getTime() - earlyMs && now.getTime() <= start.getTime() + lateMs;
}

function isFinishedByTime(matchStart: any) {
  const start = safeDate(matchStart);
  if (!start) return false;

  const now = new Date();
  const endMs = 2 * 60 * 60 * 1000 + 15 * 60 * 1000;
  return now.getTime() > start.getTime() + endMs;
}

function normalizeStatusKey(sk: any): "live" | "finished" | "upcoming" | "unknown" {
  const s = String(sk || "").toLowerCase().trim();
  if (s === "live" || s === "finished" || s === "upcoming" || s === "unknown") return s as any;
  return "unknown";
}

export default function Home() {
  const [day, setDay] = useState<DayKey>("today");
  const [matches, setMatches] = useState<MatchRow[]>([]);
  const [loading, setLoading] = useState(true);

  const tabs = useMemo(
    () => [
      { key: "yesterday" as DayKey, label: "مباريات الأمس" },
      { key: "today" as DayKey, label: "مباريات اليوم" },
      { key: "tomorrow" as DayKey, label: "مباريات الغد" },
    ],
    []
  );

  useEffect(() => {
    let cancelled = false;

    const fetchMatches = async () => {
      setLoading(true);
      const matchDay = cairoDayStringFromOffset(dayToOffset(day));

      const { data, error } = await supabase
        .from("match-stream-app")
        .select("*")
        .eq("match_day", matchDay)
        .order("match_start", { ascending: true, nullsFirst: false })
        .order("id", { ascending: true });

      if (!cancelled) {
        if (error) {
          console.error("Supabase error:", error.message);
          setMatches([]);
        } else {
          setMatches((data || []) as MatchRow[]);
        }
        setLoading(false);
      }
    };

    fetchMatches();
    return () => {
      cancelled = true;
    };
  }, [day]);

  const sortedMatches = useMemo(() => {
    const arr = [...matches];

    const computedStatus = (m: MatchRow) => {
      if (day === "yesterday") return "finished" as const;

      const sk = normalizeStatusKey(m.status_key);

      // prefer scraper status
      if (day === "today") {
        if (sk === "live" || sk === "finished") return sk;
      }

      if (day === "tomorrow") return "upcoming" as const;

      // fallback if status missing/unknown
      const scores = hasScores(m);
      if (scores && isFinishedByTime(m.match_start)) return "finished" as const;
      if (isLiveWindow(m.match_start)) return "live" as const;
      return "upcoming" as const;
    };

    const rank = (s: string) => (s === "live" ? 0 : s === "upcoming" ? 1 : 2);

    arr.sort((a, b) => {
      const sa = computedStatus(a);
      const sb = computedStatus(b);
      const ra = rank(sa);
      const rb = rank(sb);
      if (ra !== rb) return ra - rb;

      const da = safeDate(a.match_start)?.getTime() ?? Number.POSITIVE_INFINITY;
      const db = safeDate(b.match_start)?.getTime() ?? Number.POSITIVE_INFINITY;
      if (da !== db) return da - db;

      return (a.id ?? 0) - (b.id ?? 0);
    });

    return arr;
  }, [matches, day]);

  if (loading) {
    return (
      <div className="min-h-screen bg-black text-white flex items-center justify-center font-bold">
        جاري تحميل{" "}
        {day === "yesterday" ? "مباريات الأمس" : day === "tomorrow" ? "مباريات الغد" : "مباريات اليوم"}...
      </div>
    );
  }

  return (
    <div className="min-h-screen bg-[#0a0a0a] text-white p-4 sm:p-8 font-sans" dir="rtl">
      <header className="max-w-4xl mx-auto flex justify-between items-center mb-6 border-b border-gray-900 pb-6">
        <h1 className="text-3xl font-black text-blue-500 tracking-tighter">
          Two<span className="text-white">Footy</span>
        </h1>
        <div className="flex items-center gap-2">
          <span className="w-2 h-2 bg-red-600 rounded-full animate-pulse"></span>
          <span className="text-sm text-gray-400 font-bold text-red-500">بث مباشر الآن</span>
        </div>
      </header>

      <div className="max-w-4xl mx-auto flex gap-2 mb-8">
        {tabs.map((t) => (
          <button
            key={t.key}
            onClick={() => setDay(t.key)}
            className={[
              "px-4 py-2 rounded-full font-black text-sm border transition-all",
              day === t.key
                ? "bg-blue-600/20 text-blue-400 border-blue-600/40"
                : "bg-[#121212] text-gray-300 border-gray-800 hover:border-blue-600/40",
            ].join(" ")}
          >
            {t.label}
          </button>
        ))}
      </div>

      <main className="max-w-4xl mx-auto grid gap-6">
        {sortedMatches.length > 0 ? (
          sortedMatches.map((match) => {
            const scores = hasScores(match);

            const sk = normalizeStatusKey(match.status_key);
            const fallbackLive = day === "today" && isLiveWindow(match.match_start);
            const fallbackFinished = day === "today" && scores && isFinishedByTime(match.match_start);

            const status =
              day === "yesterday"
                ? "finished"
                : day === "tomorrow"
                ? "upcoming"
                : sk === "live" || sk === "finished"
                ? sk
                : fallbackFinished
                ? "finished"
                : fallbackLive
                ? "live"
                : "upcoming";

            const centerText =
              status !== "upcoming" && scores ? `${match.home_score} - ${match.away_score}` : match.match_time || "—";

            const canNavigate = day !== "yesterday" && Boolean(match?.id);

            return (
              <div
                key={match.id}
                onClick={() => {
                  if (!canNavigate) return;
                  window.location.href = `/watch/${match.id}`;
                }}
                className={[
                  "bg-[#121212] border border-gray-800 p-6 rounded-[2rem] flex justify-between items-center shadow-2xl group",
                  canNavigate ? "hover:border-blue-600 hover:scale-[1.01] transition-all cursor-pointer" : "opacity-90",
                ].join(" ")}
              >
                <div className="flex flex-col items-center gap-3 flex-1">
                  <div className="w-16 h-16 bg-gray-900 rounded-full flex items-center justify-center p-2 border border-gray-800 group-hover:border-blue-500 transition-colors">
                    <img src={match.home_logo} alt={match.home_team} className="w-full h-full object-contain" />
                  </div>
                  <span className="text-sm sm:text-lg font-black text-center">{match.home_team}</span>
                </div>

                <div className="flex flex-col items-center gap-2 px-4">
                  <span className="text-blue-500 font-black text-xl">{centerText}</span>

                  {status === "finished" ? (
                    <div className="bg-gray-700/10 text-gray-300 text-[10px] px-4 py-1 rounded-full font-black border border-gray-700/30">
                      انتهت
                    </div>
                  ) : status === "live" ? (
                    <div className="bg-red-600/10 text-red-400 text-[10px] px-4 py-1 rounded-full font-black border border-red-600/30">
                      جارية الآن
                    </div>
                  ) : (
                    <div className="bg-blue-600/10 text-blue-500 text-[10px] px-4 py-1 rounded-full font-black border border-blue-600/20">
                      مشاهدة
                    </div>
                  )}
                </div>

                <div className="flex flex-col items-center gap-3 flex-1">
                  <div className="w-16 h-16 bg-gray-900 rounded-full flex items-center justify-center p-2 border border-gray-800 group-hover:border-blue-500 transition-colors">
                    <img src={match.away_logo} alt={match.away_team} className="w-full h-full object-contain" />
                  </div>
                  <span className="text-sm sm:text-lg font-black text-center">{match.away_team}</span>
                </div>
              </div>
            );
          })
        ) : (
          <div className="text-center py-20 text-gray-500 font-bold">
            لا توجد مباريات مدرجة {day === "yesterday" ? "بالأمس" : day === "tomorrow" ? "غدًا" : "اليوم"}.
          </div>
        )}
      </main>
    </div>
  );
}
  