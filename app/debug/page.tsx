"use client";
import { useEffect, useState } from "react";
import { supabase } from "@/lib/supabase";

export default function DebugPage() {
  const [status, setStatus] = useState<any>({ step: "بدء الفحص...", details: "" });

  useEffect(() => {
    async function checkConnection() {
      try {
        // 1. فحص هل المتغيرات موجودة
        if (!process.env.NEXT_PUBLIC_SUPABASE_URL) {
          setStatus({ step: "خطأ في الإعدادات", details: "ملف .env.local لا يحتوي على URL" });
          return;
        }

        // 2. محاولة جلب بيانات من الجدول
        const { data, error } = await supabase.from("match-stream-app").select("*").limit(1);

        if (error) {
          setStatus({ step: "فشل الاتصال بـ Supabase", details: error.message });
        } else {
          setStatus({ 
            step: "نجاح الاتصال! ✅", 
            details: `تم العثور على ${data.length} مباراة في قاعدة البيانات.` 
          });
        }
      } catch (err: any) {
        setStatus({ step: "خطأ غير متوقع", details: err.message });
      }
    }
    checkConnection();
  }, []);

  return (
    <div className="p-10 bg-black text-white min-h-screen font-mono">
      <h1 className="text-2xl mb-5 text-blue-500">فاحص الأخطاء لـ TwoFooty</h1>
      <div className="border border-gray-700 p-5 rounded">
        <p className="mb-2"><span className="text-gray-400">الحالة:</span> {status.step}</p>
        <p><span className="text-gray-400">التفاصيل:</span> <span className="text-red-400">{status.details}</span></p>
      </div>
      <button 
        onClick={() => window.location.href = "/"}
        className="mt-5 bg-blue-600 px-4 py-2 rounded"
      >
        الرجوع للرئيسية
      </button>
    </div>
  );
}