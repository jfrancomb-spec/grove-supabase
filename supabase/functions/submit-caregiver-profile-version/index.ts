import { serve } from "https://deno.land/std@0.224.0/http/server.ts";
import { createClient } from "https://esm.sh/@supabase/supabase-js@2.49.1";

const corsHeaders = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers": "authorization, x-client-info, apikey, content-type",
  "Access-Control-Allow-Methods": "POST, OPTIONS",
};

type RequestBody = {
  name_display: string;
  location: string;
  care_types: string[];
  years_experience?: string;
  availability?: string;
  has_drivers_license?: boolean;
  cpr_certified?: boolean;
  non_smoker?: boolean;
  non_vaper?: boolean;
  comfortable_with_cats?: boolean;
  comfortable_with_dogs?: boolean;
  bio?: string;
  photo_urls?: string[];
  caregiver_profile_id?: string;
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

    const adminClient = createClient(supabaseUrl, serviceRoleKey);
    const token = authHeader.replace("Bearer ", "").trim();
    const jwtPayload = decodeJwtPayload(token);
    const userId = String(jwtPayload?.sub || "").trim();

    if (!userId) {
      return jsonResponse({ error: "Unauthorized", details: "Token did not include a user id" }, 401);
    }

    const body = (await req.json()) as RequestBody;

    const displayName = (body.name_display || "").trim();
    const location = (body.location || "").trim();
    const yearsExperience = (body.years_experience || "").trim();
    const availability = (body.availability || "").trim();
    const bio = (body.bio || "").trim();
    const careTypes = Array.isArray(body.care_types) ? body.care_types.filter(Boolean) : [];
    const photoUrls = Array.isArray(body.photo_urls) ? body.photo_urls.filter(Boolean).slice(0, 5) : [];

    if (!displayName) {
      return jsonResponse({ error: "name_display is required" }, 400);
    }

    if (!location) {
      return jsonResponse({ error: "location is required" }, 400);
    }

    if (!careTypes.length) {
      return jsonResponse({ error: "At least one care type is required" }, 400);
    }

    const nowIso = new Date().toISOString();

    const parent = await getOrCreateCaregiverProfile(
      adminClient,
      userId,
      displayName,
      body.caregiver_profile_id,
    );

    const risk = await getOrCreateUserRiskProfile(adminClient, userId);
    const accountIsQueued = risk.account_status === "queued";

    const contentStatus = accountIsQueued ? "queued" : "published";
    const reviewStatus = accountIsQueued ? null : "Passed AI Scan";
    const isLive = !accountIsQueued;

    if (contentStatus === "published") {
      await supersede(adminClient, parent.id, ["queued", "published"]);
    } else {
      await supersede(adminClient, parent.id, ["queued"]);
    }

    const nextVersion = await getNextVersionNumber(adminClient, parent.id);

    const payload = {
      caregiver_profile_id: parent.id,
      version_number: nextVersion,
      submitted_at: nowIso,
      name_display: displayName,
      location,
      care_types: careTypes,
      care_type: careTypes[0],
      years_experience: yearsExperience || null,
      availability: availability || null,
      has_drivers_license: !!body.has_drivers_license,
      cpr_certified: !!body.cpr_certified,
      non_smoker: !!body.non_smoker,
      non_vaper: !!body.non_vaper,
      comfortable_with_cats: !!body.comfortable_with_cats,
      comfortable_with_dogs: !!body.comfortable_with_dogs,
      bio: bio || null,
      photo_urls: photoUrls,
      photo_url: photoUrls[0] || null,
      content_status: contentStatus,
      review_status: reviewStatus,
      is_live: isLive,
      moderation_reason: null,
      moderation_details: {},
      flag_trigger_type: "none",
    };

    const { data: version, error: versionError } = await adminClient
      .from("caregiver_profile_versions")
      .insert(payload)
      .select("*")
      .single();

    if (versionError || !version) {
      return jsonResponse(
        { error: "Failed to create caregiver profile version", details: versionError?.message },
        500,
      );
    }

    const update: Record<string, unknown> = {
      name_display: displayName,
      location,
      care_types: careTypes,
      care_type: careTypes[0],
      years_experience: yearsExperience || null,
      availability: availability || null,
      has_drivers_license: !!body.has_drivers_license,
      cpr_certified: !!body.cpr_certified,
      non_smoker: !!body.non_smoker,
      non_vaper: !!body.non_vaper,
      comfortable_with_cats: !!body.comfortable_with_cats,
      comfortable_with_dogs: !!body.comfortable_with_dogs,
      bio: bio || null,
      photo_urls: photoUrls,
      photo_url: photoUrls[0] || null,
      updated_at: nowIso,
    };

    if (contentStatus === "published") {
      update.current_visible_version_id = version.id;
      update.current_pending_version_id = null;
      update.is_active = true;
    } else {
      update.current_pending_version_id = version.id;
    }

    const { error: parentUpdateError } = await adminClient
      .from("caregiver_profiles")
      .update(update)
      .eq("id", parent.id);

    if (parentUpdateError) {
      return jsonResponse(
        { error: "Failed to update caregiver profile parent", details: parentUpdateError.message },
        500,
      );
    }

    if (contentStatus === "queued") {
      await createQueueItemIfMissing(adminClient, {
        userId,
        queueType: "caregiver_profile",
        summary: `Queued caregiver profile: ${displayName}`,
        relatedTable: "caregiver_profile_versions",
        relatedId: version.id,
        priority: "normal",
      });
    }

    return jsonResponse({
      success: true,
      caregiver_profile_id: parent.id,
      version,
    });
  } catch (e) {
    console.error("submit-caregiver-profile-version error", e);
    return jsonResponse(
      { error: e instanceof Error ? e.message : "Unexpected error" },
      500,
    );
  }
});

