"use client";

import { useEffect, useMemo, useRef, useState } from "react";

type DayKey = "yesterday" | "today" | "tomorrow";
const TZ = "Africa/Cairo";
const MATCH_NOTICE_ENABLED = true; // Switch ON/OFF the top matches notice

type MatchRow = {
  id: number;
  match_key?: string | null;
  home_team: string;
  away_team: string;
  home_logo?: string | null;
  away_logo?: string | null;
  stream_url: string;
  match_day: string;
  match_start: string | null;
  match_time: string | null;
  home_score: number | null;
  away_score: number | null;
  status_key?: string | null;
  status_text?: string | null;
};

type BannerAtOptions = {
  key: string;
  format: "iframe";
  height: number;
  width: number;
  params: Record<string, string>;
};

declare global {
  interface Window {
    atOptions?: BannerAtOptions;
  }
}

function isValidHttpUrl(raw: unknown): raw is string {
  if (typeof raw !== "string") return false;
  try {
    const u = new URL(raw);
    return u.protocol === "http:" || u.protocol === "https:";
  } catch {
    return false;
  }
}

function teamInitials(name: string) {
  const clean = String(name || "").trim();
  if (!clean) return "FC";
  const parts = clean.split(/\s+/).filter(Boolean);
  if (parts.length <= 1) return parts[0]?.slice(0, 2) || "FC";
  return `${parts[0]?.[0] || ""}${parts[1]?.[0] || ""}` || "FC";
}

function TeamLogo({ logo, team }: { logo?: string | null; team: string }) {
  const [failed, setFailed] = useState(false);
  const validLogo = isValidHttpUrl(logo) ? logo : null;
  const showImage = Boolean(validLogo) && !failed;

  return (
    <div className="w-full h-full rounded-full overflow-hidden flex items-center justify-center bg-gray-950 text-gray-300">
      {showImage ? (
        <img
          src={validLogo!}
          alt={team}
          className="w-full h-full object-contain"
          loading="lazy"
          decoding="async"
          onError={() => setFailed(true)}
        />
      ) : (
        <span className="text-[11px] sm:text-xs font-black">{teamInitials(team)}</span>
      )}
    </div>
  );
}

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
  // Relaxed to 3 hours (180 mins) to avoid hiding matches that go into extra time/penalties
  const endMs = 3 * 60 * 60 * 1000;
  return now.getTime() > start.getTime() + endMs;
}

function normalizeStatusKey(sk: any): "live" | "finished" | "upcoming" | "unknown" {
  const s = String(sk || "").toLowerCase().trim();
  if (s === "live" || s === "finished" || s === "upcoming" || s === "unknown") return s as any;
  return "unknown";
}

