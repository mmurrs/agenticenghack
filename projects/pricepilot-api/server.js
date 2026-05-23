import { pathToFileURL } from "node:url";
import express from "express";
import Nimble from "@nimble-way/nimble-js";
import { createDual402, dualDiscovery } from "dual402";

export const app = express();

const PORT = process.env.PORT || 8080;
const SERVICE_NAME = process.env.SERVICE_NAME || "pricepilot-search";
const SERVICE_VERSION = process.env.SERVICE_VERSION || "0.1.0";
const PRICE_AMOUNT = process.env.FIND_CHEAPEST_PRICE || "0.03";
const DEFAULT_ZIP_CODE = process.env.DEFAULT_ZIP_CODE || "10001";
const NIMBLE_TIMEOUT_MS = Number.parseInt(
  process.env.NIMBLE_TIMEOUT_MS || "90000",
  10,
);
const MAX_OFFERS = Number.parseInt(process.env.MAX_OFFERS || "8", 10);

const AGENTS = {
  amazonSearch: process.env.NIMBLE_AMAZON_SEARCH_AGENT || "amazon_serp",
  amazonPdp: process.env.NIMBLE_AMAZON_PDP_AGENT || "amazon_pdp",
  walmartSearch: process.env.NIMBLE_WALMART_SEARCH_AGENT || "walmart_serp",
  walmartPdp: process.env.NIMBLE_WALMART_PDP_AGENT || "walmart_pdp",
};

app.set("trust proxy", true);
app.use(express.json({ limit: "16kb" }));

app.use((req, res, next) => {
  res.setHeader("Access-Control-Allow-Origin", "*");
  res.setHeader("Access-Control-Allow-Methods", "GET, POST, OPTIONS");
  res.setHeader("Access-Control-Allow-Headers", "*");
  res.setHeader(
    "Access-Control-Expose-Headers",
    "WWW-Authenticate, Payment-Receipt, PAYMENT-REQUIRED, PAYMENT-RESPONSE",
  );
  if (req.method === "OPTIONS") return res.sendStatus(204);
  next();
});

const RECIPIENT = process.env.RECIPIENT_WALLET;

let dual;
try {
  dual = createDual402({
    mpp: {
      currency: process.env.USDC_TEMPO,
      recipient: process.env.MPP_RECIPIENT || RECIPIENT,
      secretKey: process.env.MPP_SECRET_KEY,
      realm: process.env.MPP_REALM,
      testnet: process.env.MPP_TESTNET === "true",
    },
    x402: {
      payTo: process.env.X402_PAYEE_ADDRESS || RECIPIENT,
      network: process.env.X402_NETWORK || "eip155:8453",
      facilitatorUrl:
        process.env.X402_FACILITATOR_URL ||
        "https://api.cdp.coinbase.com/platform/v2/x402",
      cdpAuth:
        process.env.CDP_API_KEY_ID && process.env.CDP_API_KEY_SECRET
          ? {
              apiKeyId: process.env.CDP_API_KEY_ID,
              apiKeySecret: process.env.CDP_API_KEY_SECRET,
            }
          : undefined,
    },
  });
} catch (err) {
  console.error(`[BOOT] FATAL: ${err.message}`);
  process.exit(1);
}

let nimbleClient;

function getNimbleClient() {
  if (!process.env.NIMBLE_API_KEY) {
    const err = new Error("NIMBLE_API_KEY is not configured");
    err.statusCode = 500;
    throw err;
  }
  if (!nimbleClient) {
    nimbleClient = new Nimble({
      apiKey: process.env.NIMBLE_API_KEY,
      timeout: NIMBLE_TIMEOUT_MS,
    });
  }
  return nimbleClient;
}

const chargeFindCheapest = dual.charge({
  amount: PRICE_AMOUNT,
  description: "Find cheapest Amazon and Walmart price.",
});

const offerSchema = {
  type: "object",
  properties: {
    source: { type: "string", enum: ["amazon", "walmart"] },
    title: { type: ["string", "null"] },
    price: { type: "number" },
    currency: { type: "string" },
    url: { type: ["string", "null"] },
    in_stock: { type: ["boolean", "null"] },
    seller: { type: ["string", "null"] },
    product_id: { type: ["string", "null"] },
    asin: { type: ["string", "null"] },
    observed_at: { type: "string", format: "date-time" },
  },
  required: ["source", "price", "currency", "observed_at"],
};

