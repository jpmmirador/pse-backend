/**
 * PSE Investor Hub — Backend Server
 * Express REST API + Daily Cron Scraper
 *
 * Endpoints:
 *   GET /api/stocks          — All PSE stock prices (live)
 *   GET /api/dividends       — Dividend disclosures from PSE Edge
 *   GET /api/disclosures     — General company disclosures
 *   GET /api/index           — PSEi index value
 *   GET /api/status          — Server & scrape status
 *   POST /api/scrape         — Trigger manual scrape (auth protected)
 *   GET /api/health          — Health check
 */

require("dotenv").config();
const express = require("express");
const cors = require("cors");
const cron = require("node-cron");
const path = require("path");

const {
  runFullScrape,
  scrapeLivePrices,
  scrapeDividendDisclosures,
  loadData,
} = require("./scraper");

const app = express();
const PORT = process.env.PORT || 3001;
const SCRAPE_SECRET = process.env.SCRAPE_SECRET || "pse-secret-2026";

// ─── MIDDLEWARE ───────────────────────────────────────────────────────────────
app.use(express.json());
app.use(
  cors({
    // Allow your frontend domain — change this when you deploy
    origin: process.env.ALLOWED_ORIGIN || "*",
    methods: ["GET", "POST"],
  })
);

// Request logger
app.use((req, res, next) => {
  console.log(`${new Date().toISOString()} ${req.method} ${req.path}`);
  next();
});

// ─── HELPERS ─────────────────────────────────────────────────────────────────
function sendData(res, filename, label) {
  const result = loadData(filename);
  if (!result) {
    return res.status(503).json({
      error: `${label} not available yet. Run a scrape first.`,
      hint: "POST /api/scrape with your secret key to trigger a manual scrape.",
    });
  }
  res.json({
    success: true,
    updatedAt: result.updatedAt,
    count: Array.isArray(result.data) ? result.data.length : 1,
    data: result.data,
  });
}

function ageMinutes(updatedAt) {
  if (!updatedAt) return null;
  return Math.floor((Date.now() - new Date(updatedAt).getTime()) / 60000);
}

// ─── API ROUTES ───────────────────────────────────────────────────────────────

// Health check
app.get("/api/health", (req, res) => {
  res.json({ status: "ok", timestamp: new Date().toISOString(), uptime: process.uptime() });
});

// Server & scrape status
app.get("/api/status", (req, res) => {
  const stocks = loadData("stocks.json");
  const dividends = loadData("dividends.json");
  const disclosures = loadData("disclosures.json");
  const pseiIndex = loadData("pseiIndex.json");
  const scrapeLog = loadData("scrapeLog.json");

  res.json({
    server: { status: "online", uptime: `${Math.floor(process.uptime() / 60)} min` },
    schedule: {
      prices: "Every 5 min during market hours (9:00–16:00 PHT Mon–Fri)",
      dividends: "Daily at 7:00 AM PHT",
      disclosures: "Daily at 7:30 AM PHT",
    },
    data: {
      stocks: {
        available: !!stocks,
        count: stocks?.data?.length || 0,
        updatedAt: stocks?.updatedAt,
        ageMinutes: ageMinutes(stocks?.updatedAt),
      },
      dividends: {
        available: !!dividends,
        count: dividends?.data?.length || 0,
        updatedAt: dividends?.updatedAt,
        ageMinutes: ageMinutes(dividends?.updatedAt),
      },
      disclosures: {
        available: !!disclosures,
        count: disclosures?.data?.length || 0,
        updatedAt: disclosures?.updatedAt,
      },
      pseiIndex: {
        available: !!pseiIndex,
        value: pseiIndex?.data?.value,
        change: pseiIndex?.data?.change,
        updatedAt: pseiIndex?.updatedAt,
      },
    },
    lastScrape: scrapeLog?.data || null,
  });
});

// All stock prices
app.get("/api/stocks", (req, res) => {
  const result = loadData("stocks.json");
  if (!result) {
    // Auto-trigger a scrape if no data yet
    scrapeLivePrices().catch(console.error);
    return res.status(202).json({ message: "Scraping in progress, try again in 15 seconds." });
  }
  const { symbol, sector } = req.query;
  let data = result.data;
  if (symbol) data = data.filter((s) => s.symbol.toUpperCase() === symbol.toUpperCase());
  if (sector) data = data.filter((s) => s.sector?.toLowerCase() === sector.toLowerCase());
  res.json({ success: true, updatedAt: result.updatedAt, count: data.length, data });
});

