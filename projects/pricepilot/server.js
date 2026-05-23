import express from "express";
import { fileURLToPath } from "url";
import path from "path";
import { createDual402, dualDiscovery } from "./dual402.js";
import { findCheapestStub } from "./tools/find_cheapest_stub.js";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const app = express();
const PORT = process.env.PORT || 3000;

app.set("trust proxy", true);

app.use(express.json({ limit: "256kb" }));

// Serve static landing page from project root (index.html, favicon.svg, etc.)
app.use(
  express.static(__dirname, {
    extensions: ["html"],
    index: "index.html",
    setHeaders: (res, filepath) => {
      if (filepath.endsWith(".html")) {
        res.setHeader("Cache-Control", "public, max-age=300");
      } else if (filepath.endsWith(".svg")) {
        res.setHeader("Cache-Control", "public, max-age=86400");
      }
    },
  })
);

app.use((req, res, next) => {
  res.setHeader("Access-Control-Allow-Origin", "*");
  res.setHeader("Access-Control-Allow-Methods", "GET, POST, OPTIONS");
  res.setHeader("Access-Control-Allow-Headers", "*");
  res.setHeader(
    "Access-Control-Expose-Headers",
    "WWW-Authenticate, Payment-Receipt, PAYMENT-REQUIRED, PAYMENT-RESPONSE"
  );
  if (req.method === "OPTIONS") return res.sendStatus(204);
  next();
});

const RECIPIENT_WALLET = process.env.RECIPIENT_WALLET;
const TEMPO_USDC = "0x20C000000000000000000000b9537d11c60E8b50";
const BASE_URL = process.env.BASE_URL || process.env.PUBLIC_BASE_URL;
const MPP_REALM = process.env.MPP_REALM || hostnameFromUrl(BASE_URL);

const dual = createDual402({
  baseUrl: BASE_URL,
  mpp: {
    currency: process.env.USDC_TEMPO || TEMPO_USDC,
    recipient:
      process.env.MPP_RECIPIENT || RECIPIENT_WALLET || process.env.RECIPIENT,
    realm: MPP_REALM,
    secretKey: process.env.MPP_SECRET_KEY,
    testnet: process.env.MPP_TESTNET === "true",
  },
  x402: {
    payTo: process.env.X402_PAYEE_ADDRESS || RECIPIENT_WALLET,
    network: process.env.X402_NETWORK || "eip155:84532",
    facilitatorUrl:
      process.env.X402_FACILITATOR_URL || "https://x402.org/facilitator",
  },
});

function hostnameFromUrl(url) {
  if (!url) return undefined;
  try {
    return new URL(url).hostname;
  } catch {
    return undefined;
  }
}

// CDP Bazaar / x402scan / agentic.market discovery block.
// Surfaced inside the 402 PaymentRequired payload as
// `extensions.bazaar.{info, schema}` so registries index a typed listing
// instead of a probe-only fallback. See docs.cdp.coinbase.com/x402/bazaar.
const findCheapestOutputSchema = {
  type: "object",
  properties: {
    product_id: { type: "string" },
    best: {
      type: "object",
      properties: {
        source: { type: "string" },
        price: { type: "number" },
        currency: { type: "string" },
        in_stock: { type: "boolean" },
        seller: { type: "string" },
        url: { type: "string" },
        variant: { type: "object" },
      },
    },
    all_offers: {
      type: "array",
      items: {
        type: "object",
        properties: {
          source: { type: "string" },
          price: { type: "number" },
          in_stock: { type: "boolean" },
          url: { type: "string" },
        },
      },
    },
    missing_sources: { type: "array", items: { type: "string" } },
    checked_at: { type: "string", format: "date-time" },
  },
};

