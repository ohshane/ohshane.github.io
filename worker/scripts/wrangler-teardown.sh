#!/bin/sh
# Delete Cloudflare resources (Vectorize + KV) and recomment wrangler.toml bindings.
# DESTRUCTIVE — all embedded vectors + graph KV data wiped. Requires confirmation.
#
# Usage:
#   sh scripts/wrangler-teardown.sh        # interactive confirm
#   sh scripts/wrangler-teardown.sh --yes  # skip confirm

set -eu

cd "$(dirname "$0")/.."
WORKER_DIR="$(pwd)"
WRANGLER_TOML="$WORKER_DIR/wrangler.toml"
ENV_FILE="$WORKER_DIR/.rag-env"
INDEX_NAME="chat-index"

unset CF_API_TOKEN CLOUDFLARE_API_TOKEN CF_ACCOUNT_ID CLOUDFLARE_ACCOUNT_ID 2>/dev/null || true
WR='env -u CF_API_TOKEN -u CLOUDFLARE_API_TOKEN -u CF_ACCOUNT_ID -u CLOUDFLARE_ACCOUNT_ID npx wrangler'

CONFIRM_FLAG="${1:-}"

echo "==> This will DELETE:"
echo "    - Vectorize index '$INDEX_NAME' (all embedded vectors)"
echo "    - KV namespace 'GRAPH' (all graph edges/manifest)"
echo "    - Comment out bindings in wrangler.toml"
echo "    - $ENV_FILE (if exists)"
echo ""

if [ "$CONFIRM_FLAG" != "--yes" ]; then
  printf 'Type "DELETE" to confirm: '
  read -r CONFIRM
  if [ "$CONFIRM" != "DELETE" ]; then
    echo "Aborted."
    exit 1
  fi
fi

# 1. Login check
if ! $WR whoami >/dev/null 2>&1; then
  echo "==> Logging in to Cloudflare..."
  $WR login
fi

# 2. Delete Vectorize index
if $WR vectorize list 2>/dev/null | grep -q "$INDEX_NAME"; then
  echo "==> Deleting Vectorize index '$INDEX_NAME'..."
  $WR vectorize delete "$INDEX_NAME" --force 2>&1 | tail -n5 || true
else
  echo "==> Vectorize index '$INDEX_NAME' already absent."
fi

# 3. Delete KV namespace
KV_ID="$($WR kv namespace list 2>/dev/null | python3 -c '
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
  echo "==> Deleting KV namespace GRAPH ($KV_ID)..."
  $WR kv namespace delete --namespace-id="$KV_ID" 2>&1 | tail -n5 || true
else
  echo "==> KV namespace 'GRAPH' already absent."
fi

# 4. Recomment wrangler.toml bindings
echo "==> Recommenting wrangler.toml bindings..."
python3 - "$WRANGLER_TOML" "$INDEX_NAME" <<'PY'
import sys, re, pathlib
path = pathlib.Path(sys.argv[1])
index_name = sys.argv[2]
text = path.read_text()

# Comment [ai]
text = re.sub(
    r'(?<!#)\[ai\]\nbinding\s*=\s*"AI"',
    '# [ai]\n# binding = "AI"', text)

# Comment [[vectorize]]
text = re.sub(
    r'(?<!#)\[\[vectorize\]\]\nbinding\s*=\s*"VEC"\nindex_name\s*=\s*"[^"]*"\nremote\s*=\s*true',
    f'# [[vectorize]]\n# binding = "VEC"\n# index_name = "{index_name}"\n# remote = true',
    text)

# Comment [[kv_namespaces]]
text = re.sub(
    r'(?<!#)\[\[kv_namespaces\]\]\nbinding\s*=\s*"GRAPH"\nid\s*=\s*"[^"]*"\nremote\s*=\s*true',
    '# [[kv_namespaces]]\n# binding = "GRAPH"\n# id = "PASTE_KV_ID_HERE"\n# remote = true',
    text)

path.write_text(text)
print("    wrangler.toml recommented")
PY

# 5. Remove .rag-env
if [ -f "$ENV_FILE" ]; then
  echo "==> Removing $ENV_FILE..."
  rm -f "$ENV_FILE"
fi

echo ""
echo "==> Teardown done. To restore: sh scripts/wrangler-setup.sh"
echo "==> Token at https://dash.cloudflare.com/profile/api-tokens may also be revoked manually."
