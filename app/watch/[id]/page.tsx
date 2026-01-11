"use client";
import { useEffect, useState } from "react";
import { useParams } from "next/navigation";
import { supabase } from "@/lib/supabase";

export default function WatchPage() {
  const { id } = useParams();
  const [match, setMatch] = useState<any>(null);

  useEffect(() => {
    const fetchMatch = async () => {
      const { data } = await supabase
        .from("match-stream-app")
        .select("*")
        .eq("id", id)
        .single();
      setMatch(data);
    };
    fetchMatch();
  }, [id]);

  if (!match) return <div className="text-white text-center mt-20">جاري تحميل البث...</div>;

  return (
    <div className="min-h-screen bg-black text-white p-4">
      <div className="max-w-5xl mx-auto">
        {/* زر العودة */}
        <button onClick={() => window.history.back()} className="mb-4 text-gray-400 hover:text-white">
           ← العودة للرئيسية
        </button>

        {/* مشغل الفيديو */}
        <div className="aspect-video bg-gray-900 rounded-xl overflow-hidden shadow-2xl border border-gray-800">
          {match.stream_url ? (
            <iframe
              src={match.stream_url}
              className="w-full h-full"
              allowFullScreen
              scrolling="no"
              allow="autoplay; encrypted-media"
            ></iframe>
          ) : (
            <div className="flex items-center justify-center h-full text-gray-500">
              رابط البث غير متوفر حالياً
            </div>
          )}
        </div>

        {/* تفاصيل المباراة */}
        <div className="mt-6 bg-[#161616] p-6 rounded-2xl border border-gray-800 flex justify-between items-center">
          <div className="text-center flex-1 font-bold text-xl">{match.home_team}</div>
          <div className="text-red-500 font-black px-4">VS</div>
          <div className="text-center flex-1 font-bold text-xl">{match.away_team}</div>
        </div>
      </div>
    </div>
  );
}