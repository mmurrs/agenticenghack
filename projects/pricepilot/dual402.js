/**
 * dual402.js — Express middleware that accepts both x402 and MPP payments.
 *
 * x402: Generates PAYMENT-REQUIRED header, verifies via facilitator.
 * MPP:  Delegates to mppx (stateless HMAC challenges, USDC settlement).
 *
 * No new npm dependencies — x402 side is just HTTP calls to the facilitator.
 */

import { Mppx, tempo } from "mppx/express";

// ── Default USDC addresses per CAIP-2 network ───────────────────────────

const USDC_BY_NETWORK = {
  "eip155:84532": "0x036CbD53842c5426634e7929541eC2318f3dCF7e", // Base Sepolia
  "eip155:8453": "0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913", // Base Mainnet
  "eip155:1": "0xA0b86991c6218b36c1d19D4a2e9Eb0cE3606eB48", // Ethereum
};

// ── Create dual handler ─────────────────────────────────────────────────

/**
 * @param {object} config
 * @param {object} config.mpp          - MPP config: { currency, recipient, secretKey }
 * @param {object} config.x402         - x402 config: { payTo, network, facilitatorUrl, asset? }
 */
export function createDual402(config) {
  const mppx = Mppx.create({
    methods: [
      tempo.charge({
        currency: config.mpp.currency,
        recipient: config.mpp.recipient,
        ...(config.mpp.testnet && { testnet: true }),
      }),
    ],
    secretKey: config.mpp.secretKey,
  });

  const x402Asset =
    config.x402.asset ?? USDC_BY_NETWORK[config.x402.network];
  if (!x402Asset) {
    throw new Error(
      `No default USDC for network "${config.x402.network}". Set x402.asset explicitly.`
    );
  }

  return {
    _mppx: mppx,
    _x402Config: config.x402,
    _x402Asset: x402Asset,

    /**
     * Returns Express middleware that gates a route behind payment.
     * Accepts both x402 (PAYMENT-SIGNATURE) and MPP (Authorization: Payment).
     *
     * @param {object} opts - { amount: string, description?: string }
     */
    charge(opts) {
      const { amount, description } = opts;

      // MPP charge handler — used for both credential verification and challenge generation
      const mppCharge = mppx.charge({ amount, description });

      // x402 amount in smallest unit (USDC = 6 decimals)
      const amountRaw = Math.round(parseFloat(amount) * 1e6).toString();

      // Stash amount for discovery to read
      const handler = async (req, res, next) => {
        try {
          // ── Path 1: x402 credential ──
          // v2 header: PAYMENT-SIGNATURE, v1 legacy: X-PAYMENT
          const x402Sig =
            req.headers["payment-signature"] ?? req.headers["x-payment"];

          if (x402Sig) {
            const verified = await x402Verify(
              x402Sig,
              config.x402.facilitatorUrl,
              { amount: amountRaw, payTo: config.x402.payTo }
            );
            if (verified.valid) {
              console.log(`[PAY] x402 verified amount=${amount} network=${config.x402.network}`);
              // Settle async — don't block the response
              x402Settle(x402Sig, config.x402.facilitatorUrl)
                .then(() => console.log(`[PAY] x402 settled amount=${amount}`))
                .catch((err) =>
                  console.error("[PAY] x402 settle error:", err.message)
                );
              // Attach receipt header if we got a tx hash back
              if (verified.txHash) {
                res.setHeader(
                  "PAYMENT-RESPONSE",
                  Buffer.from(
                    JSON.stringify({
                      success: true,
                      txHash: verified.txHash,
                      network: config.x402.network,
                    })
                  ).toString("base64")
                );
              }
              return next();
            }
            // Invalid x402 credential — fall through to 402
            console.warn("[dual402] x402 verification failed");
          }

          // ── Path 2 & 3: Delegate to mppx, inject x402 header on 402 ──
          //
          // Strategy: intercept mppx's res.status(402) call to add the
          // x402 PAYMENT-REQUIRED header before the response is sent.
          // This way mppx handles both MPP credentials and challenge
          // generation, and we just layer x402 on top of the 402.

          const baseUrl =
            process.env.BASE_URL || `${req.protocol}://${req.get("host")}`;
          const resourceUrl = `${baseUrl}${req.originalUrl}`;
          const paymentRequired = {
            x402Version: 2,
            accepts: [
              {
                scheme: "exact",
                network: config.x402.network,
                amount: amountRaw,
                asset: x402Asset,
                payTo: config.x402.payTo,
                maxTimeoutSeconds: 300,
                extra: {
                  name: "USDC",
                  version: "2",
                  resourceUrl,
                },
              },
            ],
            resource: {
              url: resourceUrl,
              description: description || "",
              mimeType: "application/json",
            },
          };

          // Intercept: when mppx sets status 402, also add x402 header
          const origStatus = res.status.bind(res);
          res.status = (code) => {
            if (code === 402) {
              res.setHeader(
                "PAYMENT-REQUIRED",
                Buffer.from(JSON.stringify(paymentRequired)).toString("base64")
              );
            }
            return origStatus(code);
          };

          return mppCharge(req, res, (...args) => {
            console.log(`[PAY] mpp verified amount=${amount}`);
            next(...args);
          });
        } catch (err) {
          console.error("[dual402] middleware error:", err);
          next(err);
        }
      };
      handler._dualAmount = amount;
      return handler;
    },
  };
}

