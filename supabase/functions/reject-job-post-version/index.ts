import { serve } from "https://deno.land/std@0.224.0/http/server.ts";
import { createClient } from "https://esm.sh/@supabase/supabase-js@2.49.1";

const corsHeaders = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers": "authorization, x-client-info, apikey, content-type",
  "Access-Control-Allow-Methods": "POST, OPTIONS",
};

type RequestBody = {
  versionId: string;
  notes?: string;
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
        { error: "Unauthorized", details: authError?.message || "No user returned from token" },
        401,
      );
    }

    const body = (await req.json()) as RequestBody;
    const versionId = body?.versionId?.trim();
    const notes = (body?.notes || "").trim();

    if (!versionId) {
      return jsonResponse({ error: "versionId is required" }, 400);
    }

    const { data: version, error: versionError } = await adminClient
      .from("job_post_versions")
      .select("*")
      .eq("id", versionId)
      .maybeSingle();

    if (versionError) {
      return jsonResponse(
        { error: "Failed to load job post version", details: versionError.message },
        500,
      );
    }

    if (!version) {
      return jsonResponse({ error: "Job post version not found" }, 404);
    }

    const jobPostId = version.job_post_id;
    if (!jobPostId) {
      return jsonResponse({ error: "Version is missing job_post_id" }, 400);
    }

    const { data: parentPost, error: parentError } = await adminClient
      .from("job_posts")
      .select("*")
      .eq("id", jobPostId)
      .maybeSingle();

    if (parentError) {
      return jsonResponse(
        { error: "Failed to load job post", details: parentError.message },
        500,
      );
    }

    if (!parentPost) {
      return jsonResponse({ error: "Job post parent not found" }, 404);
    }

    const nowIso = new Date().toISOString();

    const { data: rejectedVersion, error: rejectError } = await adminClient
      .from("job_post_versions")
      .update({
        content_status: "rejected",
        review_status: "Manual Review Rejected",
        is_live: false,
        rejection_reason: notes || null,
        reviewed_at: nowIso,
        reviewed_by: user.id,
        status_reason: notes || "Rejected by admin",
        status_changed_at: nowIso,
        status_changed_by: user.id,
        updated_at: nowIso,
      })
      .eq("id", versionId)
      .select("*")
      .single();

    if (rejectError || !rejectedVersion) {
      return jsonResponse(
        { error: "Failed to reject job post version", details: rejectError?.message },
        500,
      );
    }

    const parentPatch: Record<string, unknown> = {
      current_pending_version_id: null,
      updated_at: nowIso,
    };

    if (!parentPost.current_visible_version_id) {
      parentPatch.is_active = false;
      parentPatch.content_status = "rejected";
      parentPatch.status_reason = notes || "Job post rejected with no currently published version";
      parentPatch.status_changed_at = nowIso;
      parentPatch.status_changed_by = user.id;
    }

    const { error: parentUpdateError } = await adminClient
      .from("job_posts")
      .update(parentPatch)
      .eq("id", jobPostId);

    if (parentUpdateError) {
      return jsonResponse(
        { error: "Failed to update job post parent", details: parentUpdateError.message },
        500,
      );
    }

    await resolveQueueItem(adminClient, {
      relatedTable: "job_post_versions",
      relatedId: versionId,
      reviewerId: user.id,
      resolution: "rejected",
      notes,
    });

    if (parentPost.user_id) {
      const remainingFlagged = await countRemainingFlaggedJobPostVersions(adminClient, parentPost.user_id);

      await setUserRiskStatus(adminClient, {
        userId: parentPost.user_id,
        accountStatus: remainingFlagged > 0 ? "queued" : "normal",
      });
    }

    return jsonResponse({
      success: true,
      version: rejectedVersion,
    });
  } catch (error) {
    console.error("reject-job-post-version error", error);
    return jsonResponse(
      { error: error instanceof Error ? error.message : "Unexpected error" },
      500,
    );
  }
});

async function resolveQueueItem(
  adminClient: ReturnType<typeof createClient>,
  args: {
    relatedTable: string;
    relatedId: string;
    reviewerId: string;
    resolution: string;
    notes?: string;
  },
) {
  const { error } = await adminClient
    .from("admin_review_queue")
    .update({
      status: "resolved",
      assigned_to: args.reviewerId,
      resolved_at: new Date().toISOString(),
      resolution: args.resolution,
      review_notes: args.notes || null,
    })
    .eq("related_table", args.relatedTable)
    .eq("related_id", args.relatedId)
    .in("status", ["open", "in_review"]);

  if (error) {
    throw new Error(`Failed to resolve admin review queue item: ${error.message}`);
  }
}

async function countRemainingFlaggedJobPostVersions(
  adminClient: ReturnType<typeof createClient>,
  userId: string,
) {
  const { data: jobPosts, error: postsError } = await adminClient
    .from("job_posts")
    .select("id")
    .eq("user_id", userId);

  if (postsError) {
    throw new Error(`Failed to load job posts for user: ${postsError.message}`);
  }

  const jobPostIds = (jobPosts || []).map((row: { id: string }) => row.id);

  if (!jobPostIds.length) {
    return 0;
  }

  const { count, error } = await adminClient
    .from("job_post_versions")
    .select("id", { count: "exact", head: true })
    .eq("content_status", "flagged")
    .in("job_post_id", jobPostIds);

  if (error) {
    throw new Error(`Failed to count remaining flagged job post versions: ${error.message}`);
  }

  return count || 0;
}

async function setUserRiskStatus(
  adminClient: ReturnType<typeof createClient>,
  args: {
    userId: string;
    accountStatus: "normal" | "queued" | "watched" | "paused" | "suspended" | "banned";
  },
) {
  const { error } = await adminClient
    .from("user_risk_profiles")
    .update({
      account_status: args.accountStatus,
      updated_at: new Date().toISOString(),
    })
    .eq("user_id", args.userId);

  if (error) {
    throw new Error(`Failed to update user_risk_profiles: ${error.message}`);
  }
}

function jsonResponse(payload: unknown, status = 200) {
  return new Response(JSON.stringify(payload), {
    status,
    headers: {
      ...corsHeaders,
      "Content-Type": "application/json",
    },
  });
}
