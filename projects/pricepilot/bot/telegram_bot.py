import os
import logging
from telegram import Update
from telegram.ext import Application, MessageHandler, filters, ContextTypes

logger = logging.getLogger(__name__)

_app: Application | None = None


def get_app() -> Application:
    global _app
    if _app is None:
        token = os.environ["TELEGRAM_BOT_TOKEN"]
        _app = Application.builder().token(token).build()
    return _app


async def send_message(user_id: str | int, text: str) -> None:
    app = get_app()
    await app.bot.send_message(chat_id=user_id, text=text, parse_mode="Markdown")


async def send_alert(
    user_id: str | int, product_name: str, price: float, report_url: str
) -> None:
    text = (
        f"🚨 *Price Drop Alert!*\n\n"
        f"*{product_name}* is now *${price:.2f}*\n\n"
        f"[View full price analysis]({report_url})"
    )
    await send_message(user_id, text)


async def _handle_message(
    update: Update, context: ContextTypes.DEFAULT_TYPE
) -> None:
    from agent.hermes_agent import run_agent

    user_id = str(update.effective_user.id)
    text = update.message.text or ""
    logger.info("Message from %s: %s", user_id, text)

    response = await run_agent(user_id=user_id, message=text)
    await update.message.reply_text(response)


def run_bot() -> None:
    app = get_app()
    app.add_handler(
        MessageHandler(filters.TEXT & ~filters.COMMAND, _handle_message)
    )

    webhook_url = os.environ.get("TELEGRAM_WEBHOOK_URL")
    if webhook_url:
        app.run_webhook(
            listen="0.0.0.0",
            port=8080,
            webhook_url=webhook_url,
        )
    else:
        logger.info("Starting bot in polling mode")
        app.run_polling()