const findCheapestDiscovery = {
  info: {
    type: "http",
    method: "POST",
    bodyType: "json",
    input: {
      body: {
        brand: "Nike",
        model: "Killshot 2",
        color: "Sail/Lucid Green",
        size: { system: "US", gender: "men", value: 11.5 },
        condition: "new",
        postal_code: "10001",
      },
    },
    output: {
      type: "json",
      example: {
        product_id: "nike-killshot-2",
        best: {
          source: "walmart",
          price: 89.97,
          currency: "USD",
          in_stock: true,
          url: "https://www.walmart.com/ip/...",
        },
        all_offers: [
          { source: "walmart", price: 89.97, in_stock: true },
          { source: "amazon", price: 94.99, in_stock: true },
        ],
        missing_sources: ["target"],
        checked_at: "2026-05-23T15:42:11Z",
      },
    },
  },
  schema: {
    $schema: "https://json-schema.org/draft/2020-12/schema",
    type: "object",
    properties: {
      input: {
        type: "object",
        properties: {
          type: { const: "http" },
          method: { enum: ["POST"] },
          bodyType: { enum: ["json"] },
          body: {
            type: "object",
            properties: {
              brand: {
                type: "string",
                description: "Product brand, e.g. 'Nike', 'Sony', 'LEGO'.",
              },
              model: {
                type: "string",
                description:
                  "Specific model, e.g. 'Killshot 2', 'WH-1000XM5', '10497 Galaxy Explorer'.",
              },
              color: {
                type: "string",
                description: "Color or colorway when relevant.",
              },
              size: {
                type: "object",
                description: "Size spec for apparel/footwear.",
                properties: {
                  system: { type: "string", enum: ["US", "EU", "UK"] },
                  gender: {
                    type: "string",
                    enum: ["men", "women", "kids", "unisex"],
                  },
                  value: { type: "number" },
                },
              },
              condition: {
                type: "string",
                enum: ["new", "used", "ds", "any"],
                default: "new",
              },
              postal_code: {
                type: "string",
                description: "ZIP code for retailer pricing localization.",
                default: "10001",
              },
              source_scope: {
                type: "string",
                enum: ["amazon", "retail", "all"],
                default: "retail",
              },
            },
            required: ["brand", "model"],
          },
        },
        required: ["type", "method", "bodyType", "body"],
      },
      output: {
        ...findCheapestOutputSchema,
      },
    },
    required: ["input", "output"],
  },
};

const chargeFindCheapest = dual.charge({
  amount: "0.05",
  description: "Cheapest verified product offer across Amazon and Walmart",
  discovery: findCheapestDiscovery,
});

const findCheapestParams = {
  type: "object",
  required: ["brand", "model"],
  properties: {
    brand: {
      type: "string",
      description: "Product brand, e.g. 'Nike', 'Sony', 'LEGO'.",
    },
    model: {
      type: "string",
      description:
        "Specific model name, e.g. 'Killshot 2', 'WH-1000XM5', '10497 Galaxy Explorer'.",
    },
    color: {
      type: "string",
      description: "Color or colorway when relevant.",
    },
    size: {
      type: "object",
      description: "Size spec for apparel/footwear.",
      properties: {
        system: { type: "string", enum: ["US", "EU", "UK"] },
        gender: { type: "string", enum: ["men", "women", "kids", "unisex"] },
        value: { type: "number" },
      },
    },
    condition: {
      type: "string",
      enum: ["new", "used", "ds", "any"],
      default: "new",
    },
    postal_code: {
      type: "string",
      description: "ZIP code for retailer pricing localization.",
      default: "10001",
    },
    source_scope: {
      type: "string",
      enum: ["amazon", "retail", "all"],
      default: "retail",
      description:
        "'amazon' = Amazon only, 'retail' = Amazon + Walmart, 'all' = future cross-retailer.",
    },
  },
};

const findCheapestResponse = findCheapestOutputSchema;

