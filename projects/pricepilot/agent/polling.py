import asyncio
import logging

from integrations.clickhouse_client import (
    get_tracked_products,
    get_price_history,
    store_price_event,
)
from integrations.nimble_client import check_price
from integrations.senso_client import generate_report

logger = logging.getLogger(__name__)

POLL_INTERVAL_SECONDS = 600  # 10 minutes


async def check_all_tracked() -> None:
    from bot.telegram_bot import send_alert

    products = get_tracked_products()
    logger.info("Polling %d tracked products", len(products))

    for product in products:
        url = product.get("amazon_url") or product.get("walmart_url", "")
        if not url:
            continue

        result = check_price(url)
        if result is None:
            logger.warning("Failed to scrape price for %s", product["product_id"])
            continue

        store_price_event(
            user_id=product["user_id"],
            product_id=product["product_id"],
            product_name=product["product_name"],
            url=url,
            source=result.source,
            price=result.price,
        )

        logger.info(
            "%s: $%.2f (threshold: $%.2f)",
            product["product_name"],
            result.price,
            product["threshold"],
        )

        if result.price < product["threshold"]:
            logger.info("Price drop detected for %s — generating report", product["product_name"])
            history = get_price_history(product["product_id"])
            report_url = generate_report(
                product_name=product["product_name"],
                price_history=history,
                sources=[url],
                current_price=result.price,
                threshold=product["threshold"],
            )
            if report_url:
                await send_alert(
                    user_id=product["user_id"],
                    product_name=product["product_name"],
                    price=result.price,
                    report_url=report_url,
                )


async def run_polling_loop() -> None:
    logger.info("Starting polling loop (interval: %ds)", POLL_INTERVAL_SECONDS)
    while True:
        try:
            await check_all_tracked()
        except Exception as exc:
            logger.exception("Polling error: %s", exc)
        await asyncio.sleep(POLL_INTERVAL_SECONDS)
