// ===============================
// File: scripts/diag-site.js
// ===============================
/**
 * Probes bein-live list pages on the runner and writes evidence under ./diag
 *
 * Usage:
 *   node scripts/diag-site.js
 *
 * Env:
 *   HEADLESS (default 1)
 *   DIAG (default 1)
 */

const { chromium } = require("playwright");
const fs2 = require("fs");
const path2 = require("path");

const HEADLESS2 = (process.env.HEADLESS ?? "1") !== "0";

const DAYS2 = [
  { key: "yesterday", url: "https://www.bein-live.com/matches-yesterday/" },
  { key: "today", url: "https://www.bein-live.com/matches-today_1/" },
  { key: "tomorrow", url: "https://www.bein-live.com/matches-tomorrow/" },
];

function ensureDir2(p) {
  try {
    fs2.mkdirSync(p, { recursive: true });
  } catch {}
}
function diagRoot2() {
  return path2.join(process.cwd(), "diag");
}
function diagWrite2(rel, content) {
  const root = diagRoot2();
  ensureDir2(root);
  const full = path2.join(root, rel);
  ensureDir2(path2.dirname(full));
  fs2.writeFileSync(full, content ?? "");
}

async function main2() {
  ensureDir2(diagRoot2());
  diagWrite2("_touch_site.txt", `ok ${new Date().toISOString()} headless=${HEADLESS2}\n`);

  const browser = await chromium.launch({
    headless: HEADLESS2,
    args: ["--no-sandbox", "--disable-dev-shm-usage"],
  });

  const context = await browser.newContext({
    locale: "ar-EG",
    timezoneId: "Africa/Cairo",
    userAgent:
      "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/121.0.0.0 Safari/537.36",
    viewport: { width: 1280, height: 720 },
  });

  const page = await context.newPage();

  const report = {
    ts: new Date().toISOString(),
    pages: {},
  };

  for (const d of DAYS2) {
    await page.goto(d.url, { waitUntil: "domcontentloaded", timeout: 60000 });
    await page.waitForTimeout(2000);

    const stats = await page.evaluate(() => {
      const matches = Array.from(document.querySelectorAll(".AY_Match"));
      const sampleText = matches.slice(0, 5).map((m) => (m.textContent || "").replace(/\s+/g, " ").trim());

      const hasGoals = !!document.querySelector(".AY_Match .RS-goals");
      const body = (document.body?.innerText || "").toLowerCase();
      const kw = ["جارية", "مباشر", "الآن", "انتهت", "انتهى", "live", "ft", "finished", "ended"];
      const hasKeywords = kw.some((k) => body.includes(k));

      return {
        matchCount: matches.length,
        hasGoals,
        hasKeywords,
        sampleText,
        title: document.title || "",
      };
    });

    report.pages[d.key] = { url: d.url, ...stats };

    try {
      await page.screenshot({ path: path2.join(diagRoot2(), `site_${d.key}.png`), fullPage: true });
    } catch {}

    try {
      const html = await page.content();
      diagWrite2(`site_${d.key}.html`, html.slice(0, 350000));
    } catch {}
  }

  diagWrite2("site_report.json", JSON.stringify(report, null, 2));
  console.log("✅ Wrote site probe diagnostics to ./diag");
  console.log(report);

  await page.close();
  await context.close();
  await browser.close();
}

main2().catch((e) => {
  try {
    ensureDir2(diagRoot2());
    diagWrite2("site_fatal.txt", String(e?.stack || e?.message || e));
  } catch {}
  console.error("❌ Fatal:", e?.message || e);
  process.exit(3);
});