const findCheapestInputSchema = {
  type: "object",
  properties: {
    product: {
      type: "string",
      minLength: 2,
      description: "Product search query, e.g. Sony WH-1000XM5",
    },
    zip_code: {
      type: "string",
      description: "US ZIP code for localized retail prices",
    },
    max_results: {
      type: "integer",
      minimum: 1,
      maximum: 20,
      description: "Maximum offers to return",
    },
  },
  required: ["product"],
  additionalProperties: false,
};

const findCheapestOutputSchema = {
  type: "object",
  properties: {
    product: { type: "string" },
    zip_code: { type: "string" },
    cheapest_price: { type: ["number", "null"] },
    currency: { type: "string" },
    best: { anyOf: [offerSchema, { type: "null" }] },
    offers: { type: "array", items: offerSchema },
    source_errors: {
      type: "array",
      items: {
        type: "object",
        properties: {
          source: { type: "string" },
          error: { type: "string" },
        },
        required: ["source", "error"],
      },
    },
    observed_at: { type: "string", format: "date-time" },
    duration_ms: { type: "integer" },
  },
  required: [
    "product",
    "zip_code",
    "cheapest_price",
    "currency",
    "best",
    "offers",
    "source_errors",
    "observed_at",
    "duration_ms",
  ],
};

function readFindCheapestInput(req) {
  const source = req.method === "POST" ? req.body : req.query;
  const product = String(source?.product ?? source?.query ?? "").trim();
  const zipCode = String(source?.zip_code ?? DEFAULT_ZIP_CODE).trim();
  const maxResults = clampInt(source?.max_results, 1, 20, MAX_OFFERS);
  if (product.length < 2) {
    const err = new Error("product is required and must be at least 2 chars");
    err.statusCode = 400;
    throw err;
  }
  return { product: product.slice(0, 200), zipCode, maxResults };
}

async function handleFindCheapest(req, res, next) {
  const startedAt = Date.now();
  try {
    const { product, zipCode, maxResults } = readFindCheapestInput(req);
    const observedAt = new Date().toISOString();
    const settled = await Promise.allSettled([
      resolveAmazon(product, zipCode),
      resolveWalmart(product, zipCode),
    ]);

    const offers = [];
    const sourceErrors = [];
    for (const result of settled) {
      if (result.status === "fulfilled") {
        offers.push(...result.value);
      } else {
        sourceErrors.push({
          source: result.reason?.source || "unknown",
          error: result.reason?.message || "lookup failed",
        });
      }
    }

    const ranked = dedupeOffers(offers)
      .filter((offer) => Number.isFinite(offer.price) && offer.price > 0)
      .filter((offer) => offer.in_stock !== false)
      .sort((a, b) => a.price - b.price)
      .slice(0, maxResults);
    const best = ranked[0] || null;

    res.json({
      product,
      zip_code: zipCode,
      cheapest_price: best?.price ?? null,
      currency: best?.currency || "USD",
      best,
      offers: ranked,
      source_errors: sourceErrors,
      observed_at: observedAt,
      duration_ms: Date.now() - startedAt,
    });
  } catch (err) {
    next(err);
  }
}

async function resolveAmazon(product, zipCode) {
  const source = "amazon";
  try {
    const search = await runNimbleAgent(AGENTS.amazonSearch, {
      keyword: product,
      zip_code: zipCode,
    });
    const searchOffers = offersFromNimble(search, source);
    const asin = firstValue(searchOffers, "asin") || findValue(search, "asin");
    if (!asin) return searchOffers;

    try {
      const pdp = await runNimbleAgent(AGENTS.amazonPdp, {
        asin,
        zip_code: zipCode,
      });
      const pdpOffers = offersFromNimble(pdp, source);
      return pdpOffers.length > 0 ? pdpOffers : searchOffers;
    } catch {
      return searchOffers;
    }
  } catch (err) {
    err.source = source;
    throw err;
  }
}

