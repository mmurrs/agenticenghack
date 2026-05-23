import asyncio
import logging
from dotenv import load_dotenv

load_dotenv()
logging.basicConfig(
    level=logging.INFO,
    format="%(asctime)s %(levelname)s %(name)s: %(message)s",
)

from agent.polling import run_polling_loop
from bot.telegram_bot import get_app, _handle_message
from telegram.ext import MessageHandler, filters


async def main() -> None:
    app = get_app()
    app.add_handler(MessageHandler(filters.TEXT & ~filters.COMMAND, _handle_message))

    async with app:
        await app.start()
        polling_task = asyncio.create_task(run_polling_loop())
        await app.updater.start_polling()
        try:
            await asyncio.Event().wait()  # run forever
        finally:
            polling_task.cancel()
            await app.updater.stop()
        await app.stop()


if __name__ == "__main__":
    asyncio.run(main())
