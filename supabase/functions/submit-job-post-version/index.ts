import { serve } from "https://deno.land/std@0.224.0/http/server.ts";
import { createClient } from "https://esm.sh/@supabase/supabase-js@2.49.1";

const corsHeaders = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers": "authorization, x-client-info, apikey, content-type",
  "Access-Control-Allow-Methods": "POST, OPTIONS",
};

type RequestBody = {
  care_type: string;
  schedule: string;
  description: string;
  pay_range?: string;
  job_post_id?: string;
};

serve(async (req) => {
  if (req.method === "OPTIONS") {
    return new Response("ok", { headers: corsHeaders });
  }

  try {
    console.log("submit-job-post-version hit");

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
      global: {
        headers: {
          Authorization: authHeader,
        },
      },
    });

    const adminClient = createClient(supabaseUrl, serviceRoleKey);

    const {
      data: { user },
      error: authError,
    } = await userClient.auth.getUser(token);

    console.log("authError:", authError?.message || null);
    console.log("userId:", user?.id || null);

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

    const careType = (body.care_type || "").trim();
    const schedule = (body.schedule || "").trim();
    const description = (body.description || "").trim();
    const payRange = (body.pay_range || "").trim();

    if (!careType) return jsonResponse({ error: "care_type is required" }, 400);
    if (!schedule) return jsonResponse({ error: "schedule is required" }, 400);
    if (!description) return jsonResponse({ error: "description is required" }, 400);

    const title = generateJobTitle(careType);

    const { data: familyProfile, error: familyProfileError } = await adminClient
      .from("family_profiles")
      .select("id, current_visible_version_id, is_active")
      .eq("user_id", user.id)
      .eq("is_active", true)
      .maybeSingle();

    if (familyProfileError) {
      return jsonResponse(
        { error: "Failed to load family profile", details: familyProfileError.message },
        500,
      );
    }

    if (!familyProfile) {
      return jsonResponse(
        { error: "You must complete your family profile before posting a job." },
        400,
      );
    }

    if (!familyProfile.current_visible_version_id) {
      return jsonResponse(
        { error: "Your family profile must be approved before posting a job." },
        400,
      );
    }

    const { data: familyVersion, error: familyVersionError } = await adminClient
      .from("family_profile_versions")
      .select("location, is_live, content_status")
      .eq("id", familyProfile.current_visible_version_id)
      .maybeSingle();

    if (familyVersionError) {
      return jsonResponse(
        { error: "Failed to load family profile version", details: familyVersionError.message },
        500,
      );
    }

    if (!familyVersion || !familyVersion.is_live || familyVersion.content_status !== "published") {
      return jsonResponse(
        { error: "Your family profile must be approved before posting a job." },
        400,
      );
    }

    const location = (familyVersion.location || "").trim();

    if (!location) {
      return jsonResponse(
        { error: "Family profile location is required before posting a job." },
        400,
      );
    }

    const nowIso = new Date().toISOString();

    const parent = await getOrCreateJobPost(
      adminClient,
      user.id,
      {
        title,
        care_type: careType,
        location,
        schedule,
        description,
        pay_range: payRange || null,
      },
      body.job_post_id,
    );

    const risk = await getOrCreateUserRiskProfile(adminClient, user.id);
    const accountIsQueued = risk.account_status === "queued";

    const contentStatus = accountIsQueued ? "queued" : "published";
    const reviewStatus = accountIsQueued ? null : "Passed AI Scan";
    const isLive = !accountIsQueued;

    if (contentStatus === "published") {
      await supersedeJobVersions(adminClient, parent.id, ["queued", "published"]);
    } else {
      await supersedeJobVersions(adminClient, parent.id, ["queued"]);
    }

    const nextVersion = await getNextVersionNumber(adminClient, parent.id);

    const payload = {
      job_post_id: parent.id,
      version_number: nextVersion,
      created_at: nowIso,
      submitted_at: nowIso,
      title,
      care_type: careType,
      location,
      schedule,
      description,
      pay_range: payRange || null,
      content_status: contentStatus,
      review_status: reviewStatus,
      moderation_reason: null,
      moderation_details: {},
      flag_trigger_type: "none",
      risk_score: 0,
      approved_at: contentStatus === "published" ? nowIso : null,
      held_at: null,
      reviewed_at: null,
      reviewed_by: null,
      is_live: isLive,
      status_reason: null,
      rejection_reason: null,
      status_changed_at: nowIso,
      status_changed_by: null,
      deleted_at: null,
      updated_at: nowIso,
    };

    const { data: version, error: versionError } = await adminClient
      .from("job_post_versions")
      .insert(payload)
      .select("*")
      .single();

    if (versionError || !version) {
      return jsonResponse(
        { error: "Failed to create job post version", details: versionError?.message },
        500,
      );
    }

    const parentUpdate: Record<string, unknown> = {
      title,
      care_type: careType,
      location,
      schedule,
      description,
      pay_range: payRange || null,
      moderation_details: {},
      flag_trigger_type: "none",
      updated_at: nowIso,
    };

    if (contentStatus === "published") {
      parentUpdate.current_visible_version_id = version.id;
      parentUpdate.current_pending_version_id = null;
      parentUpdate.is_active = true;
      parentUpdate.content_status = "published";
      parentUpdate.status_reason = "Published after passing AI scan";
      parentUpdate.status_changed_at = nowIso;
    } else {
      parentUpdate.current_pending_version_id = version.id;
      parentUpdate.content_status = "queued";
      parentUpdate.status_reason = "Queued because account has unresolved flagged content";
      parentUpdate.status_changed_at = nowIso;
    }

    const { error: parentUpdateError } = await adminClient
      .from("job_posts")
      .update(parentUpdate)
      .eq("id", parent.id);

    if (parentUpdateError) {
      return jsonResponse(
        { error: "Failed to update job post parent", details: parentUpdateError.message },
        500,
      );
    }

    if (contentStatus === "queued") {
      await createQueueItemIfMissing(adminClient, {
        userId: user.id,
        queueType: "job_post",
        summary: `Queued job post: ${title}`,
        relatedTable: "job_post_versions",
        relatedId: version.id,
        priority: "normal",
      });
    }

    return jsonResponse({
      success: true,
      job_post_id: parent.id,
      version,
    });
  } catch (e) {
    console.error("submit-job-post-version error", e);
    return jsonResponse(
      { error: e instanceof Error ? e.message : "Unexpected error" },
      500,
    );
  }
});

