#!/usr/bin/env python3
"""CLI: find cheapest product via Nimble agents (search/tools.py).
Called by Hermes find-best-price skill when brand/model are known.
Usage (shoe): python tools/find_cheapest.py --brand Crocs --model "Classic Clog" --size 10 --gender men --color white
Usage (generic): python tools/find_cheapest.py --brand Sony --model "WH-1000XM5"
"""
from __future__ import annotations

import argparse
import asyncio
import json
import sys
from dataclasses import asdict
from pathlib import Path

# Repo root so `from search.tools import ...` resolves
_REPO_ROOT = Path(__file__).resolve().parents[3]
sys.path.insert(0, str(_REPO_ROOT))
# Pricepilot root so integrations/ is importable
sys.path.insert(0, str(Path(__file__).resolve().parents[1]))

from dotenv import load_dotenv

load_dotenv(Path.home() / ".hermes/.env")


def parse_args() -> argparse.Namespace:
    p = argparse.ArgumentParser()
    p.add_argument("--brand", required=True)
    p.add_argument("--model", required=True)
    p.add_argument("--size", type=float, default=None,
                   help="US shoe size (e.g. 10, 11.5). Only required for footwear/clothing.")
    p.add_argument("--gender", choices=["men", "women", "kids", "unisex"], default="men")
    p.add_argument("--color", default=None)
    p.add_argument("--category", default="general",
                   help="Product category: 'shoes', 'electronics', 'general', etc.")
    p.add_argument("--postal-code", default="10001")
    p.add_argument("--scope", choices=["amazon", "retail", "all"], default="amazon")
    p.add_argument("--user-id", default=None)
    p.add_argument("--query", default=None)
    return p.parse_args()


async def main() -> int:
    args = parse_args()
    try:
        from search.tools import find_cheapest_product

        # Only build size dict if --size was provided
        size_arg = (
            {"system": "US", "gender": args.gender, "value": args.size}
            if args.size is not None
            else None
        )

        result = await find_cheapest_product(
            brand=args.brand,
            model=args.model,
            color=args.color,
            size=size_arg,
            category=args.category,
            postal_code=args.postal_code,
            source_scope=args.scope,
            query=args.query or f"{args.brand} {args.model}",
            user_id=args.user_id,
        )
        print(json.dumps(asdict(result)))
        return 0 if result.best else 1
    except Exception as e:
        print(json.dumps({"error": str(e)}))
        return 1


if __name__ == "__main__":
    sys.exit(asyncio.run(main()))
