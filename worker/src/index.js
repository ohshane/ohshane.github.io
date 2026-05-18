const EMBED_MODEL_DEFAULT = "@cf/baai/bge-m3";
const TOP_K = 5;
const HREF_NEIGHBORS_PER_HIT = 2;
const FINAL_CONTEXT_SIZE = 4;

export default {
  async fetch(request, env) {
    const url = new URL(request.url);
    const origin = request.headers.get("Origin");
    const allowedOrigins = (env.ALLOWED_ORIGINS || "").split(",").map((o) => o.trim()).filter(Boolean);

    const isAllowed =
      origin &&
      (allowedOrigins.includes(origin) ||
        origin.startsWith("http://localhost") ||
        origin.startsWith("http://127.0.0.1"));

    const corsHeaders = {
      "Access-Control-Allow-Origin": isAllowed ? origin : allowedOrigins[0] || "*",
      "Access-Control-Allow-Methods": "POST, OPTIONS",
      "Access-Control-Allow-Headers": "Content-Type",
      "Access-Control-Max-Age": "86400",
    };

    if (request.method === "OPTIONS") {
      return new Response(null, { status: 204, headers: corsHeaders });
    }

    if (url.pathname === "/api/v1/graph") {
      if (request.method !== "GET") {
        return json({ error: "Method not allowed" }, 405, corsHeaders);
      }
      try {
        if (env.GRAPH) {
          const snap = await env.GRAPH.get("graph:snapshot");
          if (snap) {
            return new Response(snap, {
              headers: {
                ...corsHeaders,
                "Content-Type": "application/json",
                "Cache-Control": "public, max-age=300",
              },
            });
          }
        }
        const assetUrl = new URL("/graph.json", url.origin);
        const assetRes = await env.ASSETS.fetch(new Request(assetUrl));
        if (assetRes.ok) {
          const headers = new Headers(assetRes.headers);
          for (const [k, v] of Object.entries(corsHeaders)) headers.set(k, v);
          headers.set("Cache-Control", "public, max-age=60");
          return new Response(assetRes.body, { status: 200, headers });
        }
        return json({ error: "graph snapshot missing" }, 404, corsHeaders);
      } catch (e) {
        return json({ error: e.message || String(e) }, 500, corsHeaders);
      }
    }

    if (url.pathname !== "/api/v1/chat/completions") {
      return await serveAssets(request, env, url);
    }

    if (request.method !== "POST") {
      return json({ error: "Method not allowed" }, 405, corsHeaders);
    }

    try {
      const { messages, model, stream } = await request.json();
      const shouldStream = stream !== false;

      if (!messages || !Array.isArray(messages) || messages.length === 0) {
        return json({ error: "messages array required" }, 400, corsHeaders);
      }

      const query = lastUserContent(messages);
      const { contextBlocks, sources } = await retrieveContext(env, query);

      const apiMessages = messages.slice();
      if (contextBlocks.length) {
        apiMessages.unshift({
          role: "system",
          content:
            "You are a helpful assistant. Use the following blog post excerpts to answer when relevant. If they do not help, answer normally.\n\n" +
            contextBlocks.join("\n\n---\n\n"),
        });
      }

      const upstream = await fetch("https://openrouter.ai/api/v1/chat/completions", {
        method: "POST",
        headers: {
          Authorization: `Bearer ${env.OPENROUTER_API_KEY}`,
          "Content-Type": "application/json",
          "HTTP-Referer": allowedOrigins[0] || "https://blog.shaneoh.org",
          "X-Title": "Shane Chat",
        },
        body: JSON.stringify({
          model: model || env.CHAT_MODEL_DEFAULT || "google/gemini-2.0-flash-exp",
          messages: apiMessages,
          stream: shouldStream,
        }),
      });

      if (!upstream.ok) {
        const err = await upstream.text();
        return json({ error: err }, upstream.status, corsHeaders);
      }

      if (!shouldStream) {
        const body = await upstream.json();
        return json({ ...body, sources }, 200, corsHeaders);
      }

      const responseStream = prefixSourcesStream(upstream.body, sources);
      return new Response(responseStream, {
        headers: {
          ...corsHeaders,
          "Content-Type": "text/event-stream",
          "Cache-Control": "no-cache",
        },
      });
    } catch (e) {
      return json({ error: e.message || String(e) }, 500, corsHeaders);
    }
  },
};

function json(obj, status, headers) {
  return new Response(JSON.stringify(obj), {
    status,
    headers: { ...headers, "Content-Type": "application/json" },
  });
}

function lastUserContent(messages) {
  for (let i = messages.length - 1; i >= 0; i--) {
    if (messages[i].role === "user") return String(messages[i].content || "");
  }
  return "";
}

