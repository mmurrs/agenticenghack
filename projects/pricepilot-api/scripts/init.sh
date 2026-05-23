#!/usr/bin/env bash
# dual402-starter — first-time setup.
# Generates a fresh merchant wallet + MPP secret, writes .env.mainnet.
set -euo pipefail

cd "$(dirname "$0")/.."

ENV_FILE=".env.mainnet"

if [[ -f "$ENV_FILE" ]]; then
  echo "FATAL: $ENV_FILE already exists. Edit it directly or delete first." >&2
  exit 1
fi

command -v cast >/dev/null 2>&1 || {
  echo "FATAL: 'cast' not found. Install foundry:"
  echo "  curl -L https://foundry.paradigm.xyz | bash && foundryup"
  exit 1
}
command -v node >/dev/null 2>&1 || {
  echo "FATAL: node not found."
  exit 1
}

echo "==> Generating a fresh merchant wallet..."
WALLET_OUTPUT="$(cast wallet new)"
ADDRESS="$(echo "$WALLET_OUTPUT" | awk '/Address:/ {print $2}')"
PRIVKEY="$(echo "$WALLET_OUTPUT" | awk '/Private key:/ {print $3}')"

if [[ -z "$ADDRESS" || -z "$PRIVKEY" ]]; then
  echo "FATAL: couldn't parse wallet from cast output:" >&2
  echo "$WALLET_OUTPUT" >&2
  exit 1
fi

echo "==> Generating MPP secret..."
MPP_SECRET="$(node -e "console.log(require('crypto').randomBytes(32).toString('hex'))")"

cp .env.example "$ENV_FILE"

# In-place substitutions (portable macOS + linux)
python3 - "$ENV_FILE" "$ADDRESS" "$MPP_SECRET" <<'PY'
import sys, re
path, address, secret = sys.argv[1], sys.argv[2], sys.argv[3]
with open(path) as f:
    s = f.read()
s = re.sub(r"^RECIPIENT_WALLET=.*$", f"RECIPIENT_WALLET={address}", s, flags=re.M)
s = re.sub(r"^MPP_SECRET_KEY=.*$", f"MPP_SECRET_KEY={secret}", s, flags=re.M)
with open(path, "w") as f:
    f.write(s)
PY

mkdir -p scripts
PRIVKEY_FILE="scripts/.merchant-privkey"
umask 077
printf "%s\n" "$PRIVKEY" > "$PRIVKEY_FILE"

cat <<EOF

==================================================================
Wallet generated.
==================================================================

  Merchant address: $ADDRESS
  Private key:      saved to $PRIVKEY_FILE — mode 600, gitignored

  SAVE THE PRIVATE KEY SECURELY. Put it in 1Password right now.
  If you lose it, funds paid to this address are unrecoverable.

Next steps:
  1. Edit $ENV_FILE and fill in:
       - SERVICE_NAME / BASE_URL               (your product name + URL)
       - NIMBLE_API_KEY                        (Nimble dashboard)
       - CDP_API_KEY_ID / CDP_API_KEY_SECRET   (only for Base-mainnet x402)
  2. Run: ./scripts/deploy.sh --fresh
==================================================================
EOF