// ── x402 facilitator HTTP calls ─────────────────────────────────────────

async function x402Verify(paymentSignature, facilitatorUrl, expected) {
  try {
    const payload = JSON.parse(
      Buffer.from(paymentSignature, "base64").toString("utf-8")
    );

    // Validate amount and payee before even hitting the facilitator
    if (expected) {
      const paymentAmount = payload.amount ?? payload.value;
      if (
        paymentAmount !== undefined &&
        expected.amount !== undefined &&
        String(paymentAmount) !== String(expected.amount)
      ) {
        console.warn(
          `[dual402] x402 amount mismatch: got ${paymentAmount}, expected ${expected.amount}`
        );
        return { valid: false, reason: "amount_mismatch" };
      }
      const paymentPayee = (payload.payTo ?? payload.to ?? "").toLowerCase();
      if (
        paymentPayee &&
        expected.payTo &&
        paymentPayee !== expected.payTo.toLowerCase()
      ) {
        console.warn(
          `[dual402] x402 payee mismatch: got ${paymentPayee}, expected ${expected.payTo}`
        );
        return { valid: false, reason: "payee_mismatch" };
      }
    }

    const res = await fetch(`${facilitatorUrl}/verify`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ payload }),
    });

    if (!res.ok) {
      const text = await res.text().catch(() => "");
      console.warn(`[dual402] facilitator /verify ${res.status}: ${text}`);
      return { valid: false };
    }

    return await res.json();
  } catch (err) {
    console.error("[dual402] x402 verify error:", err.message);
    return { valid: false };
  }
}

async function x402Settle(paymentSignature, facilitatorUrl) {
  const payload = JSON.parse(
    Buffer.from(paymentSignature, "base64").toString("utf-8")
  );

  const res = await fetch(`${facilitatorUrl}/settle`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ payload }),
  });

  if (!res.ok) {
    const text = await res.text().catch(() => "");
    throw new Error(`facilitator /settle ${res.status}: ${text}`);
  }

  return res.json();
}

// ── Discovery (mounts /openapi.json and /.well-known/x402) ─────────────

/**
 * Build an AgentCash-compliant OpenAPI 3.1.0 spec.
 *
 * @param {import('express').Express} app
 * @param {object} dual - return value of createDual402()
 * @param {object} config - { info, serviceInfo, routes }
 *   route shape: { method, path, handler, summary, operationId, tags, parameters }
 */
export function dualDiscovery(app, dual, config) {
  const paths = {};

  for (const r of config.routes) {
    const amount = r.handler._dualAmount ?? "0.02";

    const operation = {
      operationId: r.operationId,
      summary: r.summary,
      tags: r.tags ?? [],
      "x-payment-info": {
        price: {
          mode: "fixed",
          currency: "USD",
          amount: parseFloat(amount).toFixed(6),
        },
        protocols: [
          { x402: {} },
          { mpp: { method: "", intent: "", currency: "" } },
        ],
      },
      responses: {
        200: {
          description: "Successful response",
          content: {
            "application/json": {
              schema: r.responseSchema ?? {
                type: "object",
                properties: {
                  results: { type: "array", items: { type: "object" } },
                },
                required: ["results"],
              },
            },
          },
        },
        402: { description: "Payment Required" },
      },
    };

    // Input schema — query parameters for GET routes
    if (r.parameters?.length) {
      operation.parameters = r.parameters;
    }

    paths[r.path] = { [r.method]: operation };
  }

  const spec = {
    openapi: "3.1.0",
    info: {
      title: config.info.title,
      version: config.info.version,
      description: config.info.description,
      ...(config.info["x-guidance"] && {
        "x-guidance": config.info["x-guidance"],
      }),
    },
    "x-discovery": {
      ownershipProofs: config.ownershipProofs ?? [],
    },
    paths,
  };

  if (config.serviceInfo) {
    spec["x-service-info"] = config.serviceInfo;
  }

  app.get("/openapi.json", (req, res) => {
    res.json(spec);
  });

  // /.well-known/x402 v1 — simple resource list
  app.get("/.well-known/x402", (req, res) => {
    res.json({
      version: 1,
      resources: config.routes.map(
        (r) => `${r.method.toUpperCase()} ${r.path}`
      ),
    });
  });
}
