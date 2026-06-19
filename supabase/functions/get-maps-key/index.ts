import "jsr:@supabase/functions-js/edge-runtime.d.ts";

const corsHeaders = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Methods": "GET, POST, OPTIONS",
  "Access-Control-Allow-Headers": "Content-Type, Authorization, X-Client-Info, Apikey",
};

Deno.serve(async (req: Request) => {
  if (req.method === "OPTIONS") {
    return new Response(null, { status: 200, headers: corsHeaders });
  }

  const key = Deno.env.get("GOOGLE_MAPS_API_KEY") ?? "";

  return new Response(JSON.stringify({ key }), {
    headers: { "Content-Type": "application/json", ...corsHeaders },
  });
});
