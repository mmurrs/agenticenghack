# Search — Cheapest-Offer Tool

Tool the Hermes agent calls to answer **"find me the cheapest X."** Phased rollout:

| Phase | Tool name | Sources | Status |
|---|---|---|---|
| **v1** | `find_cheapest_amazon` | Amazon | first to ship |
| **v2** | `find_cheapest_retail` | Amazon + Walmart | after v1 lands |
| **v3** | `find_cheapest_all` | Amazon + Walmart + StockX | stretch |

eBay is out of scope for now — see [LEARNINGS.md](./LEARNINGS.md) for why.

Files in this folder:

- `README.md` — this file. What the tool calls look like.
- `tools.py` — function-spec stubs (LLM tool-calling format) and Python signatures.
- `LEARNINGS.md` — what we learned scraping Amazon/Walmart/StockX, watchouts, schema rationale.

The shared ClickHouse schema lives in [`../clickhouse-setup.sql`](../clickhouse-setup.sql). The agent flow that calls these tools lives in [`../architecture.md`](../architecture.md).

---

## Tool-call contract (LLM-facing)

Every variant takes the same input and returns the same shape. The agent doesn't need to know how many platforms are queried — it just calls the tool.

### Input

```json
{
  "brand": "Nike",
  "model": "Killshot 2",
  "color": "Sail/Lucid Green",
  "size_us_men": 11.5,
  "condition": "new"
}
```

- `brand` (required) — manufacturer
- `model` (required) — product line
- `color` (optional but recommended) — exact-color search reduces ambiguity dramatically (see [LEARNINGS.md](./LEARNINGS.md) §5)
- `size_us_men` (required for sized items) — `Decimal(4,1)`, e.g. `11.5`
- `condition` (optional, default `"new"`) — `"new" | "used" | "ds"`

### Output

```json
{
  "spec": { "brand": "...", "model": "...", "color": "...", "size_us_men": 11.5 },
  "best": {
    "source": "amazon",
    "price": 77.60,
    "currency": "USD",
    "url": "https://www.amazon.com/dp/B0DVFCSZGR",
    "in_stock": true,
    "seller": "Amazon.com",
    "shipping_cost": 0.00,
    "observed_at": "2026-05-23T14:32:11Z"
  },
  "all_offers": [
    { "source": "amazon",  "price": 77.60, "url": "...", "in_stock": true,  ... },
    { "source": "walmart", "price": 82.99, "url": "...", "in_stock": true,  ... },
    { "source": "stockx",  "price": 95.00, "url": "...", "in_stock": true,  ... }
  ],
  "observation_ids": ["uuid-1", "uuid-2", "uuid-3"]
}
```

`observation_ids` are the row IDs persisted to ClickHouse so the agent can request a price-history chart later.

---

## Phase 1 — `find_cheapest_amazon`

Single-platform. Validates the spec → child-SKU → price → ClickHouse pipeline end to end.

```python
def find_cheapest_amazon(
    brand: str,
    model: str,
    size_us_men: float,
    color: str | None = None,
    condition: str = "new",
) -> CheapestOfferResponse:
    ...
```

**Internal flow:**

1. `nimble.amazon_serp(query=f"{brand} {model} {color or ''}".strip())` → list of parent ASINs.
2. Filter to the parent whose title best matches `color` (string overlap on normalized tokens).
3. `nimble.amazon_pdp(asin=parent_asin)` → pull `dimensionValuesDisplayData`.
4. Find the child ASIN where `(size, color) == (size_us_men, color)`.
5. `nimble.amazon_pdp(asin=child_asin, zip_code="10001")` → buybox price + in-stock.
6. `clickhouse.insert("listings_observations", row)`.
7. Return the offer.

**Hard rule:** never call `nimble_extract` on an Amazon PDP — always use `amazon_pdp` (structured). See [LEARNINGS.md](./LEARNINGS.md) §1.

---

## Phase 2 — `find_cheapest_retail`

Same input/output as Phase 1. Internally fans out Amazon + Walmart in parallel via `asyncio.gather`, persists both observations, returns the cheaper one as `best`.

```python
async def find_cheapest_retail(...) -> CheapestOfferResponse:
    amazon, walmart = await asyncio.gather(
        _amazon_offer(spec),
        _walmart_offer(spec),
    )
    offers = [o for o in (amazon, walmart) if o and o.in_stock]
    return _rank_and_persist(spec, offers)
```

**Walmart variant resolution:** Walmart's parent product page exposes `variantFieldsMap` (color × size → `item_id`). Same shape as Amazon's `dimensionValuesDisplayData`, different field names.

---

## Phase 3 — `find_cheapest_all`

Adds StockX. StockX is bot-walled — no clean API — so this phase only runs when the spec is plausibly a sneaker (brand in `{Nike, Adidas, Jordan, New Balance, Asics, ...}`).

```python
async def find_cheapest_all(...) -> CheapestOfferResponse:
    coros = [_amazon_offer(spec), _walmart_offer(spec)]
    if _is_likely_sneaker(spec):
        coros.append(_stockx_offer(spec))
    results = await asyncio.gather(*coros, return_exceptions=True)
    offers = [o for o in results if isinstance(o, Offer) and o.in_stock]
    return _rank_and_persist(spec, offers)
```

**StockX gotchas** (see [LEARNINGS.md](./LEARNINGS.md) §11):

- Use the unofficial GraphQL by product URN, not HTML scraping.
- Lowest "ask" ≠ buybox — it's the cheapest *seller offer*, no Prime-style guarantees.
- Selectors break often. Cache aggressively, fail soft (return `None`, not exception).
- `condition="used"` is meaningless on StockX — everything is treated as new/DS. Skip StockX if `condition != "new"`.

---

## ClickHouse persistence

Every successful offer-resolution writes one row to `listings_observations` (schema in [`../clickhouse-setup.sql`](../clickhouse-setup.sql) — note: the team's current schema is `scraping.amazon_products` for v1; expand to `listings_observations` when v2 lands).

Don't dedupe. Price history is the point. Use `argMax(price, observed_at)` for "current price."

---

## Open contract questions

- **Caching:** if two callers ask for the same `(spec)` within 5 minutes, do we re-scrape or return the cached row? Default: re-scrape (freshness wins on hackathon day).
- **Failure mode:** if Amazon returns OK but Walmart 500s, return Amazon-only or fail? Default: return what we have, mark missing sources in response.
- **Color matching:** fuzzy or exact? See LEARNINGS §8 — leaning on a `color_aliases` table built incrementally.

See [LEARNINGS.md](./LEARNINGS.md) for the full set of watchouts before implementing.
