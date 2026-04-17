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

    const { versionId } = await req.json();
    if (!versionId) return jsonResponse({ error: "versionId required" }, 400);

    const { data: version } = await adminClient
      .from("family_profile_versions")
      .select("*")
      .eq("id", versionId)
      .single();

    const familyId = version.family_profile_id;

    const now = new Date().toISOString();

    await adminClient
      .from("family_profile_versions")
      .update({
        content_status: "superseded",
        is_live: false,
      })
      .eq("family_profile_id", familyId)
      .eq("content_status", "published");

    const { data: approved } = await adminClient
      .from("family_profile_versions")
      .update({
        content_status: "published",
        review_status: "Manual Review Approved",
        is_live: true,
        reviewed_at: now,
        reviewed_by: user.id,
      })
      .eq("id", versionId)
      .select("*")
      .single();

    await adminClient
      .from("family_profiles")
      .update({
        current_visible_version_id: versionId,
        current_pending_version_id: null,
        is_active: true,
        updated_at: now,
      })
      .eq("id", familyId);

    await adminClient
      .from("admin_review_queue")
      .update({
        status: "resolved",
        resolved_at: now,
        resolution: "approved",
      })
      .eq("related_id", versionId);

    const { data: remainingFlags } = await adminClient
      .from("family_profile_versions")
      .select("id")
      .eq("family_profile_id", familyId)
      .eq("content_status", "flagged");

    if (!remainingFlags?.length) {
      await adminClient
        .from("user_risk_profiles")
        .update({ account_status: "normal" })
        .eq("user_id", version.user_id);
    }

    return jsonResponse({ success: true, version: approved });
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
