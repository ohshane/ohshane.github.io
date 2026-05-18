#!/bin/sh
# Create Cloudflare resources (Vectorize + KV) and wire them into wrangler.toml.
# Idempotent — safe to re-run. Uses wrangler OAuth session, no API token needed.
#
# Does NOT create the CF_API_TOKEN (manual dashboard step) or run ingest.
# After this completes, follow README Step 4–5 to ingest.
#
# Usage:
#   sh scripts/wrangler-setup.sh

set -eu

cd "$(dirname "$0")/.."
WORKER_DIR="$(pwd)"
WRANGLER_TOML="$WORKER_DIR/wrangler.toml"
INDEX_NAME="chat-index"

# Strip inherited Cloudflare env vars so wrangler uses OAuth, not env token.
unset CF_API_TOKEN CLOUDFLARE_API_TOKEN CF_ACCOUNT_ID CLOUDFLARE_ACCOUNT_ID 2>/dev/null || true
WR='env -u CF_API_TOKEN -u CLOUDFLARE_API_TOKEN -u CF_ACCOUNT_ID -u CLOUDFLARE_ACCOUNT_ID npx wrangler'

echo "==> Worker dir: $WORKER_DIR"

# 1. Login check
if ! $WR whoami >/dev/null 2>&1; then
  echo "==> Logging in to Cloudflare..."
  $WR login
fi

# 2. Vectorize index
if $WR vectorize list 2>/dev/null | grep -q "$INDEX_NAME"; then
  echo "==> Vectorize index '$INDEX_NAME' exists."
else
  echo "==> Creating Vectorize index..."
  $WR vectorize create "$INDEX_NAME" --dimensions=1024 --metric=cosine
fi

# 3. Metadata index (idempotent — ignore errors on rerun)
echo "==> Ensuring metadata index on postId..."
$WR vectorize create-metadata-index "$INDEX_NAME" \
  --property-name=postId --type=string >/dev/null 2>&1 || \
  echo "    (already exists — continuing)"

# 4. KV namespace
KV_ID=""
KV_LIST="$($WR kv namespace list 2>/dev/null || true)"
KV_ID="$(printf '%s' "$KV_LIST" | python3 -c '
import sys, json
try:
  arr = json.loads(sys.stdin.read())
except Exception:
  sys.exit(0)
for n in arr:
  if n.get("title") == "GRAPH":
    print(n.get("id", ""))
    break
' || true)"

if [ -n "$KV_ID" ]; then
  echo "==> KV namespace 'GRAPH' exists: $KV_ID"
else
  echo "==> Creating KV namespace GRAPH..."
  KV_OUT="$($WR kv namespace create GRAPH 2>&1)"
  echo "$KV_OUT"
  KV_ID="$(printf '%s' "$KV_OUT" | grep -oE 'id\s*=\s*"[a-f0-9]+"' | head -n1 | grep -oE '[a-f0-9]{16,}' | head -n1)"
  if [ -z "$KV_ID" ]; then
    echo "==> ERROR: could not parse KV id from output."
    exit 1
  fi
fi
echo "==> KV id: $KV_ID"

# 5. Patch wrangler.toml — uncomment AI/Vectorize/KV blocks, inject KV id
echo "==> Patching wrangler.toml..."
python3 - "$WRANGLER_TOML" "$KV_ID" "$INDEX_NAME" <<'PY'
import sys, re, pathlib
path = pathlib.Path(sys.argv[1])
kv_id = sys.argv[2]
index_name = sys.argv[3]
text = path.read_text()

# Uncomment [ai]
text = re.sub(r'#\s*\[ai\]\n#\s*binding\s*=\s*"AI"',
              '[ai]\nbinding = "AI"', text)

# Uncomment [[vectorize]]
text = re.sub(
    r'#\s*\[\[vectorize\]\]\n#\s*binding\s*=\s*"VEC"\n#\s*index_name\s*=\s*"[^"]*"\n#\s*remote\s*=\s*true',
    f'[[vectorize]]\nbinding = "VEC"\nindex_name = "{index_name}"\nremote = true',
    text)

# Uncomment [[kv_namespaces]] + inject id
text = re.sub(
    r'#\s*\[\[kv_namespaces\]\]\n#\s*binding\s*=\s*"GRAPH"\n#\s*id\s*=\s*"[^"]*"\n#\s*remote\s*=\s*true',
    f'[[kv_namespaces]]\nbinding = "GRAPH"\nid = "{kv_id}"\nremote = true',
    text)

# If already uncommented, refresh KV id
text = re.sub(
    r'(\[\[kv_namespaces\]\]\nbinding\s*=\s*"GRAPH"\nid\s*=\s*)"[^"]*"',
    rf'\1"{kv_id}"', text)

path.write_text(text)
print("    wrangler.toml patched")
PY

# 6. .dev.vars stub for OPENROUTER_API_KEY
if [ ! -f "$WORKER_DIR/.dev.vars" ]; then
  echo "==> Creating .dev.vars stub — edit with real OPENROUTER_API_KEY..."
  cp "$WORKER_DIR/.dev.vars.example" "$WORKER_DIR/.dev.vars"
fi

# 7. .rag-env stub (CF token still needs manual paste — perms must be granted via dashboard)
ENV_FILE="$WORKER_DIR/.rag-env"
ACCOUNT_ID="$($WR whoami 2>&1 | grep -oE '[a-f0-9]{32}' | head -n1 || true)"
if [ ! -f "$ENV_FILE" ]; then
  cat > "$ENV_FILE" <<EOF
CF_ACCOUNT_ID=$ACCOUNT_ID
CF_API_TOKEN=PASTE_TOKEN_WITH_WORKERS_AI_READ_VECTORIZE_EDIT_KV_EDIT
KV_NAMESPACE_ID=$KV_ID
VECTORIZE_INDEX=$INDEX_NAME
EOF
  echo "==> Created $ENV_FILE — edit CF_API_TOKEN before running ingest."
else
  echo "==> $ENV_FILE already exists — leaving untouched."
fi

echo ""
echo "==> Setup done. Next:"
echo "    1. Create API token at https://dash.cloudflare.com/profile/api-tokens"
echo "       Perms: Workers AI:Read, Vectorize:Edit, Workers KV Storage:Edit"
echo "    2. Paste token into worker/.rag-env (CF_API_TOKEN=...)"
echo "    3. Render blog:  cd .. && quarto render && cd worker"
echo "    4. Ingest:       . ./.rag-env && CF_ACCOUNT_ID=\$CF_ACCOUNT_ID CF_API_TOKEN=\$CF_API_TOKEN KV_NAMESPACE_ID=\$KV_NAMESPACE_ID npm run ingest"
echo "    5. Dev:          npm run dev"
