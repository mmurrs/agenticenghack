"""
Tool-call definitions for the Search project.

Three phases — same input/output, increasing source coverage:
  Phase 1:  find_cheapest_amazon  (Amazon only)
  Phase 2:  find_cheapest_retail  (Amazon + Walmart)
  Phase 3:  find_cheapest_all     (Amazon + Walmart + StockX)

Read ./LEARNINGS.md before implementing — especially:
  - Don't scrape Amazon HTML for prices (use amazon_pdp).
  - SERP price is the default-rendered size, not your size.
  - Resolve to the child ASIN/item_id before reporting a price.
"""

from __future__ import annotations

import asyncio
from dataclasses import dataclass, asdict
from datetime import datetime, timezone
from typing import Literal, Optional


# ---------------------------------------------------------------------------
# Types
# ---------------------------------------------------------------------------

Condition = Literal["new", "used", "ds"]
Source = Literal["amazon", "walmart", "stockx"]


@dataclass
class ProductSpec:
    brand: str
    model: str
    size_us_men: float
    color: Optional[str] = None
    condition: Condition = "new"


@dataclass
class Offer:
    source: Source
    price: float
    currency: str
    url: str
    in_stock: bool
    seller: str
    shipping_cost: float
    observed_at: str  # ISO 8601 UTC


@dataclass
class CheapestOfferResponse:
    spec: ProductSpec
    best: Optional[Offer]
    all_offers: list[Offer]
    observation_ids: list[str]


# ---------------------------------------------------------------------------
# LLM tool-call schemas (OpenAI / Anthropic format)
# ---------------------------------------------------------------------------

_INPUT_SCHEMA = {
    "type": "object",
    "properties": {
        "brand": {"type": "string", "description": "Manufacturer, e.g. 'Nike'"},
        "model": {"type": "string", "description": "Product line, e.g. 'Killshot 2'"},
        "size_us_men": {
            "type": "number",
            "description": "US men's size, decimal (e.g. 11.5)",
        },
        "color": {
            "type": "string",
            "description": "Exact color/colorway. Optional but strongly recommended.",
        },
        "condition": {
            "type": "string",
            "enum": ["new", "used", "ds"],
            "default": "new",
        },
    },
    "required": ["brand", "model", "size_us_men"],
}

TOOL_SCHEMAS = [
    {
        "name": "find_cheapest_amazon",
        "description": (
            "Phase 1. Find the cheapest in-stock listing of a product on Amazon "
            "for the requested size + color. Returns the best offer plus the raw "
            "Amazon offer. Persists one row to ClickHouse listings_observations."
        ),
        "input_schema": _INPUT_SCHEMA,
    },
    {
        "name": "find_cheapest_retail",
        "description": (
            "Phase 2. Find the cheapest in-stock listing across Amazon AND Walmart "
            "for the requested size + color. Returns the cheaper offer as `best`, "
            "all offers in `all_offers`. Persists one row per platform to ClickHouse."
        ),
        "input_schema": _INPUT_SCHEMA,
    },
    {
        "name": "find_cheapest_all",
        "description": (
            "Phase 3. Find the cheapest in-stock listing across Amazon, Walmart, and "
            "StockX (StockX only queried for likely-sneaker brands and condition='new'). "
            "Same response shape as the others."
        ),
        "input_schema": _INPUT_SCHEMA,
    },
]


# ---------------------------------------------------------------------------
# Per-platform resolvers
# ---------------------------------------------------------------------------

async def _amazon_offer(spec: ProductSpec) -> Optional[Offer]:
    """
    Resolve an Amazon offer for the given spec.

    1. amazon_serp(query=f"{brand} {model} {color}") -> parent ASINs.
    2. Pick parent whose title best matches `color`.
    3. amazon_pdp(asin=parent_asin) -> dimensionValuesDisplayData.
    4. Find child ASIN where (size, color) == requested.
    5. amazon_pdp(asin=child_asin, zip_code='10001') -> price + in-stock.
    6. Return Offer or None if OOS / no match.
    """
    raise NotImplementedError("Wire up Nimble amazon_serp + amazon_pdp here")


