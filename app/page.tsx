"use client";
import { useEffect, useMemo, useState } from "react";
import { supabase } from "@/lib/supabase";

type DayKey = "yesterday" | "today" | "tomorrow";

function cairoDayStringFromOffset(offsetDays: number) {
  const TZ = "Africa/Cairo";
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

export default function Home() {
  const [day, setDay] = useState<DayKey>("today");
  const [matches, setMatches] = useState<any[]>([]);
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
          setMatches(data || []);
        }
        setLoading(false);
      }
    };

    fetchMatches();
    return () => {
      cancelled = true;
    };
  }, [day]);

  if (loading) {
    return (
      <div className="min-h-screen bg-black text-white flex items-center justify-center font-bold">
        جاري تحميل {day === "yesterday" ? "مباريات الأمس" : day === "tomorrow" ? "مباريات الغد" : "مباريات اليوم"}...
      </div>
    );
  }

  return (
    <div className="min-h-screen bg-[#0a0a0a] text-white p-4 sm:p-8 font-sans" dir="rtl">
      {/* Header */}
      <header className="max-w-4xl mx-auto flex justify-between items-center mb-6 border-b border-gray-900 pb-6">
        <h1 className="text-3xl font-black text-blue-500 tracking-tighter">
          Two<span className="text-white">Footy</span>
        </h1>
        <div className="flex items-center gap-2">
          <span className="w-2 h-2 bg-red-600 rounded-full animate-pulse"></span>
          <span className="text-sm text-gray-400 font-bold text-red-500">بث مباشر الآن</span>
        </div>
      </header>

      {/* Tabs */}
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

      {/* Matches Grid */}
      <main className="max-w-4xl mx-auto grid gap-6">
        {matches.length > 0 ? (
          matches.map((match) => {
            const hasScores =
              match.home_score !== undefined &&
              match.home_score !== null &&
              match.away_score !== undefined &&
              match.away_score !== null;

            const centerText =
              day === "yesterday"
                ? hasScores
                  ? `${match.home_score} - ${match.away_score}`
                  : match.match_time || "—"
                : match.match_time || "—";

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
                {/* Home */}
                <div className="flex flex-col items-center gap-3 flex-1">
                  <div className="w-16 h-16 bg-gray-900 rounded-full flex items-center justify-center p-2 border border-gray-800 group-hover:border-blue-500 transition-colors">
                    <img src={match.home_logo} alt={match.home_team} className="w-full h-full object-contain" />
                  </div>
                  <span className="text-sm sm:text-lg font-black text-center">{match.home_team}</span>
                </div>

                {/* Center */}
                <div className="flex flex-col items-center gap-2 px-4">
                  <span className="text-blue-500 font-black text-xl">{centerText}</span>

                  {day === "yesterday" ? (
                    <div className="bg-gray-700/10 text-gray-300 text-[10px] px-4 py-1 rounded-full font-black border border-gray-700/30">
                      انتهت
                    </div>
                  ) : (
                    <div className="bg-blue-600/10 text-blue-500 text-[10px] px-4 py-1 rounded-full font-black border border-blue-600/20">
                      مشاهدة
                    </div>
                  )}
                </div>

                {/* Away */}
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
