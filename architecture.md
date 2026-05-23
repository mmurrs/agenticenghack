# PricePilot — MVP Architecture

> Discovery-first price agent: user names a product, agent fans out across major retailers via Nimble, returns a sorted "where to buy + at what price" table. Tracking + resale checks are opt-in stretch goals.

---

## Primary intent: "Find me the cheapest place to buy X"

The original spec assumed users paste URLs. They don't — they name products. The MVP flow is:

```
User:  "Cheapest Sony WH-1000XM5"
        │
        ▼
  Hermes (intent → product query)
        │
        ▼
  Nimble fan-out (parallel)
   ├─ amazon_serp("Sony WH-1000XM5")  → top hit ASIN
   ├─ walmart_search(...)             → top hit URL
   ├─ target_pdp / best_buy_pdp / home_depot_pdp via google_search resolution
   └─ (stretch) ebay custom agent     → resale floor price
        │
        ▼
  ClickHouse: log price_events (every retailer, every check)
        │
        ▼
  Telegram: ranked table — cheapest first, with buy links
        │
        ▼
  Optional: "Track this and alert me under $X"  →  poll loop (Flow 2)
```

---

## Architecture Diagram

```
┌──────────────────────────────────────────────────────────┐
│                     USER INTERFACE                       │
│              Telegram Bot  (@PricePilotBot)              │
│   "Find me the cheapest Sony WH-1000XM5"                 │
└─────────────────────────┬────────────────────────────────┘
                          │ inbound message (webhook)
                          ▼
┌──────────────────────────────────────────────────────────┐
│              HERMES AGENT  (Daytona Sandbox)             │
│                                                          │
│  ┌─────────────┐   ┌──────────────┐   ┌──────────────┐   │
│  │Intent Parser│──▶│  Tool Router │──▶│Resp Composer │   │
│  └─────────────┘   └──────┬───────┘   └──────────────┘   │
│                           │                              │
│      ┌────────────────────┼────────────────────┐         │
│      │                    │                    │         │
│  find_cheapest      track_product         get_history    │
│   (product_name)     (product_id, $)      (product_id)   │
└──────┼────────────────────┼────────────────────┼─────────┘
       │                    │                    │
       ▼                    ▼                    ▼
┌──────────────┐  ┌─────────────────┐  ┌─────────────────┐
│    NIMBLE    │  │   CLICKHOUSE    │  │    SENSO.AI     │
│              │  │                 │  │                 │
│ FAN-OUT:     │  │ price_events    │  │ generate_report │
│ amazon_serp  │  │ tracked_products│  │  (product, hist,│
│ walmart_     │─▶│                 │─▶│   sources=[...])│
│   search     │  │  every retailer │  │ → published URL │
│ target_pdp   │  │  every check    │  │   on cited.md   │
│ best_buy_pdp │  │                 │  │                 │
│ home_depot   │  │                 │  │                 │
│              │  │                 │  │                 │
│ STRETCH:     │  │                 │  │                 │
│ agent.       │  │                 │  │                 │
│  generate(   │  │                 │  │                 │
│   ebay,      │  │                 │  │                 │
│   stockx)    │  │                 │  │                 │
└──────────────┘  └─────────────────┘  └────────┬────────┘
                                                │
                          ┌─────────────────────┘
                          ▼
              Hermes → Telegram:
              "🥇 Best Buy $79.99  [buy]
               🥈 Amazon   $84.50  [buy]
               🥉 Walmart  $89.00  [buy]
               eBay used  $52.00  [buy]  (stretch)"
```

---

## User Intent → Agent Flows

### Flow 1 (PRIMARY): "Find me the cheapest X"

```
User:  "Cheapest Sony WH-1000XM5"

Hermes: parse_intent()
  → { action: "find_cheapest", query: "Sony WH-1000XM5" }
  → Nimble fan-out (parallel asyncio.gather):
      amazon_serp(query)     → top ASIN → amazon_pdp(asin)
      walmart_search(query)  → top URL  → walmart_pdp(url)
      google_search(query + site:target.com)    → target_pdp(url)
      google_search(query + site:bestbuy.com)   → best_buy_pdp(url)
      google_search(query + site:homedepot.com) → home_depot_pdp(url)
  ← [{retailer, price, url, title, in_stock, image}, ...]
  → ClickHouse: bulk INSERT price_events (one row per retailer)
  → Hermes: rank by price, filter out_of_stock, format
  → Telegram: ranked table with buy links
  → Telegram: "Want me to track these and alert on a drop? Reply with target $."
```

