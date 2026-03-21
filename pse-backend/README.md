# PSE Investor Hub — Backend Server

A Node.js backend that scrapes PSE Edge daily for dividend disclosures,
company announcements, and live stock prices — then serves them as a REST API
to the PSE Investor Hub frontend.

---

## 📡 API Endpoints

| Method | Endpoint | Description |
|--------|----------|-------------|
| GET | `/api/health` | Health check |
| GET | `/api/status` | Scrape status + data freshness |
| GET | `/api/stocks` | All live stock prices |
| GET | `/api/stocks/:symbol` | Single stock (e.g. `/api/stocks/BDO`) |
| GET | `/api/index` | PSEi index value |
| GET | `/api/dividends` | Dividend disclosures from PSE Edge |
| GET | `/api/dividends?symbol=BDO` | Filter by stock |
| GET | `/api/dividends?upcoming=true` | Upcoming ex-dates only |
| GET | `/api/disclosures` | General company disclosures |
| GET | `/api/disclosures?category=Earnings` | Filter by category |
| POST | `/api/scrape` | Trigger manual scrape (requires secret) |

---

## ⏰ Scrape Schedule (PHT)

| What | When |
|------|------|
| Live stock prices | Every 5 min, Mon–Fri 9AM–4PM |
| Dividend disclosures | Daily 7:00 AM |
| Full scrape (all data) | Weekdays 7:30 AM |
| Deep/weekly scrape | Sundays 6:00 AM |

---

## 🚀 Option 1: Deploy to Railway (Recommended — Free Tier)

Railway gives you a free persistent server with auto-deploy from GitHub.

1. Push this folder to a GitHub repo
2. Go to [railway.app](https://railway.app) → New Project → Deploy from GitHub
3. Select your repo
4. Add environment variables:
   - `SCRAPE_SECRET` = your secret key
   - `ALLOWED_ORIGIN` = your frontend URL (e.g. https://your-app.vercel.app)
5. Railway auto-detects Node.js and deploys
6. Copy your Railway URL (e.g. `https://pse-backend.railway.app`)
7. Update `BACKEND_URL` in the frontend HTML

---

## 🚀 Option 2: Deploy to Render (Free Tier)

1. Push to GitHub
2. Go to [render.com](https://render.com) → New Web Service → Connect repo
3. Build command: `npm install`
4. Start command: `node server.js`
5. Add env vars: `SCRAPE_SECRET`, `ALLOWED_ORIGIN`
6. Free tier spins down after inactivity — use Railway for always-on

---

## 🖥️ Option 3: Run Locally

```bash
cd pse-backend
npm install
cp .env.example .env
# Edit .env with your values
node server.js
```

Then update the frontend's `BACKEND_URL` to `http://localhost:3001`.

---

## 🔧 Trigger a Manual Scrape

```bash
curl -X POST http://localhost:3001/api/scrape \
  -H "Content-Type: application/json" \
  -d '{"secret":"your-secret-key","type":"all"}'
```

Types: `all`, `stocks`, `dividends`

---

## 📁 Data Files (auto-generated in /data)

| File | Contents |
|------|----------|
| `stocks.json` | All PSE stock prices |
| `dividends.json` | Dividend disclosures from PSE Edge |
| `disclosures.json` | Earnings, AGM, rights offering announcements |
| `pseiIndex.json` | PSEi index value |
| `scrapeLog.json` | Log of last scrape run |

---

## ⚠️ Disclaimer

This scraper fetches publicly available data from PSE Edge
(edge.pse.com.ph). Use responsibly — do not scrape more frequently
than scheduled to avoid overloading PSE servers. This is for
educational and personal use only.