// Single stock
app.get("/api/stocks/:symbol", (req, res) => {
  const result = loadData("stocks.json");
  if (!result) return res.status(503).json({ error: "No stock data available yet." });
  const stock = result.data.find(
    (s) => s.symbol.toUpperCase() === req.params.symbol.toUpperCase()
  );
  if (!stock) return res.status(404).json({ error: `Symbol ${req.params.symbol} not found.` });
  res.json({ success: true, updatedAt: result.updatedAt, data: stock });
});

// PSEi Index
app.get("/api/index", (req, res) => sendData(res, "pseiIndex.json", "PSEi index"));

// Dividend disclosures
app.get("/api/dividends", (req, res) => {
  const result = loadData("dividends.json");
  if (!result) return res.status(503).json({ error: "No dividend data yet. Scrape runs daily at 7AM PHT." });
  const { symbol, upcoming } = req.query;
  let data = result.data;
  if (symbol) data = data.filter((d) => d.symbol?.toUpperCase() === symbol.toUpperCase());
  if (upcoming === "true") {
    const today = new Date().toISOString().split("T")[0];
    data = data.filter((d) => d.exDate && d.exDate >= today);
  }
  res.json({ success: true, updatedAt: result.updatedAt, count: data.length, data });
});

// General disclosures
app.get("/api/disclosures", (req, res) => {
  const result = loadData("disclosures.json");
  if (!result) return res.status(503).json({ error: "No disclosures yet." });
  const { symbol, category } = req.query;
  let data = result.data;
  if (symbol) data = data.filter((d) => d.symbol?.toUpperCase() === symbol.toUpperCase());
  if (category) data = data.filter((d) => d.category?.toLowerCase() === category.toLowerCase());
  res.json({ success: true, updatedAt: result.updatedAt, count: data.length, data });
});

// Manual scrape trigger (protected)
app.post("/api/scrape", async (req, res) => {
  const { secret, type } = req.body;
  if (secret !== SCRAPE_SECRET) {
    return res.status(401).json({ error: "Invalid secret key." });
  }

  // Run in background — don't wait
  res.json({ message: `Scrape triggered for: ${type || "all"}. Check /api/status for progress.` });

  try {
    if (type === "stocks") await scrapeLivePrices();
    else if (type === "dividends") await scrapeDividendDisclosures();
    else await runFullScrape();
  } catch (err) {
    console.error("Manual scrape error:", err.message);
  }
});

// ─── CRON SCHEDULES (PHT = UTC+8) ────────────────────────────────────────────
// Prices: every 5 min on weekdays during market hours (1:00–8:00 UTC = 9AM–4PM PHT)
cron.schedule("*/5 1-8 * * 1-5", async () => {
  console.log("⏰ Cron: Refreshing live prices...");
  await scrapeLivePrices();
}, { timezone: "Asia/Manila" });

// Dividend disclosures: daily at 7:00 AM PHT
cron.schedule("0 7 * * *", async () => {
  console.log("⏰ Cron: Scraping dividend disclosures...");
  const { scrapeDividendDisclosures, scrapePSEiIndex } = require("./scraper");
  await scrapeDividendDisclosures();
  await scrapePSEiIndex();
}, { timezone: "Asia/Manila" });

// Full scrape: daily at 7:30 AM PHT (after market pre-open)
cron.schedule("30 7 * * 1-5", async () => {
  console.log("⏰ Cron: Running full scrape...");
  await runFullScrape();
}, { timezone: "Asia/Manila" });

// Weekly deep scrape on Sunday 6 AM (catches any missed disclosures)
cron.schedule("0 6 * * 0", async () => {
  console.log("⏰ Cron: Weekly deep scrape...");
  await runFullScrape();
}, { timezone: "Asia/Manila" });

// ─── START SERVER ─────────────────────────────────────────────────────────────
app.listen(PORT, () => {
  console.log(`\n🚀 PSE Investor Hub Backend`);
  console.log(`   Running on: http://localhost:${PORT}`);
  console.log(`   API base:   http://localhost:${PORT}/api`);
  console.log(`   Status:     http://localhost:${PORT}/api/status`);
  console.log(`\n📅 Cron schedules (PHT):`);
  console.log(`   Prices    → Every 5 min, Mon–Fri 9AM–4PM`);
  console.log(`   Dividends → Daily 7:00 AM`);
  console.log(`   Full      → Weekdays 7:30 AM`);
  console.log(`   Deep      → Sundays 6:00 AM`);
  console.log(`\n🔄 Running initial scrape...`);
  runFullScrape().catch(console.error);
});
