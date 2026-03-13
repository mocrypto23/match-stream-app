import { isValidHttpUrl } from "./server-source-policy";

const DEFAULT_USER_AGENT =
  "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/145.0.0.0 Safari/537.36";

const ENABLE_BROWSER_EXTRACTION =
  String(process.env.REPACK_PLAYERV2_BROWSER_EXTRACTOR || "1").trim() !== "0";
const SESSION_IDLE_TTL_MS = Math.max(
  20_000,
  Number.parseInt(String(process.env.REPACK_PLAYERV2_SESSION_IDLE_TTL_MS || "120000"), 10) || 120_000
);
const SESSION_STALE_MS = Math.max(
  4_000,
  Number.parseInt(String(process.env.REPACK_PLAYERV2_SESSION_STALE_MS || "18000"), 10) || 18_000
);
const SESSION_PREEMPTIVE_REFRESH_MS = Math.max(
  4_000,
  Math.min(
    SESSION_STALE_MS - 2_000,
    Number.parseInt(String(process.env.REPACK_PLAYERV2_SESSION_PREEMPTIVE_REFRESH_MS || "12000"), 10) || 12_000
  )
);
const SESSION_WAIT_AFTER_GOTO_MS = Math.max(
  1_000,
  Number.parseInt(String(process.env.REPACK_PLAYERV2_BROWSER_WAIT_MS || "3500"), 10) || 3_500
);
const SESSION_RELOAD_COOLDOWN_MS = Math.max(
  2_000,
  Number.parseInt(String(process.env.REPACK_PLAYERV2_SESSION_RELOAD_COOLDOWN_MS || "9000"), 10) || 9_000
);
const SESSION_MAX_COUNT = Math.max(
  2,
  Number.parseInt(String(process.env.REPACK_PLAYERV2_SESSION_MAX_COUNT || "8"), 10) || 8
);
const SESSION_MAX_CANDIDATES = Math.max(
  4,
  Number.parseInt(String(process.env.REPACK_PLAYERV2_SESSION_MAX_CANDIDATES || "24"), 10) || 24
);
const SESSION_MAINTENANCE_INTERVAL_MS = Math.max(
  1_500,
  Number.parseInt(String(process.env.REPACK_PLAYERV2_SESSION_MAINTENANCE_INTERVAL_MS || "4000"), 10) || 4_000
);
const SESSION_MAINTENANCE_TIMEOUT_MS = Math.max(
  8_000,
  Number.parseInt(String(process.env.REPACK_PLAYERV2_SESSION_MAINTENANCE_TIMEOUT_MS || "18000"), 10) || 18_000
);
const SESSION_STALE_RETURN_MAX_AGE_MS = Math.max(
  SESSION_STALE_MS + 6_000,
  Number.parseInt(String(process.env.REPACK_PLAYERV2_SESSION_STALE_RETURN_MAX_AGE_MS || "42000"), 10) || 42_000
);

type LiveCandidate = {
  ingestUrl: string;
  targetUrl: string;
  referrerUrl: string;
  manifestBody?: string;
  manifestBaseUrl?: string;
  seenAt: number;
};

type BrowserCandidateResult = {
  ok: boolean;
  candidates: LiveCandidate[];
  error: string;
};

type BrowserStringCandidateResult = {
  ok: boolean;
  candidates: string[];
  error: string;
};

type PlaywrightBrowser = {
  newContext: (input: unknown) => Promise<PlaywrightContext>;
};

type PlaywrightContext = {
  newPage: () => Promise<PlaywrightPage>;
  close: () => Promise<void>;
};

type PlaywrightPage = {
  on: (event: string, handler: (arg: unknown) => void) => void;
  evaluate: <T, Arg = unknown>(pageFunction: string | ((arg: Arg) => T | Promise<T>), arg?: Arg) => Promise<T>;
  goto: (url: string, options: unknown) => Promise<unknown>;
  waitForLoadState?: (state: string, options?: { timeout?: number }) => Promise<void>;
  waitForTimeout: (ms: number) => Promise<void>;
  close: () => Promise<void>;
  isClosed?: () => boolean;
};

let browserPromise: Promise<unknown> | null = null;
const sessions = new Map<string, LivePlayerv2Session>();

function normalizeHttpUrl(raw: unknown) {
  const value = String(raw || "").trim();
  if (!value || !isValidHttpUrl(value)) return "";
  return value;
}

