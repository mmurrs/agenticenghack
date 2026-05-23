from dataclasses import dataclass


@dataclass
class PriceResult:
    title: str
    price: float
    currency: str
    source: str   # "amazon" | "walmart"
    url: str


def check_price(url: str) -> PriceResult | None:
    """STUB: Returns fake price data. Replace with real Nimble scraper."""
    import re
    source = "walmart" if "walmart" in url else "amazon"
    return PriceResult(
        title="Demo Product (stub)",
        price=99.99,
        currency="USD",
        source=source,
        url=url,
    )


def product_id_from_url(url: str) -> str:
    """Extract product ID from Amazon or Walmart URL."""
    import re
    match = re.search(r"/(?:dp|product)/([A-Z0-9]{10})", url)
    if match:
        return match.group(1)
    match = re.search(r"/ip/[^/]+/(\d+)", url)
    if match:
        return match.group(1)
    import hashlib
    return hashlib.md5(url.encode()).hexdigest()[:10]
