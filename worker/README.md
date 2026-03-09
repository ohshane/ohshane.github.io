# chat-proxy

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

# 2. Register OpenRouter API key (Saved as a secret, not exposed in code/dashboard)
npx wrangler secret put OPENROUTER_API_KEY
# Paste the key when prompted

# 3. Build + Deploy (chat.html is copied to public/index.html before deployment)
npm run deploy
```

Accessible at `https://chat-proxy.ohshane.workers.dev` after deployment.

## Local Development

```bash
# Set key in .dev.vars file OPENROUTER_API_KEY=sk-or-v1-xxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxx
# .dev.vars is the standard for local development secrets in Wrangler.
vi .dev.vars

# Copy chat.html + run wrangler dev
npm run dev

# Both chat.html + API run at http://localhost:8787
```

`chat.html` automatically detects the environment:

- localhost / workers.dev → Uses `/api/chat` from the same origin
- GitHub Pages → Uses `https://chat-proxy.ohshane71.workers.dev/api/chat`

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
Workers & Pages → chat-proxy → Settings → Delete

## Structure

```
worker/
├── package.json    # build/dev/deploy scripts
├── wrangler.toml   # Worker configuration, ALLOWED_ORIGINS
├── .gitignore      # Excludes public/, .dev.vars
├── .dev.vars       # API key for local dev (excluded from git)
├── public/         # Where chat.html is copied during build
│   └── index.html
└── src/
    └── index.js    # POST /api/chat → OpenRouter proxy
```
