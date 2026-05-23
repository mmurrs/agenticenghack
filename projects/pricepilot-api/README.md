# PricePilot API

Self-contained paid microservice for PricePilot price lookup.

## Endpoint

```http
POST /v1/find-cheapest
```

```json
{
  "product": "Sony WH-1000XM5",
  "zip_code": "10001"
}
```

The service calls Nimble's Amazon and Walmart agents, normalizes priced offers,
and returns the cheapest result plus the ranked offers.

## Local

```bash
npm install
npm test
npm run dev
```

## Deploy

```bash
cp .env.example .env.mainnet
# Fill NIMBLE_API_KEY and payment fields.
npm run deploy -- --fresh
```

`scripts/init.sh` can generate a fresh merchant wallet and MPP secret. The
deploy script uses a local Dockerfile build on EigenCompute and does not require
verifiable builds or a clean pushed commit.
