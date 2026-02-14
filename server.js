const express = require("express");
const { startScraping } = require("./scraper");

const app = express();
const port = Number.parseInt(process.env.PORT || "8080", 10);

let activeRun = null;

app.get("/", async (_req, res) => {
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
});

app.get("/healthz", (_req, res) => {
  res.status(200).send("ok");
});

app.listen(port, () => {
  console.log(`Scraper server listening on port ${port}`);
});
