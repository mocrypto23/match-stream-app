const { chromium } = require("playwright");

const sourceUrl = String(process.argv[2] || "").trim();
const DEFAULT_USER_AGENT =
  "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/145.0.0.0 Safari/537.36";
const PAGE_GOTO_TIMEOUT_MS = 15000;
const OVERALL_TIMEOUT_MS = 22000;

function normalizeHttpUrl(rawUrl) {
  try {
    const parsed = new URL(String(rawUrl || "").trim());
    return parsed.protocol === "http:" || parsed.protocol === "https:" ? parsed.toString() : "";
  } catch {
    return "";
  }
}

function decodeMaybeBase64(rawValue) {
  const value = String(rawValue || "").trim();
  if (!value) return "";
  try {
    const decoded = Buffer.from(value, "base64").toString("utf8").trim();
    return /^https?:\/\//i.test(decoded) ? decoded : value;
  } catch {
    return value;
  }
}

function extractIframeUrls(rawHtml, baseUrl) {
  const html = String(rawHtml || "");
  const out = [];
  const pushUnique = (raw) => {
    const decoded = decodeMaybeBase64(raw);
    const normalized = normalizeHttpUrl(decoded);
    if (!normalized || out.includes(normalized)) return;
    out.push(normalized);
  };

  for (const match of html.matchAll(/\b(?:data-vload|data-id|data-initial|data-url)=['"]([^'"]+)['"]/gi)) {
    pushUnique(String(match[1] || "").trim());
  }
  for (const match of html.matchAll(/\b(?:src|href)=['"]([^'"]*(?:\/albaplayer\/|playerv2\.php)[^'"]*)['"]/gi)) {
    const value = String(match[1] || "").trim();
    if (!value) continue;
    try {
      pushUnique(new URL(value, baseUrl).toString());
    } catch {}
  }
  return out;
}

async function main() {
  const normalizedSourceUrl = normalizeHttpUrl(sourceUrl);
  if (!normalizedSourceUrl) {
    process.stdout.write(JSON.stringify({ ok: false, error: "invalid-source-url", iframeUrls: [] }) + "\n");
    process.exit(0);
  }

  const browser = await chromium.launch({
    headless: true,
    args: ["--disable-dev-shm-usage", "--disable-blink-features=AutomationControlled"],
  });
  const context = await browser.newContext({
    userAgent: DEFAULT_USER_AGENT,
    locale: "ar-EG",
    viewport: { width: 1366, height: 900 },
  });
  const page = await context.newPage();
  const deadlineAt = Date.now() + OVERALL_TIMEOUT_MS;
  let ajaxHtml = "";
  let containerHtml = "";
  let iframeUrls = [];

  page.on("response", async (response) => {
    try {
      const url = normalizeHttpUrl(response.url());
      if (!url || !url.includes("/wp-admin/admin-ajax.php")) return;
      if (String(response.request().method() || "").toUpperCase() !== "POST") return;
      const text = await response.text().catch(() => "");
      if (!text || !String(text).trim()) return;
      ajaxHtml = text;
      const extracted = extractIframeUrls(text, normalizedSourceUrl);
      if (extracted.length) {
        iframeUrls = extracted;
      }
    } catch {}
  });

  try {
    await page.goto(normalizedSourceUrl, {
      waitUntil: "domcontentloaded",
      timeout: PAGE_GOTO_TIMEOUT_MS,
    });
    while (Date.now() < deadlineAt) {
      const snapshot = await page
        .evaluate(() => {
          const container = document.querySelector(".alba-ajax-servers-container");
          if (!container) {
            return { containerHtml: "", attrValues: [] };
          }
          const attrValues = [];
          const nodes = container.querySelectorAll("[data-vload],[data-id],[data-initial],[data-url],iframe#mainIframe,a.srv-click,a.srv-click-plain");
          for (const node of Array.from(nodes)) {
            for (const name of ["data-vload", "data-id", "data-initial", "data-url", "src", "href"]) {
              const value = node.getAttribute?.(name);
              if (value) attrValues.push(value);
            }
          }
          return {
            containerHtml: container.innerHTML || "",
            attrValues,
          };
        })
        .catch(() => ({ containerHtml: "", attrValues: [] }));

      containerHtml = String(snapshot.containerHtml || "");
      const domUrls = [];
      for (const value of Array.isArray(snapshot.attrValues) ? snapshot.attrValues : []) {
        const decoded = decodeMaybeBase64(String(value || "").trim());
        const normalized = normalizeHttpUrl(decoded);
        if (normalized && !domUrls.includes(normalized)) domUrls.push(normalized);
      }
      if (domUrls.length) {
        iframeUrls = domUrls;
      }
      if (iframeUrls.length) break;
      await page.waitForTimeout(500).catch(() => {});
    }
  } catch (error) {
    process.stdout.write(
      JSON.stringify({
        ok: false,
        error: error instanceof Error ? error.message : String(error || "browser-navigation-failed"),
        serverHtml: ajaxHtml || containerHtml,
        iframeUrls,
      }) + "\n"
    );
    await context.close().catch(() => {});
    await browser.close().catch(() => {});
    process.exit(0);
  }

  const finalHtml = ajaxHtml || containerHtml;
  const finalUrls = iframeUrls.length ? iframeUrls : extractIframeUrls(finalHtml, normalizedSourceUrl);
  process.stdout.write(
    JSON.stringify({
      ok: finalUrls.length > 0,
      error: finalUrls.length ? "" : "browser-iframe-urls-missing",
      serverHtml: finalHtml,
      iframeUrls: finalUrls,
    }) + "\n"
  );

  await context.close().catch(() => {});
  await browser.close().catch(() => {});
}

main().catch((error) => {
  process.stdout.write(
    JSON.stringify({
      ok: false,
      error: error instanceof Error ? error.message : String(error || "beinlive-direct-extract-failed"),
      iframeUrls: [],
    }) + "\n"
  );
});
