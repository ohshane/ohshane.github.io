// src/index.js
var index_default = {
  async fetch(request, env) {
    const url = new URL(request.url);
    const origin = request.headers.get("Origin");
    const allowedOriginsStr = env.ALLOWED_ORIGINS;
    const allowedOrigins = allowedOriginsStr.split(",").map((o) => o.trim());
    const isAllowed = origin && (allowedOrigins.includes(origin) || origin.startsWith("http://localhost") || origin.startsWith("http://127.0.0.1"));
    const corsHeaders = {
      "Access-Control-Allow-Origin": isAllowed ? origin : allowedOrigins[0],
      "Access-Control-Allow-Methods": "POST, OPTIONS",
      "Access-Control-Allow-Headers": "Content-Type",
      "Access-Control-Max-Age": "86400"
    };
    if (request.method === "OPTIONS") {
      return new Response(null, { status: 204, headers: corsHeaders });
    }
    if (url.pathname !== "/api/chat") {
      return new Response("Not found", { status: 404, headers: corsHeaders });
    }
    if (request.method !== "POST") {
      return new Response("Method not allowed", { status: 405, headers: corsHeaders });
    }
    try {
      const { messages, model } = await request.json();
      if (!messages || !Array.isArray(messages)) {
        return new Response(JSON.stringify({ error: "messages array required" }), {
          status: 400,
          headers: { ...corsHeaders, "Content-Type": "application/json" }
        });
      }
      const response = await fetch("https://openrouter.ai/api/v1/chat/completions", {
        method: "POST",
        headers: {
          Authorization: `Bearer ${env.OPENROUTER_API_KEY}`,
          "Content-Type": "application/json",
          "HTTP-Referer": allowedOrigins[0],
          "X-Title": "Shane Chat"
        },
        body: JSON.stringify({
          model: model || "google/gemini-2.5-flash-preview",
          messages,
          stream: true
        })
      });
      if (!response.ok) {
        const err = await response.text();
        return new Response(JSON.stringify({ error: err }), {
          status: response.status,
          headers: { ...corsHeaders, "Content-Type": "application/json" }
        });
      }
      return new Response(response.body, {
        headers: {
          ...corsHeaders,
          "Content-Type": "text/event-stream",
          "Cache-Control": "no-cache"
        }
      });
    } catch (e) {
      return new Response(JSON.stringify({ error: e.message }), {
        status: 500,
        headers: { ...corsHeaders, "Content-Type": "application/json" }
      });
    }
  }
};
export {
  index_default as default
};
//# sourceMappingURL=index.js.map