function canonicalizeUrl(raw: string) {
  if (!isValidHttpUrl(raw)) return "";
  try {
    const u = new URL(raw);
    u.hash = "";
    if ((u.protocol === "http:" && u.port === "80") || (u.protocol === "https:" && u.port === "443")) {
      u.port = "";
    }
    if (u.pathname !== "/") u.pathname = u.pathname.replace(/\/+$/, "");
    return u.toString().toLowerCase();
  } catch {
    return String(raw || "").trim().toLowerCase();
  }
}

function buildInternalEmbedProxyUrl(input: {
  sourceUrl: string;
  requestOrigin: string;
  referrerUrl?: string | null;
}) {
  if (!isValidHttpUrl(input.sourceUrl) || !isValidHttpUrl(input.requestOrigin)) return "";
  const params = new URLSearchParams();
  params.set("url", input.sourceUrl);
  params.set("depth", "0");
  params.set("backend", "1");
  const ref = normalizeHttpUrl(input.referrerUrl || input.sourceUrl);
  if (ref) params.set("ref", ref);
  return `${String(input.requestOrigin || "").replace(/\/+$/, "")}/api/embed-proxy?${params.toString()}`;
}

function buildStablePlaybackProxyUrl(input: {
  sourceUrl: string;
  requestOrigin: string;
  referrerUrl?: string | null;
}) {
  if (!isValidHttpUrl(input.sourceUrl) || !isValidHttpUrl(input.requestOrigin)) return "";
  const params = new URLSearchParams();
  params.set("url", input.sourceUrl);
  params.set("depth", "0");
  params.set("stable", "1");
  const ref = normalizeHttpUrl(input.referrerUrl || input.sourceUrl);
  if (ref) params.set("ref", ref);
  return `${String(input.requestOrigin || "").replace(/\/+$/, "")}/api/embed-proxy?${params.toString()}`;
}

function looksLikePlayerv2ManifestCandidate(rawUrl: string) {
  if (!isValidHttpUrl(rawUrl)) return false;
  try {
    const u = new URL(rawUrl);
    const host = u.hostname.toLowerCase();
    const pathname = String(u.pathname || "").toLowerCase();
    return (host.endsWith(".yallashot.us") || host === "yallashot.us") && pathname.includes("/kooora/");
  } catch {
    return false;
  }
}

function safeOriginWithSlash(rawUrl: string) {
  if (!isValidHttpUrl(rawUrl)) return "";
  try {
    const u = new URL(rawUrl);
    return `${u.origin}/`;
  } catch {
    return "";
  }
}

