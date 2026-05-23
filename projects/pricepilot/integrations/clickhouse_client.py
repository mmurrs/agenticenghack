"""
ClickHouse integration client.

STUB implementation: data is held in module-level lists.
The `get_client` context manager is exported so that real-integration tests
(which mock it) continue to work without modification.
Teammates replace `get_client` and the four public functions with real
ClickHouse queries while keeping the same signatures.
"""
from contextlib import contextmanager
from unittest.mock import MagicMock

# ---------------------------------------------------------------------------
# get_client — exported so existing tests can mock it.
# In the stub it returns a no-op mock; real integration will return a live
# clickhouse_connect client.
# ---------------------------------------------------------------------------

@contextmanager
def get_client():
    """STUB: yields a no-op MagicMock. Replace with real clickhouse_connect client."""
    yield MagicMock()


# ---------------------------------------------------------------------------
# In-memory stores (stub only)
# ---------------------------------------------------------------------------
_tracked: list[dict] = []
_events: list[dict] = []


def store_price_event(
    user_id: str,
    product_id: str,
    product_name: str,
    url: str,
    source: str,
    price: float,
    currency: str = "USD",
) -> None:
    """STUB: Stores in memory. Replace with real ClickHouse insert."""
    from datetime import datetime
    _events.append({
        "user_id": user_id,
        "product_id": product_id,
        "product_name": product_name,
        "url": url,
        "source": source,
        "price": price,
        "currency": currency,
        "timestamp": datetime.utcnow().isoformat(),
    })


def get_price_history(product_id: str, hours: int = 24) -> list[dict]:
    """STUB: Returns in-memory events. Replace with real ClickHouse query."""
    return [e for e in _events if e["product_id"] == product_id]


def add_tracked_product(
    user_id: str,
    product_id: str,
    product_name: str,
    amazon_url: str,
    threshold: float,
    walmart_url: str = "",
) -> None:
    """STUB: Stores in memory. Replace with real ClickHouse insert."""
    _tracked.append({
        "user_id": user_id,
        "product_id": product_id,
        "product_name": product_name,
        "amazon_url": amazon_url,
        "walmart_url": walmart_url,
        "threshold": threshold,
        "active": 1,
    })


def get_tracked_products() -> list[dict]:
    """STUB: Returns in-memory list. Replace with real ClickHouse query."""
    return [p for p in _tracked if p["active"] == 1]