async function serveAssets(request, env, url) {
  try {
    const assetResponse = await env.ASSETS.fetch(request);
    if (assetResponse.status !== 404) return assetResponse;
    const isLocalHost = url.hostname === "localhost" || url.hostname === "127.0.0.1";
    if (isLocalHost) {
      try {
        const proxyUrl = new URL(url.pathname, "http://localhost:8888");
        const proxyRes = await fetch(proxyUrl, { method: request.method, headers: request.headers });
        const headers = new Headers(proxyRes.headers);
        headers.set("Access-Control-Allow-Origin", "*");
        return new Response(proxyRes.body, { status: proxyRes.status, headers });
      } catch {
        return assetResponse;
      }
    }
    return assetResponse;
  } catch {
    return new Response("Not Found", { status: 404 });
  }
}

async function retrieveContext(env, query) {
  if (!query || !env.VEC || !env.AI || !env.GRAPH) {
    return { contextBlocks: [], sources: [] };
  }

  const embedRes = await env.AI.run(env.EMBED_MODEL || EMBED_MODEL_DEFAULT, { text: [query] });
  const queryVec = embedRes?.data?.[0];
  if (!queryVec) return { contextBlocks: [], sources: [] };

  const result = await env.VEC.query(queryVec, { topK: TOP_K, returnMetadata: "all" });
  const matches = result?.matches || [];
  if (!matches.length) return { contextBlocks: [], sources: [] };

  const scoreById = new Map();
  for (const m of matches) {
    scoreById.set(m.id, { score: m.score, metadata: m.metadata });
  }

  const parentIds = [];
  for (const m of matches) {
    const depth = Number(m.metadata?.depth || 1);
    const parent = m.metadata?.parentChunkId;
    if (depth >= 3 && parent && !scoreById.has(parent)) {
      parentIds.push(parent);
    }
  }

  const hrefExpansionIds = [];
  const seenHref = new Set();
  for (const m of matches) {
    const postId = m.metadata?.postId;
    if (!postId) continue;
    const raw = await env.GRAPH.get(`edges:href:${postId}`);
    if (!raw) continue;
    let neighbors;
    try {
      neighbors = JSON.parse(raw);
    } catch {
      continue;
    }
    for (const dst of neighbors.slice(0, HREF_NEIGHBORS_PER_HIT)) {
      if (seenHref.has(dst)) continue;
      seenHref.add(dst);
      hrefExpansionIds.push({ postId: dst, parentScore: m.score });
    }
  }

  if (parentIds.length) {
    const fetched = await env.VEC.getByIds(parentIds);
    for (const v of fetched) {
      const parentOfHit = matches.find((m) => m.metadata?.parentChunkId === v.id);
      const score = parentOfHit ? parentOfHit.score * 0.7 : 0;
      if (!scoreById.has(v.id)) {
        scoreById.set(v.id, { score, metadata: v.metadata });
      }
    }
  }

  if (hrefExpansionIds.length) {
    for (const { postId, parentScore } of hrefExpansionIds) {
      const probe = await env.VEC.query(queryVec, {
        topK: 1,
        returnMetadata: "all",
        filter: { postId: { $eq: postId } },
      });
      const m = probe?.matches?.[0];
      if (m && !scoreById.has(m.id)) {
        scoreById.set(m.id, { score: m.score * 0.5 + parentScore * 0.1, metadata: m.metadata });
      }
    }
  }

  const ranked = [...scoreById.entries()]
    .map(([id, v]) => ({ id, ...v }))
    .sort((a, b) => b.score - a.score)
    .slice(0, FINAL_CONTEXT_SIZE);

  const contextBlocks = ranked.map((r) => {
    const head = r.metadata?.section
      ? `[${r.metadata.title} > ${r.metadata.section}]`
      : `[${r.metadata?.title || r.id}]`;
    return `${head}\n${r.metadata?.text || ""}`;
  });

  const sources = ranked.map((r) => ({
    title: r.metadata?.title || "",
    section: r.metadata?.section || "",
    href: r.metadata?.href || r.id,
    score: r.score,
  }));

  return { contextBlocks, sources };
}

function prefixSourcesStream(upstreamBody, sources) {
  const encoder = new TextEncoder();
  return new ReadableStream({
    async start(controller) {
      const meta = `event: sources\ndata: ${JSON.stringify({ sources })}\n\n`;
      controller.enqueue(encoder.encode(meta));
      const reader = upstreamBody.getReader();
      try {
        while (true) {
          const { done, value } = await reader.read();
          if (done) break;
          controller.enqueue(value);
        }
      } finally {
        controller.close();
      }
    },
  });
}
