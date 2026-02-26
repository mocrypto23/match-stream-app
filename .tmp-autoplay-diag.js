const { chromium } = require('playwright');

(async () => {
  const browser = await chromium.launch({ headless: true, args: ['--autoplay-policy=user-gesture-required'] });
  const context = await browser.newContext();
  const page = await context.newPage();

  page.on('console', (msg) => {
    const type = msg.type();
    if (type === 'error' || type === 'warning') {
      console.log(`[console:${type}] ${msg.text()}`);
    }
  });

  await page.goto('https://tf-player.site/watch/36418', { waitUntil: 'domcontentloaded', timeout: 120000 });
  await page.waitForTimeout(8000);

  const timeline = await page.evaluate(async () => {
    const v = document.querySelector('video');
    if (!v) return { found: false };
    const events = [];
    const names = ['play','playing','pause','waiting','stalled','canplay','canplaythrough','loadeddata','timeupdate','error'];
    const start = performance.now();
    const state = () => ({
      t: Number(v.currentTime || 0),
      paused: v.paused,
      muted: v.muted,
      volume: v.volume,
      readyState: v.readyState,
      networkState: v.networkState,
      ended: v.ended,
    });
    for (const n of names) {
      v.addEventListener(n, () => {
        events.push({ at: Math.round(performance.now() - start), ev: n, ...state() });
      });
    }
    events.push({ at: 0, ev: 'snapshot', ...state() });
    for (let i = 1; i <= 20; i++) {
      await new Promise((r) => setTimeout(r, 500));
      events.push({ at: Math.round(performance.now() - start), ev: 'poll', ...state() });
    }
    return { found: true, events };
  });

  console.log(JSON.stringify(timeline, null, 2));
  await browser.close();
})();