function generateJobTitle(careType: string) {
  switch (careType.toLowerCase()) {
    case "childcare":
      return "Childcare Needed";
    case "senior care":
      return "Senior Care Needed";
    case "pet care":
      return "Pet Care Needed";
    case "household help":
      return "Household Help Needed";
    default:
      return "Care Needed";
  }
}

async function getOrCreateJobPost(
  adminClient: ReturnType<typeof createClient>,
  userId: string,
  values: {
    title: string;
    care_type: string;
    location: string;
    schedule: string;
    description: string;
    pay_range: string | null;
  },
  jobPostId?: string,
) {
  if (jobPostId) {
    const { data: explicitJob, error: explicitError } = await adminClient
      .from("job_posts")
      .select("*")
      .eq("id", jobPostId)
      .eq("user_id", userId)
      .maybeSingle();

    if (explicitError) {
      throw new Error(`Failed to load job post parent by id: ${explicitError.message}`);
    }

    if (!explicitJob) {
      throw new Error("Specified job post parent was not found");
    }

    return explicitJob;
  }

  const { data: created, error: createError } = await adminClient
    .from("job_posts")
    .insert({
      user_id: userId,
      title: values.title,
      care_type: values.care_type,
      location: values.location,
      schedule: values.schedule,
      description: values.description,
      pay_range: values.pay_range,
      is_active: false,
      content_status: "draft",
      moderation_details: {},
      flag_trigger_type: "none",
      updated_at: new Date().toISOString(),
    })
    .select("*")
    .single();

  if (createError || !created) {
    throw new Error(`Failed to create job post parent: ${createError?.message}`);
  }

  return created;
}