### Flow 2 (OPT-IN): Tracking + alert

```
User:  "Yes, alert me when under $80"

Hermes: → ClickHouse: INSERT INTO tracked_products (last fan-out's product_id, threshold=80)
  → scheduler enqueues poll every 10 min

Scheduler: check_all_tracked()
  → for each tracked product:
      → Nimble fan-out (same as Flow 1)
      → ClickHouse: INSERT price_events
      → if any retailer < threshold:
          → Senso.ai: generate_report(product, price_history[24h], sources=[urls])
              ← { report_url: "cited.md/report/abc123" }
          → Telegram: "🚨 Sony XM5 hit $79 at Best Buy. Analysis: {report_url}"
```

### Flow 3: History query

```
User: "What have my items done this week?"

  → ClickHouse: SELECT product_id, source, MIN(price), MAX(price),
                       argMin(price, timestamp) latest_price
                FROM price_events
                WHERE user_id = ? AND timestamp > now() - INTERVAL 7 DAY
                GROUP BY product_id, source
  → Telegram: per-retailer min/max/latest table
```

### Flow 4 (STRETCH): Resale comparison

```
User: "Cheapest Jordan 4 Bred"

  → Flow 1 fan-out (retail) +
  → ebay_search (custom agent generated at startup via agent.generate)
  → stockx_search (custom agent)
  → Telegram: side-by-side: "Retail $200 | eBay used avg $145 | StockX last sale $180"
```

---

## Sponsor Tool Roles

| Tool | Role | Why it's compelling |
|------|------|---------------------|
| **Nimble** | Cross-retailer fan-out: Amazon, Walmart, Target, Best Buy, Home Depot via pre-built agents; eBay/StockX via on-the-fly `agent.generate()` | Showcases both pre-built agents AND AI-generated custom agents — Nimble's full surface |
| **ClickHouse** | `price_events` time-series across all retailers; analytical roll-ups (min/max per source, leaderboard queries) | Multi-source aggregation is exactly the analytical-query sweet spot |
| **Senso.ai** | Cited price-drop reports published to cited.md, sourced from every retailer URL we hit | Closes the loop: not just ingestion — publishes grounded output back to the agent web |

---

## Nimble Setup (concrete)

**Auth:** API key from `https://online.nimbleway.com/account-settings/api-keys` → env var `NIMBLE_API_KEY`. Free trial = 5,000 pages, no card required.

**Install:**
```bash
pip install nimble-python
```

**Pre-built retail agents (no setup, just call):**
```python
from nimble_python import AsyncNimble
import asyncio, os

client = AsyncNimble(api_key=os.environ["NIMBLE_API_KEY"])

async def find_cheapest(query: str) -> list[dict]:
    # Step 1: discovery (search) in parallel
    amazon_search, walmart_search = await asyncio.gather(
        client.agent.run(agent="amazon_serp",     params={"query": query}),
        client.agent.run(agent="walmart_search",  params={"query": query}),
    )
    asin       = amazon_search.data["results"][0]["asin"]
    walmart_id = walmart_search.data["results"][0]["url"]

    # Step 2: PDPs in parallel (authoritative price)
    pdps = await asyncio.gather(
        client.agent.run(agent="amazon_pdp",   params={"asin": asin, "zip_code": "10001"}),
        client.agent.run(agent="walmart_pdp",  params={"url": walmart_id}),
        # target_pdp / best_buy_pdp / home_depot_pdp resolved via google_search first
    )
    return [
        {"retailer": "amazon",  "price": pdps[0].data["web_price"], "url": pdps[0].data["url"], "title": pdps[0].data["product_title"]},
        {"retailer": "walmart", "price": pdps[1].data["price"],     "url": walmart_id},
    ]
```

**Stretch — custom resale agent generated at startup:**
```python
# Run ONCE before demo to register custom agents
client.agent.generate(
    url="https://www.ebay.com/sch/i.html?_nkw=sony+wh-1000xm5",
    prompt="Extract title, current_bid_or_buy_now_price, condition, seller_rating per listing card",
    agent_name="ebay_search",
    output_schema={"type": "object", "properties": {
        "results": {"type": "array", "items": {"type": "object", "properties": {
            "title": {"type": "string"},
            "price": {"type": "number"},
            "condition": {"type": "string"},
            "seller_rating": {"type": "number"},
            "url": {"type": "string"},
        }}}
    }},
)
# Then call like any pre-built agent:
ebay = await client.agent.run(agent="ebay_search", params={"query": "Sony WH-1000XM5"})
```