async function supersede(
  adminClient: ReturnType<typeof createClient>,
  caregiverProfileId: string,
  statuses: string[],
) {
  const { data, error } = await adminClient
    .from("caregiver_profile_versions")
    .select("id")
    .eq("caregiver_profile_id", caregiverProfileId)
    .in("content_status", statuses);

  if (error) {
    throw new Error(`Failed to load caregiver versions to supersede: ${error.message}`);
  }

  if (!data?.length) return;

  const ids = data.map((x: { id: string }) => x.id);

  const { error: updateError } = await adminClient
    .from("caregiver_profile_versions")
    .update({
      content_status: "superseded",
      is_live: false,
    })
    .in("id", ids);

  if (updateError) {
    throw new Error(`Failed to supersede caregiver versions: ${updateError.message}`);
  }

  await resolveSupersededQueueItems(adminClient, {
    relatedTable: "caregiver_profile_versions",
    relatedIds: ids,
    notes: "Superseded by newer caregiver profile submission",
  });
}

async function getOrCreateCaregiverProfile(
  adminClient: ReturnType<typeof createClient>,
  userId: string,
  displayName: string,
  caregiverProfileId?: string,
) {
  if (caregiverProfileId) {
    const { data: explicitProfile, error: explicitError } = await adminClient
      .from("caregiver_profiles")
      .select("*")
      .eq("id", caregiverProfileId)
      .eq("user_id", userId)
      .maybeSingle();

    if (explicitError) {
      throw new Error(`Failed to load caregiver profile parent by id: ${explicitError.message}`);
    }

    if (!explicitProfile) {
      throw new Error("Specified caregiver profile parent was not found");
    }

    return explicitProfile;
  }

  const { data: existing, error: existingError } = await adminClient
    .from("caregiver_profiles")
    .select("*")
    .eq("user_id", userId)
    .maybeSingle();

  if (existingError) {
    throw new Error(`Failed to load caregiver profile parent: ${existingError.message}`);
  }

  if (existing) return existing;

  const { data: created, error: createError } = await adminClient
    .from("caregiver_profiles")
    .insert({
      user_id: userId,
      name_display: displayName,
      is_active: false,
      confirmed_encounters: 0,
    })
    .select("*")
    .single();

  if (createError || !created) {
    throw new Error(`Failed to create caregiver profile parent: ${createError?.message}`);
  }

  return created;
}

async function getNextVersionNumber(
  adminClient: ReturnType<typeof createClient>,
  caregiverProfileId: string,
) {
  const { data, error } = await adminClient
    .from("caregiver_profile_versions")
    .select("version_number")
    .eq("caregiver_profile_id", caregiverProfileId)
    .order("version_number", { ascending: false })
    .limit(1)
    .maybeSingle();

  if (error) {
    throw new Error(`Failed to determine caregiver version number: ${error.message}`);
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

  if (existing) return existing;

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

function decodeJwtPayload(token: string) {
  try {
    const [, payloadSegment] = token.split(".");
    if (!payloadSegment) return null;
    const normalized = payloadSegment.replace(/-/g, "+").replace(/_/g, "/");
    const padded = normalized.padEnd(normalized.length + ((4 - (normalized.length % 4)) % 4), "=");
    return JSON.parse(atob(padded));
  } catch {
    return null;
  }
}
