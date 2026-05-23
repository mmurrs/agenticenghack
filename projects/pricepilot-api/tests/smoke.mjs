import { test } from "node:test";
import assert from "node:assert/strict";

function applyMockEnv() {
  process.env.MPP_SECRET_KEY = "0".repeat(64);
  process.env.USDC_TEMPO = "0x20C068fa8e3b47B2A6f46c3b40b9537d11c60E8b50";
  process.env.RECIPIENT_WALLET = "0x1111111111111111111111111111111111111111";
  process.env.X402_NETWORK = "eip155:84532";
  process.env.X402_FACILITATOR_URL = "https://x402.org/facilitator";
  process.env.MPP_TESTNET = "true";
  process.env.PORT = "0";
}

async function waitForListening(server) {
  if (server.address()) return;
  await new Promise((resolve) => setImmediate(resolve));
  if (server.address()) return;
  await new Promise((resolve) => server.once("listening", resolve));
}

test("server module loads with mock env", async () => {
  applyMockEnv();
  const { createDual402, dualDiscovery } = await import("dual402");
  assert.equal(typeof createDual402, "function");
  assert.equal(typeof dualDiscovery, "function");

  const dual = createDual402({
    mpp: {
      currency: process.env.USDC_TEMPO,
      recipient: process.env.RECIPIENT_WALLET,
      secretKey: process.env.MPP_SECRET_KEY,
      testnet: true,
    },
    x402: {
      payTo: process.env.RECIPIENT_WALLET,
      network: process.env.X402_NETWORK,
      facilitatorUrl: process.env.X402_FACILITATOR_URL,
    },
  });
  assert.equal(typeof dual.charge, "function");
});

test("server boots and unpaid find-cheapest returns both payment challenges", async () => {
  applyMockEnv();
  const { startServer } = await import(`../server.js?smoke=${Date.now()}`);
  const server = startServer(0);

  try {
    await waitForListening(server);

    const address = server.address();
    assert.equal(typeof address, "object");
    const baseUrl = `http://127.0.0.1:${address.port}`;

    const response = await fetch(`${baseUrl}/v1/find-cheapest?product=sony`);
    assert.equal(response.status, 402);
    assert.ok(response.headers.get("payment-required"));
    assert.ok(response.headers.get("www-authenticate"));
    assert.match(
      response.headers.get("access-control-expose-headers") ?? "",
      /PAYMENT-REQUIRED/,
    );

    const openapi = await fetch(`${baseUrl}/openapi.json`);
    assert.equal(openapi.status, 200);
    const spec = await openapi.json();
    assert.equal(
      spec.paths["/v1/find-cheapest"].post.operationId,
      "postFindCheapest",
    );
    assert.equal(
      spec.paths["/v1/find-cheapest"].get.operationId,
      "getFindCheapest",
    );

    const verify = await fetch(`${baseUrl}/verify`);
    assert.equal(verify.status, 200);
    const proof = await verify.json();
    assert.equal(proof.payment.x402.network, "eip155:84532");
    assert.equal(proof.payment.x402.payee, process.env.RECIPIENT_WALLET);
    assert.equal(proof.upstreams.nimble.configured, false);
  } finally {
    await new Promise((resolve, reject) => {
      server.close((error) => (error ? reject(error) : resolve()));
    });
  }
});
