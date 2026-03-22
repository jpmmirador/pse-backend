require("dotenv").config();
const express = require("express");
const cors = require("cors");
const cron = require("node-cron");
const { runFullScrape, scrapeLivePrices, scrapeDividendDisclosures, loadData } = require("./scraper");

const app = express();
const PORT = process.env.PORT || 3001;
const SCRAPE_SECRET = process.env.SCRAPE_SECRET || "pse-secret-2026";

app.use(express.json());
app.use(cors({ origin: process.env.ALLOWED_ORIGIN || "*" }));
app.use((req, res, next) => { console.log(`${new Date().toISOString()} ${req.method} ${req.path}`); next(); });

function sendData(res, filename, label) {
  const result = loadData(filename);
  if (!result) return res.status(503).json({ error: `${label} not available yet.` });
  res.json({ success: true, updatedAt: result.updatedAt, count: Array.isArray(result.data) ? result.data.length : 1, data: result.data });
}

function ageMinutes(updatedAt) {
  if (!updatedAt) return null;
  return Math.floor((Date.now() - new Date(updatedAt).getTime()) / 60000);
}

app.get("/ping", (req, res) => res.send("pong"));

app.get("/api/health", (req, res) => res.json({ status: "ok", timestamp: new Date().toISOString(), uptime: process.uptime() }));

app.get("/api/status", (req, res) => {
  const stocks = loadData("stocks.json");
  const dividends = loadData("dividends.json");
  const disclosures = loadData("disclosures.json");
  const pseiIndex = loadData("pseiIndex.json");
  const scrapeLog = loadData("scrapeLog.json");
  res.json({
    server: { status: "online", uptime: `${Math.floor(process.uptime() / 60)} min` },
    schedule: { prices: "Every 5 min during market hours", dividends: "Daily at 7:00 AM PHT", disclosures: "Daily at 7:30 AM PHT" },
    data: {
      stocks: { available: !!stocks, count: stocks?.data?.length || 0, updatedAt: stocks?.updatedAt, ageMinutes: ageMinutes(stocks?.updatedAt) },
      dividends: { available: !!dividends, count: dividends?.data?.length || 0, updatedAt: dividends?.updatedAt },
      disclosures: { available: !!disclosures, count: disclosures?.data?.length || 0, updatedAt: disclosures?.updatedAt },
      pseiIndex: { available: !!pseiIndex, value: pseiIndex?.data?.value, updatedAt: pseiIndex?.updatedAt },
    },
    lastScrape: scrapeLog?.data || null,
  });
});

app.get("/api/stocks", (req, res) => {
  const result = loadData("stocks.json");
  if (!result) { scrapeLivePrices().catch(console.error); return res.status(202).json({ message: "Scraping in progress, try again in 15 seconds." }); }
  let data = result.data;
  if (req.query.symbol) data = data.filter(s => s.symbol.toUpperCase() === req.query.symbol.toUpperCase());
  res.json({ success: true, updatedAt: result.updatedAt, count: data.length, data });
});

app.get("/api/stocks/:symbol", (req, res) => {
  const result = loadData("stocks.json");
  if (!result) return res.status(503).json({ error: "No stock data available yet." });
  const stock = result.data.find(s => s.symbol.toUpperCase() === req.params.symbol.toUpperCase());
  if (!stock) return res.status(404).json({ error: `Symbol ${req.params.symbol} not found.` });
  res.json({ success: true, updatedAt: result.updatedAt, data: stock });
});

app.get("/api/index", (req, res) => sendData(res, "pseiIndex.json", "PSEi index"));

app.get("/api/dividends", (req, res) => {
  const result = loadData("dividends.json");
  if (!result) return res.status(503).json({ error: "No dividend data yet." });
  let data = result.data;
  if (req.query.symbol) data = data.filter(d => d.symbol?.toUpperCase() === req.query.symbol.toUpperCase());
  if (req.query.upcoming === "true") { const today = new Date().toISOString().split("T")[0]; data = data.filter(d => d.exDate && d.exDate >= today); }
  res.json({ success: true, updatedAt: result.updatedAt, count: data.length, data });
});

app.get("/api/disclosures", (req, res) => {
  const result = loadData("disclosures.json");
  if (!result) return res.status(503).json({ error: "No disclosures yet." });
  let data = result.data;
  if (req.query.symbol) data = data.filter(d => d.symbol?.toUpperCase() === req.query.symbol.toUpperCase());
  if (req.query.category) data = data.filter(d => d.category?.toLowerCase() === req.query.category.toLowerCase());
  res.json({ success: true, updatedAt: result.updatedAt, count: data.length, data });
});

app.post("/api/scrape", async (req, res) => {
  if (req.body.secret !== SCRAPE_SECRET) return res.status(401).json({ error: "Invalid secret key." });
  res.json({ message: "Scrape triggered." });
  try {
    if (req.body.type === "stocks") await scrapeLivePrices();
    else if (req.body.type === "dividends") await scrapeDividendDisclosures();
    else await runFullScrape();
  } catch (err) { console.error("Manual scrape error:", err.message); }
});