function sanitizeDisplayMatchTime(raw: unknown) {
  const value = typeof raw === "string" ? raw.trim() : "";
  if (!value) return null as string | null;

  const normalized = value
    .replace(/â€”|â€“|â€"|â€|â€˜|â€™/g, "—")
    .replace(/[‐‑‒–—―]+/g, "—")
    .replace(/\s+/g, " ")
    .trim();
  if (!normalized) return null;

  if (/^[-—]+$/.test(normalized.replace(/\s+/g, ""))) return null;
  return normalized;
}

export default function Home() {
  const [day, setDay] = useState<DayKey>("today");
  const [matches, setMatches] = useState<MatchRow[]>([]);
  const [loading, setLoading] = useState(true);
  const noticeBannerRef = useRef<HTMLDivElement | null>(null);

  const tabs = useMemo(
    () => [
      { key: "yesterday" as DayKey, label: "مباريات الأمس" },
      { key: "today" as DayKey, label: "مباريات اليوم" },
      { key: "tomorrow" as DayKey, label: "مباريات الغد" },
    ],
    []
  );

  useEffect(() => {
    const ac = new AbortController();

    const fetchMatches = async () => {
      setLoading(true);
      const matchDay = cairoDayStringFromOffset(dayToOffset(day));

      try {
        // ✅ بدل supabase client: هنجيب من API
        const res = await fetch(`/api/matches?day=${encodeURIComponent(matchDay)}`, {
          method: "GET",
          signal: ac.signal,
          headers: { Accept: "application/json" },
        });

        const json = (await res.json().catch(() => null)) as any;

        if (!res.ok) {
          console.error("API error:", json?.error || `HTTP ${res.status}`);
          setMatches([]);
          setLoading(false);
          return;
        }

        setMatches((Array.isArray(json) ? json : json?.data || []) as MatchRow[]);
        setLoading(false);
      } catch (e: any) {
        if (e?.name === "AbortError") return;
        console.error("Fetch error:", e?.message || e);
        setMatches([]);
        setLoading(false);
      }
    };

    fetchMatches();
    return () => ac.abort();
  }, [day]);

  useEffect(() => {
    if (!MATCH_NOTICE_ENABLED || loading) return;
    const container = noticeBannerRef.current;
    if (!container) return;

    container.innerHTML = "";

    window.atOptions = {
      key: "6a12e1a77f6425cf6359cb652cff80e3",
      format: "iframe",
      height: 90,
      width: 728,
      params: {},
    };

    const script = document.createElement("script");
    script.type = "text/javascript";
    script.src = "https://www.highperformanceformat.com/6a12e1a77f6425cf6359cb652cff80e3/invoke.js";
    script.async = true;

    container.appendChild(script);

    return () => {
      container.innerHTML = "";
    };
  }, [loading]);

  const sortedMatches = useMemo(() => {
    const getStatus = (m: MatchRow) => {
      if (day === "yesterday") return "finished" as const;

      const sk = normalizeStatusKey(m.status_key);

      // If DB explicitly says live/finished, trust it first (especially for "today")
      if (day === "today") {
        if (sk === "live") return "live";
        if (sk === "finished") return "finished";
      }

      if (day === "tomorrow") return "upcoming" as const;

      // Fallback to time-based if status is unknown/upcoming but time passed
      if (isFinishedByTime(m.match_start)) return "finished" as const;
      if (isLiveWindow(m.match_start)) return "live" as const;

      return "upcoming" as const;
    };

    const arr = [...matches];

    const rank = (s: string) => (s === "live" ? 0 : s === "upcoming" ? 1 : 2);

    arr.sort((a, b) => {
      const sa = getStatus(a);
      const sb = getStatus(b);
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

      {MATCH_NOTICE_ENABLED ? (
        <section className="max-w-2xl mx-auto mb-6 px-1">
          <div className="rounded-xl border-r-4 border-[#2ecc71] bg-[linear-gradient(135deg,#ffffff_0%,#f1f8e9_100%)] p-3 sm:p-4 text-right shadow-[0_10px_25px_rgba(0,0,0,0.05)] relative overflow-hidden">
            <div className="flex items-center mb-2">
              <div className="bg-[#2ecc71] text-white w-6 h-6 rounded-full flex items-center justify-center ml-2 font-bold text-sm">
                !
              </div>
              <h3 className="m-0 text-[#1a5d1a] text-base font-bold">ملاحظة تهمك</h3>
            </div>

            <p className="m-0 text-[#34495e] text-sm sm:text-[15px] leading-6">
              موقعنا <span className="text-[#27ae60] font-bold">مجاني تماماً</span> وبدون إعلانات مزعجة{" "}
              <span className="text-red-600 font-bold">أثناء البث</span>.. استمرارنا يعتمد على دعمك بتصفح{" "}
              <span className="bg-[#e8f5e9] px-2 py-[2px] rounded text-[#2e7d32] font-bold border border-[#c8e6c9]">
                الإعلان الوحيد
              </span>{" "}
              (إذا كنت مهتماً به) ويحفزنا على التطوير لضمان أفضل جودة لك.
            </p>

            <div className="mt-3 overflow-x-auto" dir="ltr">
              <div ref={noticeBannerRef} className="mx-auto h-[90px] w-[728px] min-w-[728px]" />
            </div>

            <div className="absolute -left-5 -bottom-5 opacity-5" aria-hidden="true">
              <svg width="100" height="100" viewBox="0 0 24 24" fill="#2ecc71">
                <path d="M12 2C6.48 2 2 6.48 2 12s4.48 10 10 10 10-4.48 10-10S17.52 2 12 2zm0 18c-4.41 0-8-3.59-8-8s3.59-8 8-8 8 3.59 8 8-3.59 8-8 8z" />
              </svg>
            </div>
          </div>
        </section>
      ) : null}

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
            const fallbackFinished = day === "today" && isFinishedByTime(match.match_start);

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
              (() => {
                const safeMatchTime = sanitizeDisplayMatchTime(match.match_time);
                return status === "upcoming"
                  ? safeMatchTime || "—"
                  : scores
                    ? `${match.home_score} - ${match.away_score}`
                    : status === "finished"
                      ? "— - —"
                      : safeMatchTime || "—";
              })();

            const canNavigate = day !== "yesterday" && Boolean(match?.id);
            const watchHref = `/watch/${match.id}`;

            return (
              <div
                key={match.id}
                onClick={() => {
                  if (!canNavigate) return;
                  window.location.href = watchHref;
                }}
                className={[
                  "bg-[#121212] border border-gray-800 p-6 rounded-[2rem] flex justify-between items-center shadow-2xl group",
                  canNavigate ? "hover:border-blue-600 hover:scale-[1.01] transition-all cursor-pointer" : "opacity-90",
                ].join(" ")}
              >
                <div className="flex flex-col items-center gap-3 flex-1">
                  <div className="w-16 h-16 bg-gray-900 rounded-full flex items-center justify-center p-2 border border-gray-800 group-hover:border-blue-500 transition-colors">
                    <TeamLogo logo={match.home_logo} team={match.home_team} />
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
                    <TeamLogo logo={match.away_logo} team={match.away_team} />
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

