import { serve } from "https://deno.land/std@0.224.0/http/server.ts";
import { createClient } from "https://esm.sh/@supabase/supabase-js@2.49.1";

const corsHeaders = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers": "authorization, x-client-info, apikey, content-type",
  "Access-Control-Allow-Methods": "POST, OPTIONS",
};

type RequestBody = {
  job_post_id: string;
  is_active: boolean;
};

serve(async (req) => {
  if (req.method === "OPTIONS") {
    return new Response("ok", { headers: corsHeaders });
  }

  try {
    if (req.method !== "POST") {
      return jsonResponse({ error: "Method not allowed" }, 405);
    }

    const supabaseUrl = Deno.env.get("SUPABASE_URL");
    const anonKey = Deno.env.get("SUPABASE_ANON_KEY");
    const serviceRoleKey = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY");

    if (!supabaseUrl || !anonKey || !serviceRoleKey) {
      return jsonResponse({ error: "Missing Supabase environment variables" }, 500);
    }

    const authHeader = req.headers.get("Authorization");

    if (!authHeader?.startsWith("Bearer ")) {
      return jsonResponse({ error: "Missing or invalid Authorization header" }, 401);
    }

    const token = authHeader.replace("Bearer ", "").trim();

    const userClient = createClient(supabaseUrl, anonKey, {
      global: { headers: { Authorization: authHeader } },
    });

    const adminClient = createClient(supabaseUrl, serviceRoleKey);

    const {
      data: { user },
      error: authError,
    } = await userClient.auth.getUser(token);

    if (authError || !user) {
      return jsonResponse(
        {
          error: "Unauthorized",
          details: authError?.message || "No user returned from token",
        },
        401,
      );
    }

    const body = (await req.json()) as RequestBody;

    const jobPostId = String(body.job_post_id || "").trim();
    const isActive = body.is_active;

    if (!jobPostId) {
      return jsonResponse({ error: "job_post_id is required" }, 400);
    }

    if (typeof isActive !== "boolean") {
      return jsonResponse({ error: "is_active must be true or false" }, 400);
    }

    const { data: jobPost, error: jobPostError } = await adminClient
      .from("job_posts")
      .select(`
        id,
        user_id,
        is_active,
        content_status,
        current_visible_version_id,
        current_pending_version_id,
        title
      `)
      .eq("id", jobPostId)
      .eq("user_id", user.id)
      .maybeSingle();

    if (jobPostError) {
      return jsonResponse(
        { error: "Failed to load job post", details: jobPostError.message },
        500,
      );
    }

    if (!jobPost) {
      return jsonResponse({ error: "Job post not found" }, 404);
    }

    const nowIso = new Date().toISOString();
    const statusReason = isActive
      ? "Reactivated by user from account page"
      : "Deactivated by user from account page";

    const updatePayload: Record<string, unknown> = {
      is_active: isActive,
      updated_at: nowIso,
      status_reason: statusReason,
      status_changed_at: nowIso,
    };

    if (!isActive) {
      updatePayload.current_pending_version_id = null;
    }

    const { error: updateError } = await adminClient
      .from("job_posts")
      .update(updatePayload)
      .eq("id", jobPostId)
      .eq("user_id", user.id);

    if (updateError) {
      return jsonResponse(
        { error: "Failed to update job post", details: updateError.message },
        500,
      );
    }

    const { data: updatedJob, error: reloadError } = await adminClient
      .from("job_posts")
      .select(`
        id,
        user_id,
        is_active,
        content_status,
        current_visible_version_id,
        current_pending_version_id,
        title,
        status_reason,
        updated_at,
        status_changed_at
      `)
      .eq("id", jobPostId)
      .eq("user_id", user.id)
      .maybeSingle();

    if (reloadError) {
      return jsonResponse(
        { error: "Job post updated but reload failed", details: reloadError.message },
        500,
      );
    }

    return jsonResponse({
      success: true,
      action: isActive ? "reactivated" : "deactivated",
      job_post: updatedJob,
    });
  } catch (e) {
    console.error("toggle-job-post-active-state error", e);
    return jsonResponse(
      { error: e instanceof Error ? e.message : "Unexpected error" },
      500,
    );
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
