// netlify/functions/claude.js
// Proxy sécurisé vers l'API Anthropic

export default async (req) => {
    if (req.method !== "POST") {
      return new Response("Method not allowed", { status: 405 });
    }
  
    try {
      const body = await req.json();
  
      const response = await fetch("https://api.anthropic.com/v1/messages", {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          "x-api-key": process.env.ANTHROPIC_API_KEY,
          "anthropic-version": "2023-06-01",
        },
        body: JSON.stringify(body),
      });
  
      const data = await response.json();
      return new Response(JSON.stringify(data), {
        status: response.status,
        headers: { "Content-Type": "application/json" },
      });
    } catch (err) {
      return new Response(JSON.stringify({ error: err.message }), {
        status: 500,
        headers: { "Content-Type": "application/json" },
      });
    }
  };
  
  export const config = { path: "/api/claude" };