async function resolveWalmart(product, zipCode) {
  const source = "walmart";
  try {
    const search = await runNimbleAgent(AGENTS.walmartSearch, {
      keyword: product,
      zipcode: zipCode,
    });
    const searchOffers = offersFromNimble(search, source);
    const productId =
      firstValue(searchOffers, "product_id") ||
      firstValue(searchOffers, "item_id") ||
      findValue(search, "product_id") ||
      findValue(search, "product_item_id") ||
      findValue(search, "primary_us_id");
    if (!productId) return searchOffers;

    try {
      const pdp = await runNimbleAgent(AGENTS.walmartPdp, {
        product_id: productId,
        zipcode: zipCode,
      });
      const pdpOffers = offersFromNimble(pdp, source);
      return pdpOffers.length > 0 ? pdpOffers : searchOffers;
    } catch {
      return searchOffers;
    }
  } catch (err) {
    err.source = source;
    throw err;
  }
}

async function runNimbleAgent(agent, params) {
  return getNimbleClient().agent.run(
    { agent, params },
    { maxRetries: 1, timeout: NIMBLE_TIMEOUT_MS },
  );
}

function offersFromNimble(response, source) {
  const root =
    response?.data?.parsing?.entities ??
    response?.data?.parsing ??
    response?.data ??
    response;
  const candidates = collectOfferCandidates(root, source, response?.url);
  return candidates.map((offer) => ({
    source,
    title: offer.title || null,
    price: offer.price,
    currency: offer.currency || "USD",
    url: offer.url || response?.url || null,
    in_stock: offer.in_stock,
    seller: offer.seller || source,
    product_id: offer.product_id,
    asin: offer.asin,
    item_id: offer.item_id,
    observed_at: new Date().toISOString(),
  }));
}

function collectOfferCandidates(value, source, fallbackUrl) {
  const offers = [];
  const seen = new Set();

  function visit(node, depth) {
    if (depth > 7 || node == null) return;
    if (Array.isArray(node)) {
      for (const item of node.slice(0, 60)) visit(item, depth + 1);
      return;
    }
    if (typeof node !== "object") return;

    const offer = objectToOffer(node, source, fallbackUrl);
    if (offer) {
      const key = `${offer.source}:${offer.url || ""}:${offer.title || ""}:${
        offer.price
      }`;
      if (!seen.has(key)) {
        seen.add(key);
        offers.push(offer);
      }
    }

    for (const [key, child] of Object.entries(node)) {
      if (SKIP_KEYS.has(key)) continue;
      if (typeof child === "string" && child.length > 5000) continue;
      visit(child, depth + 1);
    }
  }

  visit(value, 0);
  return offers;
}

const SKIP_KEYS = new Set([
  "html",
  "markdown",
  "pages_html",
  "screenshots",
  "browser_actions",
  "network_capture",
  "fetch",
  "headers",
  "cookies",
  "debug",
]);

function objectToOffer(obj, source, fallbackUrl) {
  const price = extractPrice(obj);
  if (!Number.isFinite(price) || price <= 0) return null;
  return {
    source,
    price,
    currency: extractCurrency(obj),
    title: firstString(obj, [
      "product_title",
      "title",
      "name",
      "productName",
      "product_name",
    ]),
    url:
      firstString(obj, ["url", "link", "product_url", "productUrl"]) ||
      productUrlFromIds(obj, source) ||
      fallbackUrl,
    in_stock: extractInStock(obj),
    seller: firstString(obj, ["seller", "merchant", "seller_name", "retailer"]),
    asin: firstString(obj, ["asin", "ASIN", "child_asin", "parent_asin"]),
    product_id: firstString(obj, [
      "product_id",
      "primary_us_id",
      "product_item_id",
      "product_alternate_id",
    ]),
    item_id: firstString(obj, [
      "item_id",
      "itemId",
      "usItemId",
      "product_item_id",
      "primary_us_id",
    ]),
  };
}