async function supersedeJobVersions(
  adminClient: ReturnType<typeof createClient>,
  jobPostId: string,
  statuses: string[],
) {
  const { data, error } = await adminClient
    .from("job_post_versions")
    .select("id")
    .eq("job_post_id", jobPostId)
    .in("content_status", statuses);

  if (error) {
    throw new Error(`Failed to load job post versions to supersede: ${error.message}`);
  }

  if (!data?.length) return;

  const nowIso = new Date().toISOString();

  const { error: updateError } = await adminClient
    .from("job_post_versions")
    .update({
      content_status: "superseded",
      is_live: false,
      status_reason: "Superseded by newer job post submission",
      status_changed_at: nowIso,
      updated_at: nowIso,
    })
    .in("id", data.map((x: { id: string }) => x.id));

  if (updateError) {
    throw new Error(`Failed to supersede job post versions: ${updateError.message}`);
  }

  await resolveSupersededQueueItems(adminClient, {
    relatedTable: "job_post_versions",
    relatedIds: data.map((x: { id: string }) => x.id),
    notes: "Superseded by newer job post submission",
  });
}

async function getNextVersionNumber(
  adminClient: ReturnType<typeof createClient>,
  jobPostId: string,
) {
  const { data, error } = await adminClient
    .from("job_post_versions")
    .select("version_number")
    .eq("job_post_id", jobPostId)
    .order("version_number", { ascending: false })
    .limit(1)
    .maybeSingle();

  if (error) {
    throw new Error(`Failed to determine job post version number: ${error.message}`);
  }

  return (data?.version_number || 0) + 1;
}

async function getOrCreateUserRiskProfile(
  adminClient: ReturnType<typeof createClient>,
  userId: string,
) {
  const { data: existing, error: existingError } = await adminClient
    .from("user_risk_profiles")
    .select("*")
    .eq("user_id", userId)
    .maybeSingle();

  if (existingError) {
    throw new Error(`Failed to load user_risk_profiles: ${existingError.message}`);
  }

  if (existing) return existing as { account_status: string };

  const { data: created, error: createError } = await adminClient
    .from("user_risk_profiles")
    .insert({
      user_id: userId,
      risk_score: 0,
      risk_level: "low",
      account_status: "normal",
      verification_status: "none",
    })
    .select("*")
    .single();

  if (createError || !created) {
    throw new Error(`Failed to create user_risk_profiles row: ${createError?.message}`);
  }

  return created as { account_status: string };
}

async function createQueueItemIfMissing(
  adminClient: ReturnType<typeof createClient>,
  args: {
    userId: string;
    queueType: string;
    summary: string;
    relatedTable: string;
    relatedId: string;
    priority: "low" | "normal" | "high" | "urgent";
  },
) {
  const { data: existing, error: existingError } = await adminClient
    .from("admin_review_queue")
    .select("id")
    .eq("related_table", args.relatedTable)
    .eq("related_id", args.relatedId)
    .in("status", ["open", "in_review"])
    .maybeSingle();

  if (existingError) {
    throw new Error(`Failed checking admin queue: ${existingError.message}`);
  }

  if (existing) return existing;

  const { error } = await adminClient
    .from("admin_review_queue")
    .insert({
      user_id: args.userId,
      queue_type: args.queueType,
      priority: args.priority,
      status: "open",
      summary: args.summary,
      related_table: args.relatedTable,
      related_id: args.relatedId,
    });

  if (error) {
    throw new Error(`Failed to create admin queue item: ${error.message}`);
  }
}

async function resolveSupersededQueueItems(
  adminClient: ReturnType<typeof createClient>,
  args: {
    relatedTable: string;
    relatedIds: string[];
    notes: string;
  },
) {
  if (!args.relatedIds.length) return;

  const { error } = await adminClient
    .from("admin_review_queue")
    .update({
      status: "resolved",
      resolved_at: new Date().toISOString(),
      resolution: "superseded",
      review_notes: args.notes,
    })
    .eq("related_table", args.relatedTable)
    .in("related_id", args.relatedIds)
    .in("status", ["open", "in_review"]);

  if (error) {
    throw new Error(`Failed to resolve superseded queue items: ${error.message}`);
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
