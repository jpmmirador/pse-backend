/**
 * PSE Edge Scraper
 * Scrapes dividend disclosures, company announcements, and stock data
 * from edge.pse.com.ph and phisix-api3.appspot.com
 */

const axios = require("axios");
const axiosRetry = require("axios-retry").default;
const cheerio = require("cheerio");
const fs = require("fs");
const path = require("path");

// ─── Retry config: 3 attempts, exponential backoff ───────────────────────────
axiosRetry(axios, {
  retries: 3,
  retryDelay: axiosRetry.exponentialDelay,
  retryCondition: (err) =>
    axiosRetry.isNetworkError(err) || axiosRetry.isRetryableError(err),
});

const DATA_DIR = path.join(__dirname, "data");
const HEADERS = {
  "User-Agent":
    "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 Chrome/120.0 Safari/537.36",
  Accept: "text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8",
  "Accept-Language": "en-US,en;q=0.5",
  Referer: "https://edge.pse.com.ph/",
};

// ─── Ensure data directory exists ────────────────────────────────────────────
function ensureDataDir() {
  if (!fs.existsSync(DATA_DIR)) fs.mkdirSync(DATA_DIR, { recursive: true });
}

function saveData(filename, data) {
  ensureDataDir();
  const file = path.join(DATA_DIR, filename);
  fs.writeFileSync(file, JSON.stringify({ updatedAt: new Date().toISOString(), data }, null, 2));
  console.log(`✅ Saved ${filename} (${Array.isArray(data) ? data.length : 1} records)`);
}

function loadData(filename) {
  const file = path.join(DATA_DIR, filename);
  if (!fs.existsSync(file)) return null;
  return JSON.parse(fs.readFileSync(file, "utf8"));
}

// ─── 1. LIVE STOCK PRICES (phisix-api3) ──────────────────────────────────────
async function scrapeLivePrices() {
  console.log("📈 Fetching live PSE stock prices...");
  try {
    const res = await axios.get("https://phisix-api3.appspot.com/stocks.json", {
      timeout: 15000,
    });
    const stocks = (res.data.stock || []).map((s) => ({
      symbol: s.symbol,
      name: s.name,
      price: parseFloat(s.price.amount),
      change: parseFloat(s.percent_change),
      volume: parseFloat(s.volume),
      currency: s.price.currency,
    }));
    saveData("stocks.json", stocks);
    return stocks;
  } catch (err) {
    console.error("❌ Live prices failed:", err.message);
    return null;
  }
}

// ─── 2. PSE EDGE DIVIDEND DISCLOSURES ────────────────────────────────────────
async function scrapeDividendDisclosures() {
  console.log("💰 Scraping PSE Edge dividend disclosures...");
  const dividends = [];

  try {
    // PSE Edge disclosure search — filter by disclosure type CASH DIVIDEND
    const searchUrl = "https://edge.pse.com.ph/announcements/form.do";
    const today = new Date();
    const sixMonthsAgo = new Date();
    sixMonthsAgo.setMonth(today.getMonth() - 6);

    const formatDate = (d) =>
      `${(d.getMonth() + 1).toString().padStart(2, "0")}/${d
        .getDate()
        .toString()
        .padStart(2, "0")}/${d.getFullYear()}`;

    const params = new URLSearchParams({
      companyId: "",
      keyword: "",
      dateFrom: formatDate(sixMonthsAgo),
      dateTo: formatDate(today),
      category: "1", // 1 = Company Disclosures
      tmplNm: "CASH DIVIDEND",
      button: "Search",
    });

    const res = await axios.post(searchUrl, params.toString(), {
      headers: {
        ...HEADERS,
        "Content-Type": "application/x-www-form-urlencoded",
      },
      timeout: 20000,
    });

    const $ = cheerio.load(res.data);

    // Parse disclosure table rows
    $("table.list tr").each((i, row) => {
      if (i === 0) return; // skip header
      const cols = $(row).find("td");
      if (cols.length < 5) return;

      const date = $(cols[0]).text().trim();
      const company = $(cols[1]).text().trim();
      const symbol = $(cols[2]).text().trim();
      const subject = $(cols[3]).text().trim();
      const disclosureLink = $(cols[4]).find("a").attr("href") || "";

      if (!symbol || !subject.toLowerCase().includes("dividend")) return;

      // Parse dividend details from subject line
      const parsed = parseDividendSubject(subject);

      dividends.push({
        date,
        company,
        symbol: symbol.toUpperCase(),
        subject,
        ...parsed,
        disclosureUrl: disclosureLink
          ? `https://edge.pse.com.ph${disclosureLink}`
          : null,
        source: "PSE Edge",
        scrapedAt: new Date().toISOString(),
      });
    });

    // Also scrape stock rights and special dividends
    await scrapeStockDividends(dividends);

    console.log(`  Found ${dividends.length} dividend disclosures`);
    saveData("dividends.json", dividends);
    return dividends;
  } catch (err) {
    console.error("❌ Dividend scrape failed:", err.message);
    // Try fallback method
    return await scrapeDividendsFallback();
  }
}

