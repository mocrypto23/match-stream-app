const { chromium } = require("playwright");

const channelUrl = String(process.argv[2] || "").trim();
const BROWSER_TIMEOUT_MS = 12000;

function normalizeHttpUrl(rawUrl) {
  try {
    const parsed = new URL(String(rawUrl || "").trim());
    return parsed.protocol === "http:" || parsed.protocol === "https:" ? parsed.toString() : "";
  } catch {
    return "";
  }
}

function resolveIframeUrl(rawUrl, baseUrl) {
  try {
    const absolute = new URL(String(rawUrl || "").trim(), baseUrl).toString();
    return normalizeHttpUrl(absolute);
  } catch {
    return "";
  }
}

function hasMediaSegments(manifestText, baseUrl) {
  let previousExtInf = false;
  for (const line of String(manifestText || "").split(/\r?\n/)) {
    const trimmed = String(line || "").trim();
    if (!trimmed) continue;
    if (trimmed.startsWith("#EXTINF")) {
      previousExtInf = true;
      continue;
    }
    if (trimmed.startsWith("#")) {
      if (!trimmed.startsWith("#EXT-X-STREAM-INF")) previousExtInf = false;
      continue;
    }
    try {
      const absolute = new URL(trimmed, baseUrl).toString();
      if (absolute && previousExtInf) return true;
    } catch {}
    previousExtInf = false;
  }
  return false;
}

async function main() {
  if (!channelUrl) {
    console.log(JSON.stringify({ ok: false, error: "missing-channel-url" }));
    return;
  }

  const browser = await chromium.launch({
    headless: true,
    args: ["--disable-dev-shm-usage", "--disable-blink-features=AutomationControlled", "--no-sandbox"],
  });

  let manifestUrl = "";
  let manifestBody = "";
  let referrerUrl = channelUrl;
  let resolveFound = null;
  const foundPromise = new Promise((resolve) => {
    resolveFound = resolve;
  });

  try {
    const context = await browser.newContext({
      ignoreHTTPSErrors: true,
      locale: "ar-EG",
      userAgent:
        "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/145.0.0.0 Safari/537.36",
      viewport: { width: 1440, height: 900 },
      extraHTTPHeaders: {
        "accept-language": "ar,en-US;q=0.9,en;q=0.8",
      },
    });
    await context.route("**/*", async (route) => {
      const requestUrl = normalizeHttpUrl(route.request().url());
      if (!requestUrl || !/\.m3u8(?:$|[?#])|\/hls\/|\/stream\/|\/live\/|amazonaws/i.test(requestUrl)) {
        await route.continue().catch(() => {});
        return;
      }
      try {
        const response = await route.fetch();
        const finalUrl = normalizeHttpUrl(response.url() || requestUrl) || requestUrl;
        const body = await response.text().catch(() => "");
        if (!manifestBody && body.trim() && hasMediaSegments(body, finalUrl)) {
          manifestUrl = finalUrl;
          manifestBody = body;
          if (resolveFound) resolveFound();
        }
        await route.fulfill({ response }).catch(() => {});
      } catch {
        await route.continue().catch(() => {});
      }
    });
    const page = await context.newPage();

    page.on("console", (message) => {
      const text = String(message.text() || "");
      const match = text.match(/loadSource:(https?:\/\/\S+)/i);
      const candidate = normalizeHttpUrl(match && match[1] ? match[1] : "");
      if (candidate) {
        manifestUrl = candidate;
      }
    });

    await page.goto(channelUrl, {
      waitUntil: "domcontentloaded",
      timeout: BROWSER_TIMEOUT_MS,
    });
    referrerUrl = normalizeHttpUrl(page.url()) || channelUrl;
    await Promise.race([foundPromise, page.waitForTimeout(8000)]);

    if (!manifestBody && manifestUrl) {
      const browserFetched = await page
        .evaluate(async (url) => {
          const response = await fetch(url, {
            method: "GET",
            credentials: "include",
            cache: "no-store",
            redirect: "follow",
          });
          return {
            ok: response.ok,
            url: response.url || url,
            body: await response.text().catch(() => ""),
          };
        }, manifestUrl)
        .catch(() => null);
      if (browserFetched && browserFetched.ok && hasMediaSegments(browserFetched.body, browserFetched.url || manifestUrl)) {
        manifestUrl = normalizeHttpUrl(browserFetched.url || manifestUrl) || manifestUrl;
        manifestBody = browserFetched.body;
      }
    }

    if (!manifestBody) {
      const iframeSrc = await page
        .evaluate(() => {
          const selectors = [
            "iframe#streamFrame",
            "iframe[src*='albaplayer']",
            "iframe[src*='sportsurges']",
            "iframe[src*='livekora']",
          ];
          for (const selector of selectors) {
            const element = document.querySelector(selector);
            if (!element) continue;
            const value = element.getAttribute("src") || element.getAttribute("data-src") || "";
            if (value) return value;
          }
          return "";
        })
        .catch(() => "");
      const iframeUrl = resolveIframeUrl(iframeSrc, page.url() || channelUrl);
      if (iframeUrl && iframeUrl !== normalizeHttpUrl(page.url())) {
        await page.goto(iframeUrl, {
          waitUntil: "domcontentloaded",
          timeout: BROWSER_TIMEOUT_MS,
        });
        referrerUrl = normalizeHttpUrl(page.url()) || iframeUrl;
        await Promise.race([foundPromise, page.waitForTimeout(8000)]);
        if (!manifestBody && manifestUrl) {
          const browserFetched = await page
            .evaluate(async (url) => {
              const response = await fetch(url, {
                method: "GET",
                credentials: "include",
                cache: "no-store",
                redirect: "follow",
              });
              return {
                ok: response.ok,
                url: response.url || url,
                body: await response.text().catch(() => ""),
              };
            }, manifestUrl)
            .catch(() => null);
          if (browserFetched && browserFetched.ok && hasMediaSegments(browserFetched.body, browserFetched.url || manifestUrl)) {
            manifestUrl = normalizeHttpUrl(browserFetched.url || manifestUrl) || manifestUrl;
            manifestBody = browserFetched.body;
          }
        }
      }
    }

    await page.close().catch(() => {});
    await context.close().catch(() => {});
  } finally {
    await browser.close().catch(() => {});
  }

  console.log(
    JSON.stringify({
      ok: !!manifestUrl && !!manifestBody,
      manifestUrl,
      manifestBody,
      referrerUrl,
      playbackUrl: channelUrl,
    })
  );
}

main().catch((error) => {
  console.log(
    JSON.stringify({
      ok: false,
      error: error instanceof Error ? error.message : String(error || "livekora-direct-failed"),
    })
  );
});
