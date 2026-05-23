def generate_report(
    product_name: str,
    price_history: list[dict],
    sources: list[str],
    current_price: float,
    threshold: float,
) -> str | None:
    """STUB: Returns fake URL. Replace with real Senso.ai report generation."""
    return f"https://cited.md/stub-report/{product_name.replace(' ', '-').lower()}"