function looksLikeManifestResponse(contentType: string, body: string, finalUrl: string) {
  const ct = String(contentType || "").toLowerCase();
  const text = String(body || "");
  const url = String(finalUrl || "").toLowerCase();
  if (/^\s*#extm3u/m.test(text)) return true;
  if (ct.includes("application/vnd.apple.mpegurl") || ct.includes("application/x-mpegurl")) return true;
  return url.includes(".m3u8") || url.includes("/kooora/");
}

function sortCandidates(candidates: LiveCandidate[]) {
  return [...candidates].sort((left, right) => {
    if (!!right.manifestBody !== !!left.manifestBody) return right.manifestBody ? 1 : -1;
    return right.seenAt - left.seenAt;
  });
}

async function loadBrowser() {
  if (!browserPromise) {
    browserPromise = (async () => {
      const { chromium } = (await import("playwright")) as { chromium: { launch: (input: unknown) => Promise<unknown> } };
      return chromium.launch({
        headless: true,
        args: ["--disable-dev-shm-usage", "--disable-blink-features=AutomationControlled", "--no-sandbox"],
      });
    })().catch((error) => {
      browserPromise = null;
      throw error;
    });
  }
  return browserPromise;
}

async function sleep(ms: number) {
  await new Promise((resolve) => setTimeout(resolve, ms));
}

class LivePlayerv2Session {
  key: string;
  sourceUrl: string;
  navigationUrl: string;
  requestOrigin: string;
  fallbackReferrer: string;
  lastTouchedAt = Date.now();
  lastActivityAt = 0;
  lastReloadAt = 0;
  lastError = "";
  state: "starting" | "running" | "closed" = "starting";
  browserContext: PlaywrightContext | null = null;
  page: PlaywrightPage | null = null;
  startPromise: Promise<void> | null = null;
  reloadPromise: Promise<void> | null = null;
  maintenancePromise: Promise<void> | null = null;
  maintenanceTimer: ReturnType<typeof setInterval> | null = null;
  candidates = new Map<string, LiveCandidate>();

  constructor(input: { sourceUrl: string; requestOrigin: string }) {
    this.sourceUrl = normalizeHttpUrl(input.sourceUrl);
    this.requestOrigin = normalizeHttpUrl(input.requestOrigin);
    this.navigationUrl =
      buildStablePlaybackProxyUrl({
        sourceUrl: this.sourceUrl,
        requestOrigin: this.requestOrigin,
        referrerUrl: this.sourceUrl,
      }) || this.sourceUrl;
    this.fallbackReferrer = this.sourceUrl || safeOriginWithSlash(this.sourceUrl);
    this.key = `${canonicalizeUrl(this.sourceUrl)}|${canonicalizeUrl(this.requestOrigin)}`;
  }

  touch() {
    this.lastTouchedAt = Date.now();
  }

  isIdle(now = Date.now()) {
    return now - this.lastTouchedAt > SESSION_IDLE_TTL_MS;
  }

  hasFreshCandidate(now = Date.now()) {
    return Array.from(this.candidates.values()).some((candidate) => now - candidate.seenAt <= SESSION_STALE_MS);
  }

  newestCandidateAgeMs(now = Date.now()) {
    let newestAgeMs: number | null = null;
    for (const candidate of this.candidates.values()) {
      const ageMs = Math.max(0, now - candidate.seenAt);
      newestAgeMs = newestAgeMs === null ? ageMs : Math.min(newestAgeMs, ageMs);
    }
    return newestAgeMs;
  }

  snapshotCandidates() {
    return sortCandidates(Array.from(this.candidates.values())).slice(0, SESSION_MAX_CANDIDATES);
  }

  snapshotCandidatesWithManifestBody(maxAgeMs: number, now = Date.now()) {
    return this.snapshotCandidates().filter((candidate) => {
      if (!candidate.manifestBody) return false;
      return Math.max(0, now - candidate.seenAt) <= maxAgeMs;
    });
  }

  rememberCandidate(input: {
    targetUrl: string;
    referrerUrl?: string | null;
    manifestBody?: string;
    manifestBaseUrl?: string;
  }) {
    const targetUrl = normalizeHttpUrl(input.targetUrl);
    if (!looksLikePlayerv2ManifestCandidate(targetUrl)) return;
    const referrerUrl = normalizeHttpUrl(input.referrerUrl || this.fallbackReferrer) || this.fallbackReferrer;
    const ingestUrl = buildInternalEmbedProxyUrl({
      sourceUrl: targetUrl,
      requestOrigin: this.requestOrigin,
      referrerUrl,
    });
    if (!ingestUrl) return;

    const key = canonicalizeUrl(ingestUrl) || ingestUrl.toLowerCase();
    if (!key) return;
    const now = Date.now();
    const manifestBody = String(input.manifestBody || "").trim() || undefined;
    const manifestBaseUrl = normalizeHttpUrl(input.manifestBaseUrl || targetUrl) || targetUrl;
    const existing = this.candidates.get(key);
    this.candidates.set(key, {
      ingestUrl,
      targetUrl,
      referrerUrl,
      manifestBody: manifestBody || existing?.manifestBody,
      manifestBaseUrl: manifestBody ? manifestBaseUrl : existing?.manifestBaseUrl,
      seenAt: now,
    });
    this.lastActivityAt = now;
    this.lastError = "";

    const orderedKeys = sortCandidates(Array.from(this.candidates.values()))
      .slice(SESSION_MAX_CANDIDATES)
      .map((candidate) => canonicalizeUrl(candidate.ingestUrl) || candidate.ingestUrl.toLowerCase());
    for (const staleKey of orderedKeys) this.candidates.delete(staleKey);
  }

  async handleResponse(responseArg: unknown) {
    try {
      const response = responseArg as {
        url: () => string;
        headers?: () => Record<string, string>;
        request?: () => { headers?: () => Record<string, string> };
        text?: () => Promise<string>;
      };
      const responseUrl = normalizeHttpUrl(response.url());
      if (!responseUrl) return;
      const requestHeaders =
        typeof response.request === "function" && typeof response.request()?.headers === "function"
          ? response.request()?.headers?.() || {}
          : {};
      const referrerUrl =
        normalizeHttpUrl(String(requestHeaders?.referer || requestHeaders?.referrer || "").trim()) || this.fallbackReferrer;

      if (!looksLikePlayerv2ManifestCandidate(responseUrl)) return;
      const rawHeaders = typeof response.headers === "function" ? response.headers() : {};
      const contentType = String(rawHeaders?.["content-type"] || rawHeaders?.["Content-Type"] || "").toLowerCase();
      const body = typeof response.text === "function" ? await response.text().catch(() => "") : "";
      this.rememberCandidate({
        targetUrl: responseUrl,
        referrerUrl,
        manifestBody: looksLikeManifestResponse(contentType, body, responseUrl) ? body : undefined,
        manifestBaseUrl: responseUrl,
      });
    } catch (error) {
      this.lastError = error instanceof Error ? error.message : String(error || "response-capture-failed");
    }
  }

  bindPage(page: PlaywrightPage) {
    page.on("request", (requestArg: unknown) => {
      try {
        const request = requestArg as {
          method: () => string;
          url: () => string;
          headers: () => Record<string, string>;
        };
        if (request.method() !== "GET") return;
        const requestUrl = normalizeHttpUrl(request.url());
        if (!looksLikePlayerv2ManifestCandidate(requestUrl)) return;
        const requestHeaders = request.headers();
        const referrerUrl =
          normalizeHttpUrl(String(requestHeaders?.referer || requestHeaders?.referrer || "").trim()) || this.fallbackReferrer;
        this.rememberCandidate({
          targetUrl: requestUrl,
          referrerUrl,
        });
      } catch (error) {
        this.lastError = error instanceof Error ? error.message : String(error || "request-capture-failed");
      }
    });

    page.on("response", (responseArg: unknown) => {
      void this.handleResponse(responseArg);
    });

    page.on("close", () => {
      this.state = "closed";
      this.page = null;
      this.browserContext = null;
      this.lastError = this.lastError || "page-closed";
    });
  }

  async openFreshPage(timeoutMs: number) {
    await this.close();
    const browser = (await loadBrowser()) as PlaywrightBrowser;
    const context = await browser.newContext({
      ignoreHTTPSErrors: true,
      locale: "ar-EG",
      userAgent: DEFAULT_USER_AGENT,
      viewport: { width: 1365, height: 850 },
      extraHTTPHeaders: {
        "accept-language": "ar,en-US;q=0.9,en;q=0.8",
      },
    });
    const page = await context.newPage();
    this.browserContext = context;
    this.page = page;
    this.state = "starting";
    this.bindPage(page);
    await page.goto(this.navigationUrl, {
      waitUntil: "domcontentloaded",
      timeout: Math.max(6_000, Math.min(30_000, timeoutMs)),
    });
    if (typeof page.waitForLoadState === "function") {
      await page
        .waitForLoadState("networkidle", {
          timeout: Math.max(1_500, Math.min(8_000, SESSION_WAIT_AFTER_GOTO_MS + 2_000)),
        })
        .catch(() => {});
    }
    await page.waitForTimeout(Math.max(1_000, Math.min(8_000, SESSION_WAIT_AFTER_GOTO_MS)));
    await this.hydrateCandidateBodiesInPage();
    this.lastReloadAt = Date.now();
    this.state = "running";
  }

  async ensureStarted(timeoutMs: number) {
    this.touch();
    if (this.page && !this.page.isClosed?.()) return;
    if (!this.startPromise) {
      this.startPromise = this.openFreshPage(timeoutMs)
        .catch((error) => {
          this.lastError = error instanceof Error ? error.message : String(error || "browser-extraction-failed");
          this.state = "closed";
          throw error;
        })
        .finally(() => {
          this.startPromise = null;
        });
    }
    await this.startPromise;
    this.startMaintenanceLoop();
  }

  async maybeReload(timeoutMs: number) {
    this.touch();
    const now = Date.now();
    if (this.reloadPromise) return this.reloadPromise;
    if (now - this.lastReloadAt < SESSION_RELOAD_COOLDOWN_MS) return;
    this.reloadPromise = this.openFreshPage(timeoutMs)
      .catch((error) => {
        this.lastError = error instanceof Error ? error.message : String(error || "browser-reload-failed");
        throw error;
      })
      .finally(() => {
        this.reloadPromise = null;
      });
    await this.reloadPromise;
  }

  startMaintenanceLoop() {
    if (this.maintenanceTimer) return;
    this.maintenanceTimer = setInterval(() => {
      void this.maintain();
    }, SESSION_MAINTENANCE_INTERVAL_MS);
  }

  async maintain() {
    if (this.maintenancePromise) return this.maintenancePromise;
    this.maintenancePromise = this.performMaintenance().finally(() => {
      this.maintenancePromise = null;
    });
    return this.maintenancePromise;
  }

  async performMaintenance() {
    if (this.state === "closed") return;
    if (this.isIdle()) {
      await this.close();
      return;
    }
    const page = this.page;
    if (!page || page.isClosed?.()) return;

    const now = Date.now();
    const manifestCandidates = this.snapshotCandidatesWithManifestBody(SESSION_STALE_MS, now);
    const allCandidates = this.snapshotCandidates();
    const newestAgeMs = this.newestCandidateAgeMs(now);
    if (!manifestCandidates.length && allCandidates.length) {
      await this.hydrateCandidateBodiesInPage();
    }

    const refreshedNow = Date.now();
    const refreshedManifestCandidates = this.snapshotCandidatesWithManifestBody(SESSION_STALE_MS, refreshedNow);
    const refreshedNewestAgeMs = this.newestCandidateAgeMs(refreshedNow);
    const shouldReload =
      !refreshedManifestCandidates.length ||
      refreshedNewestAgeMs === null ||
      refreshedNewestAgeMs >= SESSION_PREEMPTIVE_REFRESH_MS ||
      !this.hasFreshCandidate(refreshedNow);
    if (shouldReload && refreshedNow - this.lastReloadAt >= SESSION_RELOAD_COOLDOWN_MS) {
      await this.maybeReload(SESSION_MAINTENANCE_TIMEOUT_MS).catch(() => {});
    }
  }

  async hydrateCandidateBodiesInPage() {
    const page = this.page;
    if (!page || page.isClosed?.()) return;
    const pendingTargets = this.snapshotCandidates()
      .filter((candidate) => !candidate.manifestBody)
      .slice(0, 3)
      .map((candidate) => candidate.targetUrl)
      .filter((targetUrl) => looksLikePlayerv2ManifestCandidate(targetUrl));
    if (!pendingTargets.length) return;

    try {
      const fetched = await page.evaluate(
        async (urls: string[]) => {
          const out: Array<{ targetUrl: string; finalUrl: string; status: number; body: string }> = [];
          for (const targetUrl of urls) {
            try {
              const controller = new AbortController();
              const timeoutId = window.setTimeout(() => controller.abort(), 5000);
              const response = await fetch(targetUrl, {
                method: "GET",
                cache: "no-store",
                credentials: "include",
                signal: controller.signal,
                headers: {
                  accept: "application/vnd.apple.mpegurl,application/x-mpegurl,text/plain,*/*",
                },
              }).finally(() => window.clearTimeout(timeoutId));
              const body = await response.text().catch(() => "");
              out.push({
                targetUrl,
                finalUrl: String(response.url || targetUrl),
                status: Number(response.status || 0),
                body,
              });
            } catch {
              out.push({
                targetUrl,
                finalUrl: targetUrl,
                status: 0,
                body: "",
              });
            }
          }
          return out;
        },
        pendingTargets
      );

      for (const item of Array.isArray(fetched) ? fetched : []) {
        const targetUrl = normalizeHttpUrl(String(item?.targetUrl || "").trim());
        const finalUrl = normalizeHttpUrl(String(item?.finalUrl || targetUrl).trim()) || targetUrl;
        const body = String(item?.body || "").trim();
        const status = Number(item?.status || 0);
        if (!targetUrl || status < 200 || status >= 300) continue;
        if (!looksLikeManifestResponse("application/vnd.apple.mpegurl", body, finalUrl)) continue;
        this.rememberCandidate({
          targetUrl,
          referrerUrl: this.fallbackReferrer,
          manifestBody: body,
          manifestBaseUrl: finalUrl,
        });
      }
    } catch (error) {
      this.lastError = error instanceof Error ? error.message : String(error || "candidate-body-hydration-failed");
    }
  }

  async snapshot(timeoutMs: number): Promise<BrowserCandidateResult> {
    if (!ENABLE_BROWSER_EXTRACTION) {
      return { ok: false, candidates: [], error: "browser-extractor-disabled" };
    }
    if (!this.sourceUrl || !this.requestOrigin) {
      return { ok: false, candidates: [], error: "invalid-browser-extractor-input" };
    }

    try {
      await this.ensureStarted(timeoutMs);
      await this.maintain();
    } catch {
      return { ok: false, candidates: [], error: this.lastError || "browser-extraction-failed" };
    }

    const deadline = Date.now() + Math.max(2_500, Math.min(25_000, timeoutMs));
    while (Date.now() < deadline) {
      this.touch();
      const now = Date.now();
      const candidates = this.snapshotCandidates();
      const freshManifestCandidates = this.snapshotCandidatesWithManifestBody(SESSION_STALE_MS, now);
      const reusableManifestCandidates = this.snapshotCandidatesWithManifestBody(SESSION_STALE_RETURN_MAX_AGE_MS, now);
      const newestAgeMs = this.newestCandidateAgeMs(now);
      if (freshManifestCandidates.length) {
        return { ok: true, candidates, error: "" };
      }
      if (
        reusableManifestCandidates.length &&
        candidates.length &&
        newestAgeMs !== null &&
        newestAgeMs <= SESSION_PREEMPTIVE_REFRESH_MS
      ) {
        return { ok: true, candidates, error: "" };
      }
      const shouldReload =
        !candidates.length ||
        newestAgeMs === null ||
        newestAgeMs >= SESSION_PREEMPTIVE_REFRESH_MS ||
        !this.hasFreshCandidate(now);
      if (!freshManifestCandidates.length && candidates.length) {
        await this.hydrateCandidateBodiesInPage();
      }
      if (shouldReload && now - this.lastReloadAt >= SESSION_RELOAD_COOLDOWN_MS) {
        await this.maybeReload(timeoutMs).catch(() => {});
      }
      if (this.page && !this.page.isClosed?.()) {
        await this.page.waitForTimeout(350);
      } else {
        await sleep(350);
      }
    }

    const staleCandidates = this.snapshotCandidates();
    const staleManifestCandidates = this.snapshotCandidatesWithManifestBody(SESSION_STALE_RETURN_MAX_AGE_MS);
    const newestAgeMs = this.newestCandidateAgeMs();
    if (staleManifestCandidates.length) {
      return { ok: true, candidates: staleCandidates, error: "" };
    }
    if (staleCandidates.length && newestAgeMs !== null && newestAgeMs <= SESSION_STALE_RETURN_MAX_AGE_MS) {
      return { ok: false, candidates: staleCandidates, error: this.lastError || "browser-manifest-body-missing" };
    }
    return { ok: false, candidates: [], error: this.lastError || "browser-extraction-empty" };
  }

  async close() {
    const page = this.page;
    const context = this.browserContext;
    if (this.maintenanceTimer) clearInterval(this.maintenanceTimer);
    this.maintenanceTimer = null;
    this.page = null;
    this.browserContext = null;
    this.state = "closed";
    if (page) await page.close().catch(() => {});
    if (context) await context.close().catch(() => {});
  }
}

function cleanupIdleSessions() {
  const now = Date.now();
  for (const [key, session] of sessions.entries()) {
    if (!session.isIdle(now)) continue;
    sessions.delete(key);
    void session.close();
  }

  if (sessions.size <= SESSION_MAX_COUNT) return;
  const overflow = [...sessions.values()]
    .sort((left, right) => left.lastTouchedAt - right.lastTouchedAt)
    .slice(0, sessions.size - SESSION_MAX_COUNT);
  for (const session of overflow) {
    sessions.delete(session.key);
    void session.close();
  }
}

function getSession(input: { sourceUrl: string; requestOrigin: string }) {
  cleanupIdleSessions();
  const sourceUrl = normalizeHttpUrl(input.sourceUrl);
  const requestOrigin = normalizeHttpUrl(input.requestOrigin);
  const key = `${canonicalizeUrl(sourceUrl)}|${canonicalizeUrl(requestOrigin)}`;
  let session = sessions.get(key);
  if (!session) {
    session = new LivePlayerv2Session({ sourceUrl, requestOrigin });
    sessions.set(key, session);
  }
  session.touch();
  return session;
}

export async function extractPlayerv2BrowserSnapshot(input: {
  sourceUrl: string;
  requestOrigin: string;
  timeoutMs: number;
}) {
  const session = getSession(input);
  return session.snapshot(input.timeoutMs);
}

export async function extractPlayerv2BrowserCandidates(input: {
  sourceUrl: string;
  requestOrigin: string;
  timeoutMs: number;
}): Promise<BrowserStringCandidateResult> {
  const result = await extractPlayerv2BrowserSnapshot(input);
  return {
    ok: result.ok,
    candidates: result.candidates.map((candidate) => candidate.ingestUrl),
    error: result.error,
  };
}
