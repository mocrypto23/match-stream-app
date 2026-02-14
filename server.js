const express = require("express");
const { startScraping } = require("./scraper");

const app = express();
const port = Number.parseInt(process.env.PORT || "8080", 10);

let activeRun = null;

async function triggerScraper(_req, res) {
  if (activeRun) {
    return res.status(200).send("Scraper is already running.");
  }

  activeRun = (async () => {
    try {
      await startScraping();
    } finally {
      activeRun = null;
    }
  })();

  try {
    await activeRun;
    return res.status(200).send("Scraper completed successfully.");
  } catch (err) {
    const message = err?.message || String(err);
    return res.status(500).send(`Scraper failed: ${message}`);
  }
}

// Cloud Scheduler commonly calls POST, while manual checks use GET.
app.get("/", triggerScraper);
app.post("/", triggerScraper);
app.get("/run", triggerScraper);
app.post("/run", triggerScraper);

app.get("/healthz", (_req, res) => {
  res.status(200).send("ok");
});

app.listen(port, () => {
  console.log(`Scraper server listening on port ${port}`);
});