function extractPrice(obj) {
  const preferred = [
    "web_price",
    "sale_price",
    "current_price",
    "buybox_price",
    "final_price",
    "offer_price",
    "price",
    "list_price",
  ];
  for (const key of preferred) {
    const price = parsePrice(obj[key]);
    if (Number.isFinite(price) && price > 0) return price;
  }
  for (const [key, value] of Object.entries(obj)) {
    const normalized = key.toLowerCase();
    if (!normalized.includes("price")) continue;
    if (normalized.includes("shipping")) continue;
    const price = parsePrice(value);
    if (Number.isFinite(price) && price > 0) return price;
  }
  return null;
}

function parsePrice(value) {
  if (typeof value === "number") return value;
  if (typeof value === "string") {
    const match = value.replace(/,/g, "").match(/(?:USD|\$)?\s*(\d+(\.\d+)?)/i);
    return match ? Number.parseFloat(match[1]) : null;
  }
  if (value && typeof value === "object") {
    for (const key of ["amount", "value", "price", "raw", "display"]) {
      const price = parsePrice(value[key]);
      if (Number.isFinite(price) && price > 0) return price;
    }
  }
  return null;
}

function extractCurrency(obj) {
  return (
    firstString(obj, ["currency", "currency_code", "price_currency"]) || "USD"
  ).toUpperCase();
}

function extractInStock(obj) {
  for (const key of ["in_stock", "inStock", "available", "is_available"]) {
    if (typeof obj[key] === "boolean") return obj[key];
  }
  const availability = firstString(obj, ["availability", "stock", "status"]);
  if (!availability) return null;
  const normalized = availability.toLowerCase();
  if (
    normalized.includes("out of stock") ||
    normalized.includes("unavailable") ||
    normalized.includes("sold out")
  ) {
    return false;
  }
  if (normalized.includes("in stock") || normalized.includes("available")) {
    return true;
  }
  return null;
}

function productUrlFromIds(obj, source) {
  if (source === "amazon") {
    const asin = firstString(obj, ["asin", "ASIN", "child_asin", "parent_asin"]);
    return asin ? `https://www.amazon.com/dp/${asin}` : null;
  }
  if (source === "walmart") {
    const itemId = firstString(obj, [
      "item_id",
      "itemId",
      "usItemId",
      "product_id",
      "primary_us_id",
      "product_item_id",
    ]);
    return itemId ? `https://www.walmart.com/ip/${itemId}` : null;
  }
  return null;
}

function firstString(obj, keys) {
  for (const key of keys) {
    const value = obj?.[key];
    if (typeof value === "string" && value.trim()) return value.trim();
    if (typeof value === "number" && Number.isFinite(value)) return String(value);
  }
  return null;
}

function firstValue(items, key) {
  for (const item of items) {
    if (item?.[key]) return item[key];
  }
  return null;
}

function findValue(value, wantedKey) {
  if (value == null || typeof value !== "object") return null;
  if (!Array.isArray(value) && value[wantedKey]) return String(value[wantedKey]);
  for (const child of Array.isArray(value) ? value : Object.values(value)) {
    const found = findValue(child, wantedKey);
    if (found) return found;
  }
  return null;
}

function findUrl(value, domain) {
  if (typeof value === "string") return value.includes(domain) ? value : null;
  if (value == null || typeof value !== "object") return null;
  for (const child of Array.isArray(value) ? value : Object.values(value)) {
    const found = findUrl(child, domain);
    if (found) return found;
  }
  return null;
}

function dedupeOffers(offers) {
  const seen = new Set();
  const out = [];
  for (const offer of offers) {
    const key = `${offer.source}:${offer.url || ""}:${offer.title || ""}:${
      offer.price
    }`;
    if (seen.has(key)) continue;
    seen.add(key);
    out.push(offer);
  }
  return out;
}

function clampInt(value, min, max, fallback) {
  const parsed = Number.parseInt(value, 10);
  if (!Number.isFinite(parsed)) return fallback;
  return Math.max(min, Math.min(max, parsed));
}

app.post("/v1/find-cheapest", chargeFindCheapest, handleFindCheapest);
app.get("/v1/find-cheapest", chargeFindCheapest, handleFindCheapest);

app.get("/", (req, res) => {
  res.json({
    service: SERVICE_NAME,
    docs: "/openapi.json",
    x402: "/.well-known/x402",
    verify: "/verify",
    route: "/v1/find-cheapest",
  });
});

