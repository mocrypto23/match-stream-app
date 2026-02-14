// ===============================
// File: scripts/diag-site.js
// ===============================
/**
 * Probes bein-live list pages on the runner and writes evidence under ./diag.
 * This script is non-blocking by design and should not fail CI on network/site outages.
 *
 * Usage:
 *   node scripts/diag-site.js
 *
 * Env:
 *   HEADLESS (default 1)
 *   DIAG_GOTO_TIMEOUT_MS (default 60000)
 *   DIAG_GOTO_RETRIES (default 2)
 */

const { chromium } = require("playwright");
const fs2 = require("fs");
const path2 = require("path");

const HEADLESS2 = (process.env.HEADLESS ?? "1") !== "0";
const GOTO_TIMEOUT_MS = Math.max(
  5000,
  parseInt(process.env.DIAG_GOTO_TIMEOUT_MS || "60000", 10) || 60000
);
const GOTO_RETRIES = Math.max(1, parseInt(process.env.DIAG_GOTO_RETRIES || "2", 10) || 2);

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

async function gotoWithRetry(page, url, { timeoutMs = GOTO_TIMEOUT_MS, retries = GOTO_RETRIES } = {}) {
  let lastError = null;
  for (let attempt = 1; attempt <= retries; attempt += 1) {
    try {
      await page.goto(url, { waitUntil: "domcontentloaded", timeout: timeoutMs });
      return { ok: true, attempt };
    } catch (e) {
      lastError = e;
      if (attempt < retries) await page.waitForTimeout(1200).catch(() => {});
    }
  }
  return { ok: false, attempt: retries, error: lastError };
}

async function main2() {
  ensureDir2(diagRoot2());
  diagWrite2(
    "_touch_site.txt",
    `ok ${new Date().toISOString()} headless=${HEADLESS2} timeout_ms=${GOTO_TIMEOUT_MS} retries=${GOTO_RETRIES}\n`
  );

  let browser = null;
  let context = null;
  let page = null;

  try {
    browser = await chromium.launch({
      headless: HEADLESS2,
      args: ["--no-sandbox", "--disable-dev-shm-usage"],
    });

    context = await browser.newContext({
      locale: "ar-EG",
      timezoneId: "Africa/Cairo",
      userAgent:
        "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/121.0.0.0 Safari/537.36",
      viewport: { width: 1280, height: 720 },
    });

    page = await context.newPage();

    const report = {
      ts: new Date().toISOString(),
      timeout_ms: GOTO_TIMEOUT_MS,
      retries: GOTO_RETRIES,
      pages: {},
    };

    for (const d of DAYS2) {
      const pageReport = {
        url: d.url,
        ok: false,
        attempt: 0,
        error: null,
        matchCount: 0,
        hasGoals: false,
        hasKeywords: false,
        sampleText: [],
        title: "",
      };

      const nav = await gotoWithRetry(page, d.url);
      pageReport.attempt = nav.attempt;

      if (!nav.ok) {
        pageReport.error = nav.error?.message || String(nav.error || "navigation failed");
        report.pages[d.key] = pageReport;
        continue;
      }

      await page.waitForTimeout(2000);

      const stats = await page
        .evaluate(() => {
          const matches = Array.from(document.querySelectorAll(".AY_Match"));
          const sampleText = matches
            .slice(0, 5)
            .map((m) => (m.textContent || "").replace(/\s+/g, " ").trim());

          const hasGoals = !!document.querySelector(".AY_Match .RS-goals");
          const body = (document.body?.innerText || "").toLowerCase();
          const kw = [
            "\u062c\u0627\u0631\u064a\u0629",
            "\u0645\u0628\u0627\u0634\u0631",
            "\u0627\u0644\u0622\u0646",
            "\u0627\u0646\u062a\u0647\u062a",
            "\u0627\u0646\u062a\u0647\u0649",
            "live",
            "ft",
            "finished",
            "ended",
          ];
          const hasKeywords = kw.some((k) => body.includes(k));

          return {
            matchCount: matches.length,
            hasGoals,
            hasKeywords,
            sampleText,
            title: document.title || "",
          };
        })
        .catch((e) => ({ error: e?.message || String(e) }));

      if (stats.error) {
        pageReport.error = stats.error;
      } else {
        pageReport.ok = true;
        pageReport.matchCount = stats.matchCount;
        pageReport.hasGoals = stats.hasGoals;
        pageReport.hasKeywords = stats.hasKeywords;
        pageReport.sampleText = stats.sampleText;
        pageReport.title = stats.title;
      }

      report.pages[d.key] = pageReport;

      try {
        await page.screenshot({
          path: path2.join(diagRoot2(), `site_${d.key}.png`),
          fullPage: true,
        });
      } catch {}

      try {
        const html = await page.content();
        diagWrite2(`site_${d.key}.html`, html.slice(0, 350000));
      } catch {}
    }

    diagWrite2("site_report.json", JSON.stringify(report, null, 2));
    console.log("diag-site finished (non-blocking).");
    console.log(report);
  } finally {
    try {
      if (page) await page.close();
    } catch {}
    try {
      if (context) await context.close();
    } catch {}
    try {
      if (browser) await browser.close();
    } catch {}
  }
}

main2().catch((e) => {
  try {
    ensureDir2(diagRoot2());
    diagWrite2("site_fatal.txt", String(e?.stack || e?.message || e));
  } catch {}
  console.error("diag-site fatal (non-blocking):", e?.message || e);
});

