# quarto-chat

`ohshane.github.io/chat.html` → OpenRouter API Proxy (Cloudflare Worker)

A serverless proxy to use OpenRouter without exposing the API key to the client.

## Prerequisites

- [Cloudflare Account](https://dash.cloudflare.com)
- [OpenRouter API Key](https://openrouter.ai/keys)
- Node.js 18+

## Deployment

```bash
cd worker

# 1. Login to Cloudflare
npx wrangler login

# 2. Register OpenRouter API key
npx wrangler secret put OPENROUTER_API_KEY

# 3. Create Vectorize index (BGE-M3 = 1024 dims, cosine)
npx wrangler vectorize create chat-index --dimensions=1024 --metric=cosine
npx wrangler vectorize create-metadata-index chat-index --property-name=postId --type=string

# 4. Create KV namespace, copy the id into wrangler.toml under [[kv_namespaces]]
npx wrangler kv namespace create GRAPH

# 5. Build + Deploy
npm run deploy

# 6. Ingest blog content (renders Quarto first if _site is stale: `cd .. && quarto render`)
#    Token needs: Workers AI Read, Vectorize Edit, Workers KV Storage Edit.
#    See "Enable RAG locally" → "Gotchas" below for token pitfalls.
CF_ACCOUNT_ID=...  CF_API_TOKEN=...  KV_NAMESPACE_ID=...  \
  node scripts/ingest.mjs
```

Accessible at `https://quarto-chat.ohshane.workers.dev` after deployment.

## Re-ingest after publishing new posts

```bash
cd ..
quarto render
cd worker
CF_ACCOUNT_ID=... CF_API_TOKEN=... KV_NAMESPACE_ID=... node scripts/ingest.mjs
```

Hash-based dedup: only changed chunks are re-embedded. Stale ids are purged.

## Local Development

```bash
# 1. Set OpenRouter key in .dev.vars (auto-stubbed by predev hook if missing)
#    OPENROUTER_API_KEY=sk-or-v1-...
vi .dev.vars

# 2. Run dev server (chat-only by default, no RAG bindings)
npm run dev

# Both chat.html + API run at http://localhost:8787
```

### Enable RAG locally

RAG needs Workers AI + Vectorize + KV. All three are remote-only (no local emulator).

**Quick path — automated setup (recommended):**

```bash
cd worker
sh scripts/wrangler-setup.sh
```

Does steps 1–3 below (login, create resources, patch `wrangler.toml`, stub `.rag-env`). Idempotent. After it finishes, do steps 4–5 manually (token + ingest).

To wipe everything (Vectorize index, KV namespace, bindings):

```bash
sh scripts/wrangler-teardown.sh        # interactive — type DELETE to confirm
sh scripts/wrangler-teardown.sh --yes  # non-interactive
```

---

**Manual path (or if you want to understand the steps):**

**Step 1 — Cloudflare login (OAuth, one-time):**

```bash
cd worker
npx wrangler login
```

**Step 2 — Create resources (one-time):**

```bash
npx wrangler vectorize create chat-index --dimensions=1024 --metric=cosine
npx wrangler vectorize create-metadata-index chat-index --property-name=postId --type=string
npx wrangler kv namespace create GRAPH
```

The KV create command prints an `id = "..."`. Copy it.

**Step 3 — Edit `wrangler.toml`:**

Uncomment the `[ai]`, `[[vectorize]]`, and `[[kv_namespaces]]` blocks. Paste the KV id into `[[kv_namespaces]].id`.

**Step 4 — Create API token for ingest:**

The ingest script calls Cloudflare REST API directly (not via wrangler). It needs a token with exactly these permissions:

```
Account · Workers AI · Read
Account · Vectorize · Edit
Account · Workers KV Storage · Edit
```

Create at https://dash.cloudflare.com/profile/api-tokens → **Create Custom Token**. Set Account Resources to **Include · All accounts** (or your specific account). Copy the token.

Verify token (200 = good):

```bash
ACCOUNT_ID=<your-32-hex-account-id>
TOKEN=<your-token>
curl -s -o /dev/null -w '%{http_code}\n' \
  -H "Authorization: Bearer $TOKEN" \
  -X POST "https://api.cloudflare.com/client/v4/accounts/$ACCOUNT_ID/ai/run/@cf/baai/bge-m3" \
  -H 'Content-Type: application/json' \
  -d '{"text":["ping"]}'
```

**Step 5 — Ingest:**

```bash
CF_ACCOUNT_ID=$ACCOUNT_ID \
CF_API_TOKEN=$TOKEN \
KV_NAMESPACE_ID=<paste-kv-id> \
npm run ingest
```

Re-run after every `quarto render`. Hash-based dedup means only changed chunks re-embed.

**Step 6 — Restart dev:**

```bash
npm run dev
```

Graph drawer is reachable from the chat header (network icon). Without ingest data it shows "No graph snapshot found".

### Gotchas

- **Do not put `CF_API_TOKEN` in `.env`** — Wrangler 4 auto-loads `.env` from cwd and overrides OAuth login. Pass env vars inline (`CF_API_TOKEN=... npm run ingest`) or put them in `.rag-env` / direnv.
- **`CLOUDFLARE_API_TOKEN` / `CF_API_TOKEN` exported in shell rc** also breaks `npx wrangler` (forces token auth even when token lacks perms). Either unset in your shell or prefix wrangler calls with `env -u CF_API_TOKEN -u CLOUDFLARE_API_TOKEN ...`.
- **Account id is 32-hex**, not your email. Get it from `npx wrangler whoami`.
- Token permission check: `Workers AI:Read` and `Vectorize:Edit` are separate from `Workers KV Storage:Edit`. Tokens created with only KV will return `401` on AI and `403` on Vectorize.

`chat.html` automatically detects the environment:

- localhost / workers.dev → Uses `/api/v1/chat/completions` from the same origin
- GitHub Pages → Uses `https://quarto-chat.shaneoh.workers.dev/api/v1/chat/completions`

## Configuration (wrangler.toml)

Update the `ALLOWED_ORIGINS` variable in `wrangler.toml` to include your domains (comma-separated):

```toml
[vars]
ALLOWED_ORIGINS = "https://ohshane.github.io, https://blog.shaneoh.org"
```

## Updating API Key

```bash
npx wrangler secret put OPENROUTER_API_KEY
# Paste the new key → Applies immediately (no redeployment needed)
```

## Checking API Key

Secrets cannot be viewed. You can only check the list of currently registered secrets:

```bash
npx wrangler secret list
```

## Changing Models

Models are managed in the `MODELS` array of `chat.html`. No modification to the Worker is needed.

```js
const MODELS = [
  { id: "openai/gpt-4.1-nano", label: "GPT-4.1 Nano" },
  { id: "openai/gpt-4.1-mini", label: "GPT-4.1 Mini" },
  // Add/remove here
];
```

If the client doesn't select a model, the Worker defaults to `openai/gpt-4.1-nano`.

## Deletion

```bash
# Delete Worker (Irreversible)
npx wrangler delete
```

Can also be deleted from the Cloudflare Dashboard:
Workers & Pages → quarto-chat → Settings → Delete

## Structure

```
worker/
├── package.json       # build/dev/deploy scripts
├── wrangler.toml      # Worker config: ALLOWED_ORIGINS, AI/Vectorize/KV bindings
├── .gitignore         # Excludes public/, .dev.vars
├── .dev.vars          # Secrets for local dev (excluded from git)
├── public/            # chat.html copied here during build
│   └── index.html
├── scripts/
│   ├── ingest.mjs              # Build vector index + KV graph from _site/
│   ├── build-graph.mjs         # Generate public/graph.json snapshot
│   ├── wrangler-setup.sh       # Create CF resources + patch wrangler.toml
│   └── wrangler-teardown.sh    # Delete CF resources + recomment bindings
└── src/
    └── index.js       # POST /api/v1/chat/completions: RAG + OpenRouter stream
```

## How RAG works

1. Client posts messages to `/api/v1/chat/completions`.
2. Worker embeds last user message via Workers AI BGE-M3.
3. Vectorize top-5 nearest chunks.
4. Graph expansion:
   - For depth ≥ 3 hits → pull parent (h2) chunk via `parentChunkId` metadata.
   - For each hit's post → pull href neighbors (KV `edges:href:<postId>`), best chunk per neighbor.
5. Merge + rerank, take top 4, inject as system message.
6. Stream OpenRouter response. Sources emitted as first SSE event (`event: sources`).
