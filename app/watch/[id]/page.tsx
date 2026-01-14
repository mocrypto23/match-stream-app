"use client";

import { useEffect, useMemo, useState } from "react";
import { useParams, useRouter } from "next/navigation";
import { supabase } from "@/lib/supabase";

type MatchRow = {
  id: number;
  home_team?: string | null;
  away_team?: string | null;
  stream_url?: string | null;
  stream_url_2?: string | null;
  stream_url_3?: string | null;
  stream_url_4?: string | null;
  stream_url_5?: string | null;
  match_start?: string | null;
  status_key?: string | null;
};

function isValidHttpUrl(u: string) {
  try {
    const url = new URL(u);
    return url.protocol === "http:" || url.protocol === "https:";
  } catch {
    return false;
  }
}

function formatStartTimeAr(iso?: string | null) {
  if (!iso) return null;
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return null;
  return new Intl.DateTimeFormat("ar-EG", {
    dateStyle: "medium",
    timeStyle: "short",
  }).format(d);
}

// ✅ سيرفر 1 وباقي السيرفرات (زي ما كان)
const SAFE_IFRAME_SANDBOX =
  "allow-scripts allow-same-origin";

// ✅ (اختياري) تفعيل sandbox لسيرفر 2 قد يمنع popups
// ⚠️ لو السيرفر 2 اتعطل/رفض يشتغل: خليها false
const USE_SERVER2_SANDBOX = true;

// sandbox لسيرفر 2 بدون allow-popups (يعني يمنع النوافذ المنبثقة لو السيرفر يقبل)
const SERVER2_SANDBOX =
  "allow-scripts allow-same-origin";