// AI NEWS
app.post("/api/news", async (req, res) => {
  const KEY = process.env.ANTHROPIC_API_KEY;
  if (!KEY) return res.status(503).json({ error: "ANTHROPIC_API_KEY not set on server. Add it in Railway Variables." });
  const topic = req.body.topic || "Philippine Stock Exchange PSE market 2026";
  try {
    const r = await fetch("https://api.anthropic.com/v1/messages", {
      method: "POST",
      headers: { "Content-Type": "application/json", "x-api-key": KEY, "anthropic-version": "2023-06-01" },
      body: JSON.stringify({
        model: "claude-haiku-4-5-20251001",
        max_tokens: 2000,
        messages: [{
          role: "user",
          content: `You are a PSE (Philippine Stock Exchange) financial analyst. Generate 6 informative news items about: "${topic}".
Use your knowledge of PSE-listed companies and Philippine economy.
Return ONLY a JSON array, no other text, no markdown:
[{"title":"headline","summary":"2-3 sentences for Filipino investors","sentiment":"bullish","category":"Banking","source":"BusinessWorld","relevance":"why this matters"}]
sentiment must be: bullish, bearish, or neutral`
        }]
      })
    });
    const d = await r.json();
    console.log("NEWS response stop_reason:", d.stop_reason, "content types:", d.content?.map(b=>b.type));
    const tb = d.content?.find(b => b.type === "text");
    let articles = [];
    if (tb) {
      try { articles = JSON.parse(tb.text.replace(/```json|```/g,"").trim()); }
      catch(e) { console.error("Parse err:", e.message, tb.text.slice(0,300)); articles = [{title:"PSE Update",summary:tb.text.slice(0,200),sentiment:"neutral",category:"General",source:"AI",relevance:"Market insight."}]; }
    }
    res.json({ success: true, articles, generatedAt: new Date().toISOString() });
  } catch(e) { console.error("News err:", e); res.status(500).json({ error: e.message }); }
});

// AI PICKS
app.post("/api/picks", async (req, res) => {
  const KEY = process.env.ANTHROPIC_API_KEY;
  if (!KEY) return res.status(503).json({ error: "ANTHROPIC_API_KEY not set on server. Add it in Railway Variables." });
  const { strategy } = req.body;
  if (!["GROWTH","VALUE","MOAT","DIVIDENDS"].includes(strategy)) return res.status(400).json({ error: "Invalid strategy." });
  const defs = { GROWTH:"high revenue growth, strong ROE above 15%, expanding market share", VALUE:"undervalued vs peers, low P/E, strong balance sheet", MOAT:"brand dominance, regulatory advantages, network effects, switching costs", DIVIDENDS:"high dividend yield above 4%, consistent payouts, stable cash flow, REITs" };
  try {
    const r = await fetch("https://api.anthropic.com/v1/messages", {
      method: "POST",
      headers: { "Content-Type": "application/json", "x-api-key": KEY, "anthropic-version": "2023-06-01" },
      body: JSON.stringify({
        model: "claude-haiku-4-5",
        max_tokens: 2000,
        messages: [{
          role: "user",
          content: `You are a Philippine stock market analyst. Give ${strategy} stock picks for PSE investors.
${strategy} means: ${defs[strategy]}

Return ONLY a JSON object, no other text, no markdown:
{"strategy":"${strategy}","summary":"2-3 sentences about this strategy for PSE","marketContext":"current PSE market context","picks":[{"symbol":"BDO","name":"BDO Unibank","rating":"Strong Buy","targetUpside":"+15%","thesis":"investment thesis","keyMetric":"ROE: 14%","risk":"main risk"}],"avoid":["SYMBOL"],"avoidReason":"why avoid"}

Provide exactly 5 picks from real PSE stocks like BDO, BPI, ALI, SMPH, SM, AC, JFC, TEL, GLO, MER, AREIT, MREIT, FILRT, CREIT, DMC, AEV, AGI, URC, MONDE, SCC, ICT, MPI.
rating must be exactly: Strong Buy, Buy, or Hold`
        }]
      })
    });
    const d = await r.json();
    console.log("PICKS response stop_reason:", d.stop_reason, "content types:", d.content?.map(b=>b.type));
    const tb = d.content?.find(b => b.type === "text");
    let result = { strategy, picks:[], summary:"", marketContext:"", avoid:[], avoidReason:"" };
    if (tb) {
      try { result = { ...result, ...JSON.parse(tb.text.replace(/```json|```/g,"").trim()) }; }
      catch(e) { console.error("Picks parse err:", e.message, tb.text.slice(0,300)); result.summary = tb.text.slice(0,200); }
    }
    res.json({ success:true, ...result, generatedAt: new Date().toISOString() });
  } catch(e) { console.error("Picks err:", e); res.status(500).json({ error: e.message }); }
});

// CRON
cron.schedule("*/5 1-8 * * 1-5", async () => { console.log("Cron: prices..."); await scrapeLivePrices(); }, { timezone: "Asia/Manila" });
cron.schedule("0 7 * * *", async () => { console.log("Cron: dividends..."); await scrapeDividendDisclosures(); }, { timezone: "Asia/Manila" });
cron.schedule("30 7 * * 1-5", async () => { console.log("Cron: full scrape..."); await runFullScrape(); }, { timezone: "Asia/Manila" });
cron.schedule("0 6 * * 0", async () => { console.log("Cron: weekly..."); await runFullScrape(); }, { timezone: "Asia/Manila" });

app.listen(PORT, () => {
  console.log(`\n🚀 PSE Backend running on port ${PORT}`);
  console.log(`   API: http://localhost:${PORT}/api`);
  console.log(`   Key set: ${!!process.env.ANTHROPIC_API_KEY}`);
  runFullScrape().catch(console.error);
});
