---
name: find-best-price
description: Find the cheapest price for a shoe or product using Nimble agents. Use when the user asks "find best price for X", "how much does X cost?", "where can I buy X cheapest?", or any open-ended price discovery question without a specific URL.
triggers:
  - "find best price"
  - "best price for"
  - "cheapest"
  - "how much does"
  - "where can I buy"
  - "find price"
  - "search for price"
  - "price of"
---

# find-best-price

Search Amazon for the cheapest offer for a specific product using Nimble's agent-based search.

## When to use

Use this skill when the user asks about prices WITHOUT providing a specific product URL. For a known URL, use `check-price` or `track-product` instead.

## Step 1 — Extract structured fields

Parse the user's message into these fields. **Do not guess size — ask if missing.**

| Field | Required | Notes |
|-------|----------|-------|
| `brand` | yes | e.g. "Crocs", "Nike" |
| `model` | yes | e.g. "Classic Clog", "Killshot 2" |
| `size` | **yes — ask if missing** | numeric US size, e.g. 10 or 11.5 |
| `gender` | no | "men" / "women" / "kids" / "unisex" — default "men" |
| `color` | no | strongly recommended for accuracy |

If size is missing, ask: "What size are you looking for? (US size, e.g. 10)"

## Step 2 — Run the search tool

```
cd $PRICEPILOT_DIR && python tools/find_cheapest.py \
  --brand "<brand>" \
  --model "<model>" \
  --size <size> \
  --gender <gender> \
  --color "<color>" \
  --query "<original user query>"
```

Omit `--color` if not provided. The tool prints a JSON object (`CheapestOfferResponse`).

## Step 3 — Format the response

**If a best offer is found** (`best` key is not null):

```
🏷️ Best price for **<brand> <model>** (Size <size>, <gender>):

**$<best.price>** on <best.source> — [<best.title>](<best.url>)
Total with shipping: $<best.total_price>
In stock: ✅

Other offers checked:
| Store | Price | Title |
|-------|-------|-------|
| <source> | $<price> | <title> |
...

Want me to track this and alert you when it drops below a target? Say "track <url> under $X"
```

**If no best offer** (`best` is null):

```
I couldn't find a buyable offer for **<brand> <model>** size <size> on Amazon right now.
Try:
- A slightly different size or color
- Pasting a direct Amazon/Walmart URL (I can check that with `check-price`)
```

## Error handling

- If the tool prints `{"error": "..."}`, apologize and suggest checking a direct product URL with `check-price`.
- If `size.value` is not recognized, ask the user to clarify (whole or half size).
- The `missing_sources` array in the response lists sources that had no offer or are not yet wired — ignore those silently unless all sources failed.
