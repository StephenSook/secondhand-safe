#!/usr/bin/env bash
# Push this Mac's keys into the Vercel project's production environment. RUN IT YOURSELF:
#   bash scripts/push-env.sh
# Reads each value from .env.local first, then macOS Keychain. Never prints a value; prints only names and
# whether each was pushed. Re-running replaces existing values. Then redeploy: vercel deploy --prod --yes
set -euo pipefail
cd "$(dirname "$0")/.."

project=$(python3 -c "import json;print(json.load(open('.vercel/project.json'))['projectName'])")
if [ "$project" != "secondhand-safe-web" ]; then
  echo "Refusing: .vercel/project.json is linked to '$project', not secondhand-safe-web." >&2
  exit 1
fi

# NAME=keychain-service (empty service = .env.local only)
pairs=(
  # GEMINI_API_KEY is not pushed from here: production uses keyless Workload Identity Federation (a "wif:..."
  # config string set once by hand); the keychain key bills a depleted prepay account.
  "ELEVENLABS_API_KEY=elevenlabs-api-key"
  "MONGODB_URI="
  "VISA_MERCHANT_ID="
  "VISA_KEY_ID="
  "VISA_SECRET_KEY="
  "TAP_AGENT_PRIVATE_KEY_HEX="
  "TAP_AGENT_KEY_ID="
  "SOLANA_SECRET_KEY_B58="
)

from_env_file() {
  [ -f .env.local ] || return 0
  # a name missing from .env.local is normal: never let grep's exit 1 end the script under pipefail
  { grep -E "^$1=" .env.local || true; } | head -1 | cut -d= -f2- | sed -e 's/^"//' -e 's/"$//'
}

for pair in "${pairs[@]}"; do
  name=${pair%%=*}
  service=${pair#*=}
  value=$(from_env_file "$name")
  if [ -z "$value" ] && [ -n "$service" ]; then
    value=$(security find-generic-password -s "$service" -w 2>/dev/null || true)
  fi
  if [ -z "$value" ]; then
    echo "skip   $name (not found)"
    continue
  fi
  vercel env rm "$name" production --yes >/dev/null 2>&1 || true
  printf '%s' "$value" | vercel env add "$name" production >/dev/null
  echo "pushed $name (${#value} chars)"
done
vercel env add PUBLIC_BASE_URL production >/dev/null 2>&1 <<< "https://secondhand-safe-web.vercel.app" || true
echo "Done. Now run: vercel deploy --prod --yes"