**Pricing back-of-envelope:** WSA Nimble-managed = $1.75 per 1K calls. Per "find_cheapest" we make ~5 PDP calls = $0.0088 per query. Hackathon free tier covers 5,000 pages = ~1,000 queries free.

---

## ClickHouse Schema

```sql
CREATE TABLE price_events (
  user_id      String,
  product_id   String,         -- canonical key: lower(brand + ' ' + model_token)
  product_name String,
  query        String,         -- original user query for traceability
  url          String,
  source       LowCardinality(String),   -- 'amazon' | 'walmart' | 'target' | 'best_buy' | 'home_depot' | 'ebay' | 'stockx'
  price        Float64,
  currency     String DEFAULT 'USD',
  in_stock     UInt8,
  is_resale    UInt8 DEFAULT 0,         -- distinguishes new-retail vs secondary market
  timestamp    DateTime DEFAULT now()
) ENGINE = MergeTree()
ORDER BY (product_id, source, timestamp);

CREATE TABLE tracked_products (
  user_id      String,
  product_id   String,
  product_name String,
  threshold    Float64,
  active       UInt8 DEFAULT 1,
  created_at   DateTime DEFAULT now()
) ENGINE = ReplacingMergeTree()
ORDER BY (user_id, product_id);
```

Note: no per-retailer URL columns. URLs live in `price_events.url` — one product can have N retailers.

---

## Hermes Tool Definitions

```python
tools = [
  find_cheapest(query: str, user_id: str) -> list[PriceQuote],   # PRIMARY — Nimble fan-out
  track_product(product_id: str, threshold: float, user_id: str),
  get_price_history(product_id: str, user_id: str) -> list[Price],
  generate_report(product_id: str, user_id: str) -> str,         # Senso → cited URL
  send_alert(user_id: str, message: str, url: str),              # Telegram
]
```

---

## Team Division of Work

| Person | Focus | Deliverable |
|--------|-------|-------------|
| **Kishore** | Hermes agent in Daytona: intent parser, tool routing, polling loop, Telegram webhook | Working agent that calls the other 3 functions |
| **Nimble (Matt)** | (1) Pre-built fan-out across 5 retailers; (2) generate eBay/StockX agents at boot for resale stretch | `find_cheapest(query) → list[PriceQuote]` |
| **ClickHouse** | Schema + INSERT helpers + leaderboard query | `bulk_store(events)`, `get_history(product_id)`, `get_tracked()` |
| **Senso** | Cited report from price history + retailer URLs | `generate_report(product, history) → published_url` |

> Integration contract: each person exposes **one Python function**. Hermes imports them all.

---

## Judging Criteria Alignment

| Criterion (20% each) | How we hit it |
|----------------------|---------------|
| **Autonomy** | Fan-out happens without user choosing retailers; tracking polls without intervention |
| **Idea** | Discovery beats tracking — users want "where do I buy this" before they want alerts |
| **Technical implementation** | Parallel async fan-out across 5 pre-built Nimble agents + AI-generated custom agents for resale |
| **Tool use** | Nimble (5 pre-built + 2 generated) + ClickHouse multi-source rollups + Senso cited reports |
| **Presentation** | Demo: type product name → ranked retailer table appears in <5s → opt-in to track → drop alert with cited Senso URL |

---

## MVP Scope (ship by 4:30 PM)

- [ ] Telegram bot receives "find cheapest X" intent
- [ ] Nimble fan-out: `amazon_serp` → `amazon_pdp` + `walmart_search` → `walmart_pdp` (parallel via `asyncio.gather`)
- [ ] ClickHouse bulk INSERT of price_events across retailers
- [ ] Telegram returns ranked price table with buy links
- [ ] Opt-in tracking: "track this @ $X" registers product + threshold
- [ ] Polling loop fires Senso report + alert on threshold breach

### Stretch (hit if MVP done)
- [ ] Add `target_pdp`, `best_buy_pdp`, `home_depot_pdp` to fan-out (each is one extra parallel call)
- [ ] **Resale comparison**: `agent.generate()` for `ebay_search` and `stockx_search` at boot, surface used/secondary prices alongside retail
- [ ] On-demand history query (`/history`)

### Out of scope
- Landing page / web UI
- Voice interface
- Credit card points optimization
- Computer vision for in-store prices
