export const runtime = "nodejs";

const cardStyle =
  "overflow-hidden rounded-[24px] border border-white/10 bg-[#0d1a25]/90 shadow-[0_20px_70px_rgba(0,0,0,0.28)]";

export default function KorasimoInterpolationLabPage() {
  return (
    <main className="min-h-screen bg-[radial-gradient(circle_at_top,rgba(29,211,176,0.14),transparent_34%),linear-gradient(180deg,#07111a_0%,#04080d_100%)] px-4 py-10 text-white">
      <div className="mx-auto max-w-6xl">
        <h1 className="text-3xl font-black sm:text-4xl">تجربة سريعة: Korasimo interpolation</h1>
        <p className="mt-3 max-w-3xl text-sm leading-7 text-slate-300 sm:text-base">
          هذه صفحة مقارنة مؤقتة وآمنة. اليسار هو البث الأصلي كما هو، واليمين نفس العينة بعد
          interpolation إلى 30fps تقريبًا. الهدف فقط أن نحكم سريعًا هل التحسن يستحق أصلًا أم لا.
        </p>

        <div className="mt-5 rounded-[22px] border border-white/10 bg-[#08121d]/80 p-4 text-sm leading-7 text-slate-300">
          لو النسخة المعدلة حسنت الإحساس بالحركة لكن ظهر معها تشوه حول الكرة أو ghosting مزعج،
          فغالبًا لا تستحق أن ندخل بها للإنتاج live.
        </div>

        <section className="mt-8 grid gap-5 lg:grid-cols-2">
          <article className={cardStyle}>
            <div className="border-b border-white/10 px-5 py-4">
              <div className="text-sm font-semibold text-emerald-300">العينة الأصلية</div>
              <h2 className="mt-1 text-xl font-bold">Original Stream Sample</h2>
              <p className="mt-2 text-sm text-slate-400">بدون أي تعديل أو صناعة فريمات إضافية</p>
            </div>
            <video
              className="block aspect-video w-full bg-black"
              controls
              preload="metadata"
              src="/api/lab/korasimo/original"
            />
          </article>

          <article className={cardStyle}>
            <div className="border-b border-white/10 px-5 py-4">
              <div className="text-sm font-semibold text-cyan-300">العينة المعدلة</div>
              <h2 className="mt-1 text-xl font-bold">Interpolated to 30fps</h2>
              <p className="mt-2 text-sm text-slate-400">
                باستخدام motion interpolation كتجربة بصرية فقط
              </p>
            </div>
            <video
              className="block aspect-video w-full bg-black"
              controls
              preload="metadata"
              src="/api/lab/korasimo/interpolated"
            />
          </article>
        </section>
      </div>
    </main>
  );
}