// ─── Parse dividend details from disclosure subject text ─────────────────────
function parseDividendSubject(subject) {
  const result = { dps: null, exDate: null, recordDate: null, payDate: null, frequency: null };

  // Match peso amounts: ₱0.50, P0.50, Php 0.50, 0.50 per share
  const dpsMatch = subject.match(/(?:₱|P(?:hp)?\.?\s*)(\d+\.?\d*)\s*(?:per\s*share)?/i);
  if (dpsMatch) result.dps = parseFloat(dpsMatch[1]);

  // Match dates: MM/DD/YYYY or Month DD, YYYY
  const dateMatches = subject.match(/\d{1,2}\/\d{1,2}\/\d{4}/g) || [];
  if (dateMatches[0]) result.exDate = normalizeDate(dateMatches[0]);
  if (dateMatches[1]) result.recordDate = normalizeDate(dateMatches[1]);
  if (dateMatches[2]) result.payDate = normalizeDate(dateMatches[2]);

  // Detect frequency
  if (/quarterly/i.test(subject)) result.frequency = "Quarterly";
  else if (/semi.?annual/i.test(subject)) result.frequency = "Semi-Annual";
  else if (/special/i.test(subject)) result.frequency = "Special";
  else result.frequency = "Annual";

  return result;
}

function normalizeDate(d) {
  if (!d) return null;
  const parts = d.split("/");
  if (parts.length !== 3) return d;
  return `${parts[2]}-${parts[0].padStart(2, "0")}-${parts[1].padStart(2, "0")}`;
}

// ─── Fallback: scrape via individual company pages ────────────────────────────
async function scrapeDividendsFallback() {
  console.log("  🔄 Trying fallback dividend scrape...");
  const fallbackDividends = [];
  // Key dividend-paying PSE stocks to check
  const SYMBOLS = [
    "AREIT","BDO","BPI","MBT","TEL","GLO","MER","AP","ALI","SMPH",
    "SM","AC","JFC","URC","MONDE","FILRT","MREIT","RCR","CREIT","DDMPR",
    "VREIT","SECB","DMC","AEV","AGI","FGEN","MPI","PCOR","SCC"
  ];

  for (const sym of SYMBOLS) {
    try {
      const res = await axios.get(
        `https://edge.pse.com.ph/companyDisclosures/search.ax?keyword=dividend&cmpy_id=${sym}&sortType=D&currentPage=1`,
        { headers: HEADERS, timeout: 10000 }
      );
      const $ = cheerio.load(res.data);
      $("tr.disclosureRow").slice(0, 3).each((i, row) => {
        const date = $(row).find(".col-date").text().trim();
        const subj = $(row).find(".col-subject").text().trim();
        if (subj.toLowerCase().includes("dividend")) {
          fallbackDividends.push({
            symbol: sym,
            date,
            subject: subj,
            ...parseDividendSubject(subj),
            source: "PSE Edge (fallback)",
            scrapedAt: new Date().toISOString(),
          });
        }
      });
      await sleep(500); // Be polite to the server
    } catch {}
  }

  if (fallbackDividends.length > 0) {
    saveData("dividends.json", fallbackDividends);
  }
  return fallbackDividends;
}

async function scrapeStockDividends(arr) {
  // Additional pass for stock dividends (rights offerings, stock splits)
  try {
    const params = new URLSearchParams({
      tmplNm: "STOCK DIVIDEND",
      category: "1",
      button: "Search",
    });
    const res = await axios.post(
      "https://edge.pse.com.ph/announcements/form.do",
      params.toString(),
      { headers: { ...HEADERS, "Content-Type": "application/x-www-form-urlencoded" }, timeout: 15000 }
    );
    const $ = cheerio.load(res.data);
    $("table.list tr").each((i, row) => {
      if (i === 0) return;
      const cols = $(row).find("td");
      if (cols.length < 4) return;
      const symbol = $(cols[2]).text().trim().toUpperCase();
      if (!symbol) return;
      arr.push({
        date: $(cols[0]).text().trim(),
        company: $(cols[1]).text().trim(),
        symbol,
        subject: $(cols[3]).text().trim(),
        dps: null,
        frequency: "Stock Dividend",
        source: "PSE Edge",
        scrapedAt: new Date().toISOString(),
      });
    });
  } catch {}
}