dualDiscovery(app, dual, {
  info: {
    title: "PricePilot",
    description:
      "Pay-per-call price agent. Name a product, get the cheapest verified buyable offer across Amazon and Walmart — $0.05 per check via x402 or MPP.",
    version: "0.1.0",
    "x-guidance":
      "PricePilot returns the cheapest verified buyable offer for a product. " +
      "POST /find_cheapest with an explicit spec (brand + model, plus variant fields like size, color, storage). " +
      "PricePilot resolves the exact variant on Amazon and Walmart in parallel and returns the offer with the lowest price " +
      "that is currently in stock. The response includes a stable product_id you can reuse to compare prices over time. " +
      "Each check costs $0.05 USD.",
  },
  serviceInfo: {
    categories: ["shopping", "price-comparison", "ecommerce", "amazon", "walmart"],
    docs: {
      homepage: "https://pricepilot-sepia.vercel.app",
    },
  },
  routes: [
    {
      method: "post",
      path: "/find_cheapest",
      handler: chargeFindCheapest,
      operationId: "findCheapestProduct",
      summary: "Cheapest verified buyable offer for a product",
      tags: ["shopping"],
      requestBody: {
        required: true,
        content: {
          "application/json": {
            schema: findCheapestParams,
          },
        },
      },
      responseSchema: findCheapestResponse,
    },
  ],
});

app.post("/find_cheapest", chargeFindCheapest, async (req, res) => {
  try {
    const result = await findCheapestStub(req.body || {});
    res.json(result);
  } catch (err) {
    console.error("[find_cheapest] error:", err);
    res.status(500).json({ error: err.message || "internal error" });
  }
});

app.get("/skill.md", (req, res) => {
  res.type("text/markdown").send(SKILL_MD);
});

app.get("/llms.txt", (req, res) => {
  res.type("text/plain").send(LLMS_TXT);
});

app.get("/health", (req, res) => {
  res.json({ ok: true, service: "pricepilot", version: "0.1.0" });
});

const SKILL_MD = `---
name: pricepilot-find-cheapest
description: Use PricePilot's paid find_cheapest endpoint to find the cheapest verified buyable offer for a specific product across Amazon and Walmart.
version: 1.0.0
author: PricePilot
license: MIT
metadata:
  hermes:
    tags: [Shopping, Price Comparison, Ecommerce, x402, MPP]
---

# PricePilot Find Cheapest

Use this skill when the user asks where to buy a specific product for the lowest price, asks for the cheapest offer, or wants a verified buy link across retailers.

## Endpoint

- Base URL: https://pricepilot-sepia.vercel.app
- Tool call: \`POST /find_cheapest\`
- OpenAPI: https://pricepilot-sepia.vercel.app/openapi.json
- Payment: $0.05 USD per successful check via x402 or MPP.

The endpoint returns verified buyable offers. Do not invent prices or use search-result estimates.

## Request

Send JSON with \`brand\` and \`model\`. Add variant fields whenever the user provides them, especially shoe size, colorway, storage, capacity, or condition.

\`\`\`json
{
  "brand": "Nike",
  "model": "Killshot 2",
  "color": "Sail/Lucid Green",
  "size": { "system": "US", "gender": "men", "value": 11.5 },
  "condition": "new",
  "postal_code": "10001",
  "source_scope": "retail"
}
\`\`\`

Fields:

- \`brand\`: required string.
- \`model\`: required string. Include storage/capacity in this string for electronics when relevant.
- \`color\`: optional string.
- \`size\`: optional object. For shoes, include \`system: "US"\`, \`gender\`, and numeric \`value\`.
- \`condition\`: \`"new"\`, \`"used"\`, \`"ds"\`, or \`"any"\`; default to \`"new"\`.
- \`postal_code\`: ZIP code for localized pricing; default to \`"10001"\` if unknown.
- \`source_scope\`: use \`"retail"\` by default. Use \`"amazon"\` only when the user asks for Amazon-only.

## Payment Flow

Use the agent's available HTTP payment client. If calling directly:

1. POST the request.
2. If the response is \`402 Payment Required\`, read the \`PAYMENT-REQUIRED\` header.
3. Retry with an x402 \`PAYMENT-SIGNATURE\` header or MPP \`Authorization: Payment ...\` header.
4. On success, preserve the \`PAYMENT-RESPONSE\` receipt header when available.

Do not exceed $0.05 for this endpoint unless the user explicitly approves a higher budget.

## Response Handling

The response shape is:

\`\`\`json
{
  "product_id": "nike-killshot-2",
  "best": {
    "source": "walmart",
    "price": 89.97,
    "currency": "USD",
    "in_stock": true,
    "seller": "Walmart",
    "url": "https://www.walmart.com/ip/...",
    "variant": { "color": "Sail/Lucid Green", "size": "11.5" }
  },
  "all_offers": [
    { "source": "walmart", "price": 89.97, "in_stock": true, "url": "https://www.walmart.com/ip/..." },
    { "source": "amazon", "price": 94.99, "in_stock": true, "url": "https://www.amazon.com/dp/..." }
  ],
  "missing_sources": ["target"],
  "checked_at": "2026-05-23T15:42:11Z"
}
\`\`\`

Report the best offer first with retailer, total price if present, seller, and buy URL. Then summarize other in-stock offers if useful.

If \`best\` is \`null\`, tell the user that no verified buyable offer was found and mention any \`missing_sources\`. If the endpoint returns an error asking for \`brand\` or \`model\`, ask one concise follow-up question.

## Examples

User: "Cheapest Sony WH-1000XM5 in black"

Call:

\`\`\`json
{
  "brand": "Sony",
  "model": "WH-1000XM5",
  "color": "black",
  "condition": "new",
  "postal_code": "10001",
  "source_scope": "retail"
}
\`\`\`

User: "Find me Nike Killshot 2 Sail/Lucid Green men's 11.5"

Call:

\`\`\`json
{
  "brand": "Nike",
  "model": "Killshot 2",
  "color": "Sail/Lucid Green",
  "size": { "system": "US", "gender": "men", "value": 11.5 },
  "condition": "new",
  "postal_code": "10001",
  "source_scope": "retail"
}
\`\`\`
`;