export default function WatchPage() {
  const params = useParams();
  const router = useRouter();

  const rawId = useMemo(() => {
    const v = (params as any)?.id;
    return Array.isArray(v) ? v[0] : v;
  }, [params]);

  const idNum = useMemo(() => {
    const n = Number(rawId);
    return Number.isFinite(n) ? n : null;
  }, [rawId]);

  const [match, setMatch] = useState<MatchRow | null>(null);
  const [loading, setLoading] = useState(true);
  const [errMsg, setErrMsg] = useState<string | null>(null);

  const [selectedServer, setSelectedServer] = useState<number>(1);

  useEffect(() => {
    let cancelled = false;

    const fetchMatch = async () => {
      setLoading(true);
      setErrMsg(null);
      setMatch(null);

      if (idNum === null) {
        setLoading(false);
        setErrMsg("رقم المباراة غير صالح في الرابط.");
        return;
      }

      const { data, error } = await supabase
        .from("match-stream-app")
        .select(
          "id, home_team, away_team, stream_url, stream_url_2, stream_url_3, stream_url_4, stream_url_5, match_start, status_key"
        )
        .eq("id", idNum)
        .maybeSingle();

      if (cancelled) return;

      if (error) {
        setErrMsg(`خطأ أثناء جلب بيانات المباراة: ${error.message}`);
        setLoading(false);
        return;
      }

      if (!data) {
        setErrMsg("المباراة غير موجودة (لا يوجد سجل بهذا الرقم).");
        setLoading(false);
        return;
      }

      setMatch(data as MatchRow);
      setLoading(false);
    };

    fetchMatch();

    return () => {
      cancelled = true;
    };
  }, [idNum]);

  const servers = useMemo(() => {
    return [
      { n: 1, url: match?.stream_url ?? null },
      { n: 2, url: match?.stream_url_2 ?? null },
      { n: 3, url: match?.stream_url_3 ?? null },
      { n: 4, url: match?.stream_url_4 ?? null },
      { n: 5, url: match?.stream_url_5 ?? null },
    ]
      .filter((x) => x.url && isValidHttpUrl(x.url))
      .map((x) => ({ n: x.n, url: x.url as string }));
  }, [match]);

  // ✅ تثبيت سيرفر مختار لو الحالي مش موجود
  useEffect(() => {
    const exists = servers.some((x) => x.n === selectedServer);
    if (!exists && servers.length) setSelectedServer(servers[0].n);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [servers.length, servers.map((s) => s.n).join(","), selectedServer]);

  if (loading) {
    return <div className="text-white text-center mt-20">جاري تحميل البث...</div>;
  }

  if (errMsg) {
    return (
      <div className="min-h-screen bg-black text-white p-4">
        <div className="max-w-3xl mx-auto mt-10">
          <button
            onClick={() => router.back()}
            className="mb-4 text-gray-400 hover:text-white"
          >
            ← العودة للرئيسية
          </button>

          <div className="bg-[#161616] p-6 rounded-2xl border border-gray-800">
            <div className="font-bold mb-2">تعذر فتح صفحة المشاهدة</div>
            <div className="text-gray-300 break-words">{errMsg}</div>
            <div className="text-gray-500 mt-3 text-sm">
              لو المشكلة بسبب RLS: إمّا تسمح بالقراءة للـ anon على الجدول، أو تعرض
              الصفحة كـ Client زي هنا مع جلسة المستخدم.
            </div>
          </div>
        </div>
      </div>
    );
  }

  const home = match?.home_team ?? "الفريق الأول";
  const away = match?.away_team ?? "الفريق الثاني";

  const selectedUrl =
    selectedServer === 2
      ? match?.stream_url_2 ?? ""
      : selectedServer === 3
      ? match?.stream_url_3 ?? ""
      : selectedServer === 4
      ? match?.stream_url_4 ?? ""
      : selectedServer === 5
      ? match?.stream_url_5 ?? ""
      : match?.stream_url ?? "";

  const canEmbed = selectedUrl && isValidHttpUrl(selectedUrl);

  const status = (match?.status_key ?? "").toLowerCase();
  const nowMs = Date.now();
  const startMs = match?.match_start ? new Date(match.match_start).getTime() : null;
  const startValid = startMs !== null && Number.isFinite(startMs);

  const hasStartedByTime = startValid
    ? nowMs >= (startMs as number) - 2 * 60 * 1000
    : false;
  const hasStartedByStatus = status === "live" || status === "finished";
  const isUpcomingByStatus = status === "upcoming";

  const shouldBlockStream =
    isUpcomingByStatus || (!hasStartedByStatus && startValid && !hasStartedByTime);

  const prettyStart = formatStartTimeAr(match?.match_start);

  const isServer2 = selectedServer === 2;

  return (
    <div className="min-h-screen bg-black text-white p-4">
      <div className="max-w-5xl mx-auto">
        <button
          onClick={() => router.back()}
          className="mb-4 text-gray-400 hover:text-white"
        >
          ← العودة للرئيسية
        </button>

        <div className="mb-4 rounded-2xl border border-gray-800 bg-gradient-to-r from-[#1b1b1b] via-[#111111] to-[#1b1b1b] p-5 shadow-2xl">
          <div className="flex flex-col gap-2 items-center text-center">
            <div className="text-2xl sm:text-3xl font-black tracking-wide">
              مفيش اعلانات
            </div>

            <div className="text-2xl sm:text-3xl font-black tracking-wide">
              دبل كليك على الفيديو وحيكبر بسهولة
            </div>
          </div>
        </div>

        {servers.length > 1 ? (
          <div className="mb-3 flex flex-wrap gap-2">
            {servers.map((s) => (
              <button
                key={s.n}
                onClick={() => setSelectedServer(s.n)}
                className={[
                  "px-4 py-2 rounded-full font-black text-sm border transition-all",
                  selectedServer === s.n
                    ? "bg-blue-600/20 text-blue-400 border-blue-600/40"
                    : "bg-[#121212] text-gray-300 border-gray-800 hover:border-blue-600/40",
                ].join(" ")}
              >
                سيرفر {s.n}
              </button>
            ))}
          </div>
        ) : null}

        <div className="bg-gray-900 rounded-xl overflow-hidden shadow-2xl border border-gray-800">
          {shouldBlockStream ? (
            <div className="flex flex-col gap-2 items-center justify-center h-[55vh] min-h-[320px] text-gray-400 p-6 text-center">
              <div className="text-white font-bold text-xl">لم يبدأ البث بعد</div>
              {prettyStart ? (
                <div className="text-sm text-gray-400">
                  موعد المباراة:{" "}
                  <span className="text-gray-200">{prettyStart}</span>
                </div>
              ) : (
                <div className="text-sm text-gray-500">
                  سيتم تفعيل البث عند بدء المباراة.
                </div>
              )}
            </div>
          ) : canEmbed ? (
            isServer2 ? (
              <div className="relative">
                <iframe
                  key={`${selectedServer}-${selectedUrl}`}
                  src={selectedUrl}
                  className="w-full block"
                  style={{ height: 550 }}
                  frameBorder={0}
                  allowFullScreen
                  allow="autoplay; fullscreen"
                  // ✅ اختياري: sandbox لسيرفر 2 لمنع popups لو السيرفر يقبل
                  sandbox={USE_SERVER2_SANDBOX ? SERVER2_SANDBOX : undefined}
                  title={`Live Stream Server ${selectedServer}`}
                />
              </div>
            ) : (
              <div className="aspect-video">
                <iframe
                  key={`${selectedServer}-${selectedUrl}`}
                  src={selectedUrl}
                  className="w-full h-full"
                  allowFullScreen
                  scrolling="no"
                  allow="autoplay; encrypted-media; fullscreen; picture-in-picture"
                  referrerPolicy="no-referrer"
                  sandbox={SAFE_IFRAME_SANDBOX}
                  title={`Live Stream Server ${selectedServer}`}
                />
              </div>
            )
          ) : (
            <div className="flex flex-col gap-2 items-center justify-center h-[55vh] min-h-[320px] text-gray-400 p-6 text-center">
              <div className="text-gray-300 font-semibold">
                رابط البث غير متوفر أو غير صالح للعرض داخل iframe
              </div>

              {selectedUrl ? (
                <div className="text-xs text-gray-500 break-words">
                  الحالي: <span className="text-gray-400">{selectedUrl}</span>
                </div>
              ) : null}

              {selectedUrl ? (
                <a
                  href={selectedUrl}
                  target="_blank"
                  rel="noreferrer"
                  className="mt-3 text-sm font-bold text-blue-400 hover:text-blue-300"
                >
                  فتح الرابط في صفحة جديدة
                </a>
              ) : null}
            </div>
          )}
        </div>

        <div className="mt-6 bg-[#161616] p-6 rounded-2xl border border-gray-800 flex justify-between items-center">
          <div className="text-center flex-1 font-bold text-xl">{home}</div>
          <div className="text-red-500 font-black px-4">VS</div>
          <div className="text-center flex-1 font-bold text-xl">{away}</div>
        </div>
      </div>
    </div>
  );
}
