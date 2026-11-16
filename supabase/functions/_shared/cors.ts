// Shared CORS headers for browser/mobile callers.
// Edge Functions expect explicit CORS handling; the React Native client
// preflights with OPTIONS before POSTing.

export const corsHeaders = {
    "Access-Control-Allow-Origin": "*",
    "Access-Control-Allow-Headers":
        "authorization, x-client-info, apikey, content-type, x-revenuecat-signature",
    "Access-Control-Allow-Methods": "POST, OPTIONS",
};

export function preflight(req: Request): Response | null {
    if (req.method === "OPTIONS") {
        return new Response("ok", { headers: corsHeaders });
    }
    return null;
}
