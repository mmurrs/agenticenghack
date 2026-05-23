"""
Hermes Agent — PricePilot's Claude-powered orchestrator.

Uses the OpenAI-compatible chat-completions API with tool_choice so it works
with any provider (OpenAI, Anthropic via openai-compat, local models, etc.).
Configure via environment variables (loaded from .env):

  OPENAI_API_KEY    — required
  OPENAI_BASE_URL   — optional, defaults to https://api.openai.com/v1
  OPENAI_MODEL      — optional, defaults to gpt-4o
"""
import os
import json

from openai import OpenAI

from integrations.nimble_client import check_price, product_id_from_url
from integrations.clickhouse_client import (
    store_price_event,
    get_price_history,
    add_tracked_product,
    get_tracked_products,
)
from integrations.senso_client import generate_report

_client = OpenAI(
    api_key=os.environ.get("OPENAI_API_KEY", ""),
    base_url=os.environ.get("OPENAI_BASE_URL", "https://api.openai.com/v1"),
)
_MODEL = os.environ.get("OPENAI_MODEL", "gpt-4o")

TOOLS = [
    {
        "type": "function",
        "function": {
            "name": "track_product",
            "description": "Start tracking a product URL and alert the user when price drops below threshold.",
            "parameters": {
                "type": "object",
                "properties": {
                    "url": {
                        "type": "string",
                        "description": "Amazon or Walmart product URL",
                    },
                    "threshold": {
                        "type": "number",
                        "description": (
                            "Alert price threshold in USD. "
                            "If not provided, defaults to 10% below current price."
                        ),
                    },
                },
                "required": ["url"],
            },
        },
    },
    {
        "type": "function",
        "function": {
            "name": "check_current_price",
            "description": "Get the current price of a product URL.",
            "parameters": {
                "type": "object",
                "properties": {
                    "url": {"type": "string"},
                },
                "required": ["url"],
            },
        },
    },
    {
        "type": "function",
        "function": {
            "name": "get_price_history",
            "description": "Retrieve price history for a tracked product.",
            "parameters": {
                "type": "object",
                "properties": {
                    "product_id": {"type": "string"},
                },
                "required": ["product_id"],
            },
        },
    },
    {
        "type": "function",
        "function": {
            "name": "list_tracked_products",
            "description": "List all products the user is currently tracking with their thresholds.",
            "parameters": {
                "type": "object",
                "properties": {},
                "required": [],
            },
        },
    },
]

SYSTEM_PROMPT = (
    "You are PricePilot, an autonomous price-monitoring assistant. "
    "You help users track product prices on Amazon and Walmart, alert them to drops, "
    "and answer questions about price history. "
    "When a user shares a product URL, use track_product to start monitoring it. "
    "When they ask about current price, use check_current_price. "
    "When they ask what they're tracking, use list_tracked_products. "
    "Always include actual prices and product names in your replies. "
    "Be concise and friendly."
)


def _run_tool(user_id: str, tool_name: str, tool_input: dict) -> str:
    if tool_name == "track_product":
        url = tool_input["url"]
        threshold = tool_input.get("threshold")
        result = check_price(url)
        if result is None:
            return json.dumps({
                "error": (
                    "Could not fetch price for that URL. "
                    "Make sure it's a valid Amazon or Walmart product page."
                )
            })
        product_id = product_id_from_url(url)
        effective_threshold = (
            threshold if threshold is not None else round(result.price * 0.9, 2)
        )
        store_price_event(
            user_id=user_id,
            product_id=product_id,
            product_name=result.title,
            url=url,
            source=result.source,
            price=result.price,
        )
        add_tracked_product(
            user_id=user_id,
            product_id=product_id,
            product_name=result.title,
            amazon_url=url if result.source == "amazon" else "",
            threshold=effective_threshold,
            walmart_url=url if result.source == "walmart" else "",
        )
        return json.dumps({
            "product_name": result.title,
            "current_price": result.price,
            "threshold": effective_threshold,
            "source": result.source,
            "status": "tracking_started",
        })

    elif tool_name == "check_current_price":
        result = check_price(tool_input["url"])
        if result is None:
            return json.dumps({"error": "Could not fetch price"})
        return json.dumps({
            "title": result.title,
            "price": result.price,
            "currency": result.currency,
            "source": result.source,
        })

    elif tool_name == "get_price_history":
        history = get_price_history(tool_input["product_id"])
        return json.dumps({"history": history, "count": len(history)})

    elif tool_name == "list_tracked_products":
        products = get_tracked_products()
        user_products = [p for p in products if p["user_id"] == user_id]
        return json.dumps({"tracked": user_products, "count": len(user_products)})

    return json.dumps({"error": f"Unknown tool: {tool_name}"})


async def run_agent(user_id: str, message: str) -> str:
    messages = [
        {"role": "system", "content": SYSTEM_PROMPT},
        {"role": "user", "content": message},
    ]

    # Agentic tool-use loop
    while True:
        response = _client.chat.completions.create(
            model=_MODEL,
            messages=messages,
            tools=TOOLS,
            tool_choice="auto",
        )

        choice = response.choices[0]

        if choice.finish_reason == "tool_calls":
            assistant_msg = choice.message
            messages.append(assistant_msg)

            for tc in assistant_msg.tool_calls:
                tool_input = json.loads(tc.function.arguments)
                result = _run_tool(user_id, tc.function.name, tool_input)
                messages.append({
                    "role": "tool",
                    "tool_call_id": tc.id,
                    "content": result,
                })
            # continue loop to get final assistant reply
            continue

        # stop — return text
        return choice.message.content or "Sorry, I couldn't process that request."