const LLMS_TXT = `# PricePilot

> Pay-per-call price agent for shopping bots. Cheapest verified Amazon + Walmart offer in one call. $0.05 per check via MPP or x402.

## What users ask

- "Cheapest Nike Killshot 2 men's size 11.5"
- "Cheapest Sony WH-1000XM5 headphones in black"
- "Cheapest Hoka Clifton 9 women's size 8"
- "Cheapest LEGO 10497 Galaxy Explorer set"

## Endpoint

### POST /find_cheapest

Pass an explicit product spec. PricePilot resolves the exact variant on Amazon and Walmart in parallel and returns the cheapest currently-in-stock offer.

Required fields: \`brand\`, \`model\`. Optional: \`color\`, \`size\`, \`condition\`, \`postal_code\`, \`source_scope\`.

Returns: \`{ product_id, best, all_offers, missing_sources, checked_at }\`.

\`best\` is the cheapest verified buyable offer. \`null\` means no offer found.

## Coverage

- Amazon — live
- Walmart — live
- Target — coming soon

## Payment

- **x402** on Base (mainnet or Sepolia) — facilitator: https://x402.org/facilitator (testnet) or https://api.cdp.coinbase.com/platform/v2/x402 (mainnet)
- **MPP** on Tempo — wallet pays USDC

Both protocols are accepted on every paid endpoint. Use \`AgentCash\` for the simplest onboarding: \`npx agentcash onboard\`.

## Discovery

- OpenAPI: /openapi.json
- x402 well-known: /.well-known/x402
- Skill definition: /skill.md
`;

// Only bind a port when running locally (not on Vercel)
if (process.env.NODE_ENV !== "test" && !process.env.VERCEL) {
  app.listen(PORT, () => {
    console.log(`PricePilot listening on :${PORT}`);
  });
}

export default app;
