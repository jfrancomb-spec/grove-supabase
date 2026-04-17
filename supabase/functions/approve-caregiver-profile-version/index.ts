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
    if (!authHeader) {
      return jsonResponse({ error: "Missing Authorization header" }, 401);
    }

    const userClient = createClient(supabaseUrl, anonKey, {
      global: { headers: { Authorization: authHeader } },
    });

    const adminClient = createClient(supabaseUrl, serviceRoleKey);

    const {
      data: { user },
      error: authError,
    } = await userClient.auth.getUser();

    if (authError || !user) {
      return jsonResponse({ error: "Unauthorized" }, 401);
    }

    const body = (await req.json()) as RequestBody;
    const versionId = body?.versionId?.trim();
    const notes = (body?.notes || "").trim();

    if (!versionId) {
      return jsonResponse({ error: "versionId is required" }, 400);
    }

    const { data: version, error: versionError } = await adminClient
      .from("caregiver_profile_versions")
      .select("*")
      .eq("id", versionId)
      .maybeSingle();

    if (versionError) {
      return jsonResponse(
        { error: "Failed to load caregiver profile version", details: versionError.message },
        500,
      );
    }

    if (!version) {
      return jsonResponse({ error: "Caregiver profile version not found" }, 404);
    }

    const caregiverProfileId = version.caregiver_profile_id;
    if (!caregiverProfileId) {
      return jsonResponse({ error: "Version is missing caregiver_profile_id" }, 400);
    }

    const { data: parentProfile, error: parentError } = await adminClient
      .from("caregiver_profiles")
      .select("*")
      .eq("id", caregiverProfileId)
      .maybeSingle();

    if (parentError) {
      return jsonResponse(
        { error: "Failed to load caregiver profile", details: parentError.message },
        500,
      );
    }

    if (!parentProfile) {
      return jsonResponse({ error: "Caregiver profile parent not found" }, 404);
    }

    const nowIso = new Date().toISOString();

    const { error: supersedeError } = await adminClient
      .from("caregiver_profile_versions")
      .update({
        content_status: "superseded",
        is_live: false,
      })
      .eq("caregiver_profile_id", caregiverProfileId)
      .eq("content_status", "published");

    if (supersedeError) {
      return jsonResponse(
        { error: "Failed to supersede current published caregiver version", details: supersedeError.message },
        500,
      );
    }

    const { data: approvedVersion, error: approveError } = await adminClient
      .from("caregiver_profile_versions")
      .update({
        content_status: "published",
        review_status: "Manual Review Approved",
        is_live: true,
        reviewed_at: nowIso,
        reviewed_by: user.id,
      })
      .eq("id", versionId)
      .select("*")
      .single();

    if (approveError || !approvedVersion) {
      return jsonResponse(
        { error: "Failed to approve caregiver profile version", details: approveError?.message },
        500,
      );
    }

    const { error: parentUpdateError } = await adminClient
      .from("caregiver_profiles")
      .update({
        current_visible_version_id: versionId,
        current_pending_version_id: null,
        is_active: true,
        updated_at: nowIso,
      })
      .eq("id", caregiverProfileId);

    if (parentUpdateError) {
      return jsonResponse(
        { error: "Failed to update caregiver profile parent", details: parentUpdateError.message },
        500,
      );
    }

    await resolveQueueItem(adminClient, {
      relatedTable: "caregiver_profile_versions",
      relatedId: versionId,
      reviewerId: user.id,
      resolution: "approved",
      notes,
    });

    await updateFraudSignals(adminClient, {
      relatedTable: "caregiver_profile_versions",
      relatedId: versionId,
      reviewerId: user.id,
      newStatus: "reviewed",
    });

    if (parentProfile.user_id) {
      const remainingFlagged = await countRemainingFlaggedCaregiverVersions(adminClient, parentProfile.user_id);

      await setUserRiskStatus(adminClient, {
        userId: parentProfile.user_id,
        accountStatus: remainingFlagged > 0 ? "queued" : "normal",
      });
    }

    return jsonResponse({
      success: true,
      version: approvedVersion,
    });
  } catch (error) {
    console.error("approve-caregiver-profile-version error", error);
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

async function updateFraudSignals(
  adminClient: ReturnType<typeof createClient>,
  args: {
    relatedTable: string;
    relatedId: string;
    reviewerId: string;
    newStatus: "reviewed" | "confirmed" | "dismissed";
  },
) {
  const { error } = await adminClient
    .from("fraud_signals")
    .update({
      status: args.newStatus,
      reviewed_at: new Date().toISOString(),
      reviewed_by: args.reviewerId,
    })
    .eq("related_table", args.relatedTable)
    .eq("related_id", args.relatedId)
    .eq("status", "open");

  if (error) {
    throw new Error(`Failed to update fraud signals: ${error.message}`);
  }
}

async function countRemainingFlaggedCaregiverVersions(
  adminClient: ReturnType<typeof createClient>,
  userId: string,
) {
  const { data: caregiverProfiles, error: profilesError } = await adminClient
    .from("caregiver_profiles")
    .select("id")
    .eq("user_id", userId);

  if (profilesError) {
    throw new Error(`Failed to load caregiver profiles for user: ${profilesError.message}`);
  }

  const caregiverProfileIds = (caregiverProfiles || []).map((row: { id: string }) => row.id);

  if (!caregiverProfileIds.length) {
    return 0;
  }

  const { count, error } = await adminClient
    .from("caregiver_profile_versions")
    .select("id", { count: "exact", head: true })
    .eq("content_status", "flagged")
    .in("caregiver_profile_id", caregiverProfileIds);

  if (error) {
    throw new Error(`Failed to count remaining flagged caregiver versions: ${error.message}`);
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
