import { serve } from "https://deno.land/std@0.224.0/http/server.ts";
import { createClient } from "https://esm.sh/@supabase/supabase-js@2.49.1";

const corsHeaders = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers": "authorization, x-client-info, apikey, content-type",
  "Access-Control-Allow-Methods": "POST, OPTIONS",
};

serve(async (req) => {
  if (req.method === "OPTIONS") {
    return new Response("ok", { headers: corsHeaders });
  }

  try {
    if (req.method !== "POST") {
      return jsonResponse({ error: "Method not allowed" }, 405);
    }

    const supabaseUrl = Deno.env.get("SUPABASE_URL")!;
    const anonKey = Deno.env.get("SUPABASE_ANON_KEY")!;
    const serviceRoleKey = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!;

    const authHeader = req.headers.get("Authorization");

    const userClient = createClient(supabaseUrl, anonKey, {
      global: { headers: { Authorization: authHeader! } },
    });

    const adminClient = createClient(supabaseUrl, serviceRoleKey);

    const {
      data: { user },
    } = await userClient.auth.getUser();

    if (!user) return jsonResponse({ error: "Unauthorized" }, 401);

    const { messageId } = await req.json();
    if (!messageId) return jsonResponse({ error: "messageId required" }, 400);

    const { data: message } = await adminClient
      .from("messages")
      .select("*")
      .eq("id", messageId)
      .single();

    const now = new Date().toISOString();

    const { data: rejected } = await adminClient
      .from("messages")
      .update({
        delivery_status: "blocked",
        visible_to_recipient: false,
        review_status: "Manual Review Rejected",
        reviewed_at: now,
        reviewed_by: user.id,
      })
      .eq("id", messageId)
      .select("*")
      .single();

    await adminClient
      .from("admin_review_queue")
      .update({
        status: "resolved",
        resolved_at: now,
        resolution: "rejected",
      })
      .eq("related_id", messageId);

    await adminClient
      .from("fraud_signals")
      .update({
        status: "confirmed",
        reviewed_at: now,
        reviewed_by: user.id,
      })
      .eq("related_id", messageId);

    const { count } = await adminClient
      .from("messages")
      .select("id", { count: "exact", head: true })
      .eq("sender_user_id", message.sender_user_id)
      .eq("content_status", "flagged");

    await adminClient
      .from("user_risk_profiles")
      .update({
        account_status: count && count > 0 ? "queued" : "normal",
        updated_at: now,
      })
      .eq("user_id", message.sender_user_id);

    return jsonResponse({ success: true, message: rejected });
  } catch (e) {
    return jsonResponse({ error: (e as Error).message }, 500);
  }
});

function jsonResponse(payload: unknown, status = 200) {
  return new Response(JSON.stringify(payload), {
    status,
    headers: {
      ...corsHeaders,
      "Content-Type": "application/json",
    },
  });
}
