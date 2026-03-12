export default {
  async fetch(request, env) {
    const url = new URL(request.url);
    const origin = request.headers.get("Origin");
    const allowedOriginsStr = env.ALLOWED_ORIGINS;
    const allowedOrigins = allowedOriginsStr.split(",").map(o => o.trim());

    // Check if the current origin is allowed
    const isAllowed = origin && (
      allowedOrigins.includes(origin) ||
      origin.startsWith("http://localhost") ||
      origin.startsWith("http://127.0.0.1")
    );

    const corsHeaders = {
      "Access-Control-Allow-Origin": isAllowed ? origin : allowedOrigins[0],
      "Access-Control-Allow-Methods": "POST, OPTIONS",
      "Access-Control-Allow-Headers": "Content-Type",
      "Access-Control-Max-Age": "86400",
    };

    // Handle preflight requests
    if (request.method === "OPTIONS") {
      return new Response(null, { status: 204, headers: corsHeaders });
    }

    // Only handle /api/chat
    if (url.pathname !== "/api/v1/chat/completions") {
      try {
        // 1. Try serving from local assets (the public/ folder)
        const assetResponse = await env.ASSETS.fetch(request);
        if (assetResponse.status !== 404) {
          return assetResponse;
        }

        // 2. If not found and on local dev, proxy to Quarto (8888)
        const isLocalHost = url.hostname === "localhost" || url.hostname === "127.0.0.1";
        if (isLocalHost) {
          try {
            const proxyUrl = new URL(url.pathname, "http://localhost:8888");
            const proxyRes = await fetch(proxyUrl, {
              method: request.method,
              headers: request.headers,
            });
            
            // Forward the response with same-origin friendly headers
            const headers = new Headers(proxyRes.headers);
            headers.set("Access-Control-Allow-Origin", "*"); 
            return new Response(proxyRes.body, { ...proxyRes, headers });
          } catch (e) {
            return assetResponse; // fallback to 404 if 8888 is down
          }
        }
        return assetResponse;
      } catch (e) {
        return new Response("Not Found", { status: 404 });
      }
    }

    if (request.method !== "POST") {
      return new Response("Method not allowed", { status: 405, headers: corsHeaders });
    }

    try {
      const { messages, model, stream } = await request.json();
      const shouldStream = stream !== false; // Default to true unless explicitly false

      if (!messages || !Array.isArray(messages)) {
        return new Response(JSON.stringify({ error: "messages array required" }), {
          status: 400,
          headers: { ...corsHeaders, "Content-Type": "application/json" },
        });
      }

      const response = await fetch("https://openrouter.ai/api/v1/chat/completions", {
        method: "POST",
        headers: {
          Authorization: `Bearer ${env.OPENROUTER_API_KEY}`,
          "Content-Type": "application/json",
          "HTTP-Referer": allowedOrigins[0],
          "X-Title": "Shane Chat",
        },
        body: JSON.stringify({
          model: model || "google/gemini-2.0-flash-exp",
          messages,
          stream: shouldStream,
        }),
      });

      if (!response.ok) {
        const err = await response.text();
        return new Response(JSON.stringify({ error: err }), {
          status: response.status,
          headers: { ...corsHeaders, "Content-Type": "application/json" },
        });
      }

      const responseHeaders = {
        ...corsHeaders,
        "Content-Type": shouldStream ? "text/event-stream" : "application/json",
        "Cache-Control": "no-cache",
      };

      return new Response(response.body, { headers: responseHeaders });
    } catch (e) {
      return new Response(JSON.stringify({ error: e.message }), {
        status: 500,
        headers: { ...corsHeaders, "Content-Type": "application/json" },
      });
    }
  },
};