async def _walmart_offer(spec: ProductSpec) -> Optional[Offer]:
    """
    Resolve a Walmart offer for the given spec.

    1. walmart_search(query=...) -> top product URLs.
    2. Pick parent whose title best matches `color`.
    3. walmart_pdp(url=parent_url) -> variantFieldsMap.
    4. Find item_id for (size, color).
    5. walmart_pdp(url=child_url) -> price + in-stock.
    6. Return Offer or None.
    """
    raise NotImplementedError("Wire up Nimble walmart_search + walmart_pdp here")


async def _stockx_offer(spec: ProductSpec) -> Optional[Offer]:
    """
    Resolve a StockX 'lowest ask' offer.

    Only valid for condition='new' and likely-sneaker brands.
    See LEARNINGS.md §11 — fail soft, return None on error.
    """
    if spec.condition != "new":
        return None
    if not _is_likely_sneaker(spec):
        return None
    raise NotImplementedError("Wire up StockX unofficial GraphQL here")


_SNEAKER_BRANDS = {
    "nike", "adidas", "jordan", "new balance", "asics",
    "puma", "reebok", "converse", "vans", "yeezy",
}


def _is_likely_sneaker(spec: ProductSpec) -> bool:
    return spec.brand.lower() in _SNEAKER_BRANDS


# ---------------------------------------------------------------------------
# Public tool functions
# ---------------------------------------------------------------------------

async def find_cheapest_amazon(
    brand: str,
    model: str,
    size_us_men: float,
    color: Optional[str] = None,
    condition: Condition = "new",
) -> CheapestOfferResponse:
    spec = ProductSpec(brand, model, size_us_men, color, condition)
    offer = await _amazon_offer(spec)
    return _rank_and_persist(spec, [offer] if offer else [])


async def find_cheapest_retail(
    brand: str,
    model: str,
    size_us_men: float,
    color: Optional[str] = None,
    condition: Condition = "new",
) -> CheapestOfferResponse:
    spec = ProductSpec(brand, model, size_us_men, color, condition)
    results = await asyncio.gather(
        _amazon_offer(spec),
        _walmart_offer(spec),
        return_exceptions=True,
    )
    offers = [r for r in results if isinstance(r, Offer) and r.in_stock]
    return _rank_and_persist(spec, offers)


async def find_cheapest_all(
    brand: str,
    model: str,
    size_us_men: float,
    color: Optional[str] = None,
    condition: Condition = "new",
) -> CheapestOfferResponse:
    spec = ProductSpec(brand, model, size_us_men, color, condition)
    coros = [_amazon_offer(spec), _walmart_offer(spec)]
    if _is_likely_sneaker(spec) and condition == "new":
        coros.append(_stockx_offer(spec))
    results = await asyncio.gather(*coros, return_exceptions=True)
    offers = [r for r in results if isinstance(r, Offer) and r.in_stock]
    return _rank_and_persist(spec, offers)


# ---------------------------------------------------------------------------
# Ranking + persistence
# ---------------------------------------------------------------------------

def _rank_and_persist(
    spec: ProductSpec,
    offers: list[Offer],
) -> CheapestOfferResponse:
    sorted_offers = sorted(offers, key=lambda o: o.price + (o.shipping_cost or 0))
    observation_ids = [_persist_observation(spec, o) for o in sorted_offers]
    return CheapestOfferResponse(
        spec=spec,
        best=sorted_offers[0] if sorted_offers else None,
        all_offers=sorted_offers,
        observation_ids=observation_ids,
    )


def _persist_observation(spec: ProductSpec, offer: Offer) -> str:
    """
    Insert one row into ClickHouse listings_observations and return the row id.

    Schema: ../clickhouse-setup.sql
    """
    raise NotImplementedError("Wire up clickhouse-connect insert here")


def _now_iso() -> str:
    return datetime.now(timezone.utc).isoformat(timespec="seconds")