// ─── 3. GENERAL DISCLOSURES (earnings, AGM, etc.) ────────────────────────────
async function scrapeDisclosures() {
  console.log("📋 Scraping general PSE disclosures...");
  const disclosures = [];

  const categories = [
    { name: "Earnings", tmpl: "QUARTERLY REPORT" },
    { name: "Annual Report", tmpl: "ANNUAL REPORT" },
    { name: "Dividend", tmpl: "CASH DIVIDEND" },
    { name: "AGM", tmpl: "ANNUAL STOCKHOLDERS MEETING" },
    { name: "Rights Offering", tmpl: "RIGHTS OFFERING" },
  ];

  for (const cat of categories) {
    try {
      const params = new URLSearchParams({
        tmplNm: cat.tmpl,
        category: "1",
        button: "Search",
      });
      const res = await axios.post(
        "https://edge.pse.com.ph/announcements/form.do",
        params.toString(),
        {
          headers: { ...HEADERS, "Content-Type": "application/x-www-form-urlencoded" },
          timeout: 15000,
        }
      );
      const $ = cheerio.load(res.data);
      $("table.list tr").slice(1, 21).each((i, row) => {
        const cols = $(row).find("td");
        if (cols.length < 4) return;
        disclosures.push({
          category: cat.name,
          date: $(cols[0]).text().trim(),
          company: $(cols[1]).text().trim(),
          symbol: $(cols[2]).text().trim().toUpperCase(),
          subject: $(cols[3]).text().trim(),
          source: "PSE Edge",
          scrapedAt: new Date().toISOString(),
        });
      });
      await sleep(600);
    } catch (err) {
      console.warn(`  ⚠️ ${cat.name} scrape failed: ${err.message}`);
    }
  }

  saveData("disclosures.json", disclosures);
  return disclosures;
}

// ─── 4. PSEi INDEX VALUE ──────────────────────────────────────────────────────
async function scrapePSEiIndex() {
  console.log("📊 Fetching PSEi index...");
  try {
    // phisix-api also returns PSEi through a different endpoint
    const res = await axios.get("https://phisix-api3.appspot.com/stocks/PSEi.json", {
      timeout: 10000,
    });
    const d = res.data;
    const index = {
      value: d?.stock?.[0]?.price?.amount || null,
      change: d?.stock?.[0]?.percent_change || null,
      asOf: d?.as_of || new Date().toISOString(),
    };
    saveData("pseiIndex.json", index);
    return index;
  } catch {
    // Fallback: parse from PSE website
    try {
      const res = await axios.get("https://www.pse.com.ph/market-information/market-summary", {
        headers: HEADERS, timeout: 15000,
      });
      const $ = cheerio.load(res.data);
      const val = $(".index-value").first().text().trim().replace(/,/g, "");
      const chg = $(".index-change").first().text().trim();
      const index = { value: parseFloat(val) || null, change: chg, asOf: new Date().toISOString() };
      saveData("pseiIndex.json", index);
      return index;
    } catch (err2) {
      console.error("❌ PSEi index failed:", err2.message);
      return null;
    }
  }
}

// ─── UTILS ────────────────────────────────────────────────────────────────────
function sleep(ms) {
  return new Promise((r) => setTimeout(r, ms));
}

// ─── MAIN SCRAPE RUNNER ───────────────────────────────────────────────────────
async function runFullScrape() {
  console.log("\n🚀 PSE Full Scrape Started:", new Date().toLocaleString("en-PH", { timeZone: "Asia/Manila" }));
  console.log("─".repeat(50));

  const results = {
    startedAt: new Date().toISOString(),
    stocks: false,
    dividends: false,
    disclosures: false,
    pseiIndex: false,
  };

  // Run all scrapers
  const stocks = await scrapeLivePrices();
  results.stocks = !!stocks;

  const dividends = await scrapeDividendDisclosures();
  results.dividends = dividends.length > 0;

  const disclosures = await scrapeDisclosures();
  results.disclosures = disclosures.length > 0;

  const index = await scrapePSEiIndex();
  results.pseiIndex = !!index;

  results.completedAt = new Date().toISOString();
  results.duration = `${((new Date(results.completedAt) - new Date(results.startedAt)) / 1000).toFixed(1)}s`;

  saveData("scrapeLog.json", results);
  console.log("\n✅ Scrape complete:", results);
  return results;
}

module.exports = {
  runFullScrape,
  scrapeLivePrices,
  scrapeDividendDisclosures,
  scrapeDisclosures,
  scrapePSEiIndex,
  loadData,
};

// Run directly if called as script
if (require.main === module) {
  runFullScrape().then(() => process.exit(0)).catch((e) => { console.error(e); process.exit(1); });
}
