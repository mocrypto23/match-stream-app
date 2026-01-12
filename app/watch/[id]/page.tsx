"use client";

import { useEffect, useMemo, useState } from "react";
import { useParams, useRouter } from "next/navigation";
import { supabase } from "@/lib/supabase";

type MatchRow = {
  id: number;
  home_team?: string | null;
  away_team?: string | null;
  stream_url?: string | null;
};

function isValidHttpUrl(u: string) {
  try {
    const url = new URL(u);
    return url.protocol === "http:" || url.protocol === "https:";
  } catch {
    return false;
  }
}

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
        .select("id, home_team, away_team, stream_url")
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
              لو المشكلة بسبب RLS: إمّا تسمح بالقراءة للـ anon على الجدول، أو تعرض الصفحة كـ Client زي هنا مع جلسة المستخدم.
            </div>
          </div>
        </div>
      </div>
    );
  }

  const home = match?.home_team ?? "الفريق الأول";
  const away = match?.away_team ?? "الفريق الثاني";
  const streamUrl = match?.stream_url ?? "";
  const canEmbed = streamUrl && isValidHttpUrl(streamUrl);

  return (
    <div className="min-h-screen bg-black text-white p-4">
      <div className="max-w-5xl mx-auto">
        {/* زر العودة */}
        <button
          onClick={() => router.back()}
          className="mb-4 text-gray-400 hover:text-white"
        >
          ← العودة للرئيسية
        </button>

        {/* مشغل الفيديو */}
        <div className="aspect-video bg-gray-900 rounded-xl overflow-hidden shadow-2xl border border-gray-800">
          {canEmbed ? (
            <iframe
              src={streamUrl}
              className="w-full h-full"
              allowFullScreen
              scrolling="no"
              allow="autoplay; encrypted-media; fullscreen; picture-in-picture"
              referrerPolicy="no-referrer-when-downgrade"
            />
          ) : (
            <div className="flex flex-col gap-2 items-center justify-center h-full text-gray-400 p-6 text-center">
              <div className="text-gray-300 font-semibold">رابط البث غير متوفر أو غير صالح للعرض داخل iframe</div>
              {streamUrl ? (
                <div className="text-xs text-gray-500 break-words">
                  الحالي: <span className="text-gray-400">{streamUrl}</span>
                </div>
              ) : null}
            </div>
          )}
        </div>

        {/* تفاصيل المباراة */}
        <div className="mt-6 bg-[#161616] p-6 rounded-2xl border border-gray-800 flex justify-between items-center">
          <div className="text-center flex-1 font-bold text-xl">{home}</div>
          <div className="text-red-500 font-black px-4">VS</div>
          <div className="text-center flex-1 font-bold text-xl">{away}</div>
        </div>
      </div>
    </div>
  );
}