app.get("/verify", (req, res) => {
  res.json({
    service: {
      name: SERVICE_NAME,
      version: SERVICE_VERSION,
    },
    code: {
      commit: process.env.GIT_SHA || "local",
      built_at: process.env.BUILD_TIME || "unknown",
      repo: process.env.REPO_URL || null,
    },
    runtime: {
      app_id: process.env.APP_ID || null,
      environment: process.env.ENVIRONMENT || null,
    },
    payment: {
      x402: {
        network: process.env.X402_NETWORK || "eip155:8453",
        facilitator: new URL(
          process.env.X402_FACILITATOR_URL ||
            "https://api.cdp.coinbase.com/platform/v2/x402",
        ).host,
        payee: process.env.X402_PAYEE_ADDRESS || RECIPIENT || null,
      },
      mpp: {
        rail: "tempo",
        payee: process.env.MPP_RECIPIENT || RECIPIENT || null,
      },
    },
    upstreams: {
      nimble: {
        configured: Boolean(process.env.NIMBLE_API_KEY),
        agents: AGENTS,
      },
    },
    framework: { name: "dual402", homepage: "https://github.com/mmurrs/dual402" },
  });
});

dualDiscovery(app, dual, {
  info: {
    title: SERVICE_NAME,
    version: SERVICE_VERSION,
    description:
      "Paid product price lookup API for Amazon and Walmart, powered by Nimble.",
    "x-guidance":
      "POST /v1/find-cheapest with { product }. GET /v1/find-cheapest?product=... is a query-string alias. Expect 402 until payment attached.",
  },
  routes: [
    {
      method: "post",
      path: "/v1/find-cheapest",
      handler: chargeFindCheapest,
      operationId: "postFindCheapest",
      tags: ["prices"],
      summary: "Find the cheapest Amazon/Walmart price",
      description:
        "POST a product query. Returns the lowest priced Amazon or Walmart offer.",
      requestBodySchema: findCheapestInputSchema,
      responseSchema: findCheapestOutputSchema,
    },
    {
      method: "get",
      path: "/v1/find-cheapest",
      handler: chargeFindCheapest,
      operationId: "getFindCheapest",
      tags: ["prices"],
      summary: "Find the cheapest Amazon/Walmart price (GET alias)",
      description:
        "GET query-string alias of POST /v1/find-cheapest for curl and browsers.",
      parameters: [
        {
          name: "product",
          in: "query",
          required: true,
          schema: { type: "string", minLength: 2 },
          description: "Product search query",
        },
        {
          name: "zip_code",
          in: "query",
          required: false,
          schema: { type: "string" },
          description: "US ZIP code for localized retail prices",
        },
        {
          name: "max_results",
          in: "query",
          required: false,
          schema: { type: "integer", minimum: 1, maximum: 20 },
          description: "Maximum offers to return",
        },
      ],
      responseSchema: findCheapestOutputSchema,
    },
  ],
});

app.use((err, req, res, next) => {
  if (res.headersSent) return next(err);
  const status = err.statusCode || err.status || 500;
  res.status(status).json({
    error: {
      message: status >= 500 ? "lookup failed" : err.message,
      detail: status >= 500 ? err.message : undefined,
    },
  });
});

export function startServer(port = PORT) {
  const facilitatorHost = new URL(
    process.env.X402_FACILITATOR_URL ||
      "https://api.cdp.coinbase.com/platform/v2/x402",
  ).host;
  return app.listen(port, () => {
    console.log(
      `[BOOT] ${SERVICE_NAME} ` +
        `commit=${process.env.GIT_SHA || "local"} ` +
        `built=${process.env.BUILD_TIME || "unknown"} ` +
        `port=${port} ` +
        `x402=${process.env.X402_NETWORK || "eip155:8453"} ` +
        `facilitator=${facilitatorHost} ` +
        `cdp_auth=${process.env.CDP_API_KEY_ID && process.env.CDP_API_KEY_SECRET ? "configured" : "missing"} ` +
        `mpp=${process.env.MPP_SECRET_KEY ? "configured" : "missing"} ` +
        `nimble=${process.env.NIMBLE_API_KEY ? "configured" : "missing"}`,
    );
  });
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  startServer();
}
