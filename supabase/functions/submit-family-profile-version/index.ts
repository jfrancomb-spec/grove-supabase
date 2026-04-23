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
  care_types_needed?: string[];
  has_cats?: boolean;
  has_dogs?: boolean;
  smoking_in_home?: boolean;
  driving_needed?: boolean;
  household_description?: string;
  children_description?: string;
  pets_description?: string;
  bio?: string;
  photo_urls?: string[];
  family_profile_id?: string;
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
    const careTypesNeeded = Array.isArray(body.care_types_needed)
      ? body.care_types_needed.filter(Boolean)
      : [];
    const householdDescription = (body.household_description || "").trim();
    const childrenDescription = (body.children_description || "").trim();
    const petsDescription = (body.pets_description || "").trim();
    const bio = (body.bio || "").trim();
    const photoUrls = Array.isArray(body.photo_urls)
      ? body.photo_urls.filter(Boolean).slice(0, 5)
      : [];

    if (!displayName) {
      return jsonResponse({ error: "name_display is required" }, 400);
    }

    if (!location) {
      return jsonResponse({ error: "location is required" }, 400);
    }

    const nowIso = new Date().toISOString();

    const parentProfile = await getOrCreateFamilyProfile(
      adminClient,
      userId,
      displayName,
      body.family_profile_id,
    );

    const riskProfile = await getOrCreateUserRiskProfile(adminClient, userId);
    const accountStatus = riskProfile.account_status || "normal";
    const accountIsQueued = accountStatus === "queued";

    const contentStatus = accountIsQueued ? "queued" : "published";
    const reviewStatus = accountIsQueued ? null : "Passed AI Scan";
    const isLive = !accountIsQueued;

    if (contentStatus === "published") {
      await supersedeOlderFamilyVersions(adminClient, {
        familyProfileId: parentProfile.id,
        statusesToSupersede: ["queued", "published"],
        notes: "Superseded by newer published family profile submission",
      });
    } else {
      await supersedeOlderFamilyVersions(adminClient, {
        familyProfileId: parentProfile.id,
        statusesToSupersede: ["queued"],
        notes: "Superseded by newer queued family profile submission",
      });
    }

    const nextVersionNumber = await getNextVersionNumber(adminClient, parentProfile.id);

    const versionPayload = {
      family_profile_id: parentProfile.id,
      version_number: nextVersionNumber,
      submitted_at: nowIso,
      name_display: displayName,
      location,
      care_types_needed: careTypesNeeded,
      has_cats: !!body.has_cats,
      has_dogs: !!body.has_dogs,
      smoking_in_home: !!body.smoking_in_home,
      driving_needed: !!body.driving_needed,
      household_description: householdDescription || null,
      children_description: childrenDescription || null,
      pets_description: petsDescription || null,
      bio: bio || null,
      photo_urls: photoUrls,
      photo_url: photoUrls[0] || null,
      content_status: contentStatus,
      review_status: reviewStatus,
      flag_trigger_type: "none",
      is_live: isLive,
      moderation_reason: null,
      moderation_details: {},
    };

    const { data: newVersion, error: versionError } = await adminClient
      .from("family_profile_versions")
      .insert(versionPayload)
      .select("*")
      .single();

    if (versionError || !newVersion) {
      return jsonResponse(
        { error: "Failed to create family profile version", details: versionError?.message },
        500,
      );
    }

    const parentUpdatePayload: Record<string, unknown> = {
      name_display: displayName,
      location,
      care_types_needed: careTypesNeeded,
      has_cats: !!body.has_cats,
      has_dogs: !!body.has_dogs,
      smoking_in_home: !!body.smoking_in_home,
      driving_needed: !!body.driving_needed,
      household_description: householdDescription || null,
      children_description: childrenDescription || null,
      pets_description: petsDescription || null,
      bio: bio || null,
      photo_urls: photoUrls,
      photo_url: photoUrls[0] || null,
      updated_at: nowIso,
    };

    if (contentStatus === "published") {
      parentUpdatePayload.current_visible_version_id = newVersion.id;
      parentUpdatePayload.current_pending_version_id = null;
      parentUpdatePayload.is_active = true;
    } else {
      parentUpdatePayload.current_pending_version_id = newVersion.id;
    }

    const { error: parentUpdateError } = await adminClient
      .from("family_profiles")
      .update(parentUpdatePayload)
      .eq("id", parentProfile.id);

    if (parentUpdateError) {
      return jsonResponse(
        { error: "Failed to update family profile parent", details: parentUpdateError.message },
        500,
      );
    }

    if (contentStatus === "queued") {
      await createQueueItemIfMissing(adminClient, {
        userId,
        queueType: "family_profile",
        summary: `Queued family profile: ${displayName}`,
        relatedTable: "family_profile_versions",
        relatedId: newVersion.id,
        priority: "normal",
      });
    }

    return jsonResponse({
      success: true,
      family_profile_id: parentProfile.id,
      version: newVersion,
    });
  } catch (error) {
    console.error("submit-family-profile-version error", error);
    return jsonResponse(
      { error: error instanceof Error ? error.message : "Unexpected error" },
      500,
    );
  }
});

async function getOrCreateFamilyProfile(
  adminClient: ReturnType<typeof createClient>,
  userId: string,
  displayName: string,
  familyProfileId?: string,
) {
  if (familyProfileId) {
    const { data: explicitProfile, error: explicitError } = await adminClient
      .from("family_profiles")
      .select("*")
      .eq("id", familyProfileId)
      .eq("user_id", userId)
      .maybeSingle();

    if (explicitError) {
      throw new Error(`Failed to load family profile parent by id: ${explicitError.message}`);
    }

    if (!explicitProfile) {
      throw new Error("Specified family profile parent was not found");
    }

    return explicitProfile;
  }

  const { data: existing, error: existingError } = await adminClient
    .from("family_profiles")
    .select("*")
    .eq("user_id", userId)
    .maybeSingle();

  if (existingError) {
    throw new Error(`Failed to load family profile parent: ${existingError.message}`);
  }

  if (existing) return existing;

  const { data: created, error: createError } = await adminClient
    .from("family_profiles")
    .insert({
      user_id: userId,
      name_display: displayName,
      is_active: false,
      confirmed_encounters: 0,
    })
    .select("*")
    .single();

  if (createError || !created) {
    throw new Error(`Failed to create family profile parent: ${createError?.message}`);
  }

  return created;
}

async function supersedeOlderFamilyVersions(
  adminClient: ReturnType<typeof createClient>,
  args: {
    familyProfileId: string;
    statusesToSupersede: string[];
    notes: string;
  },
) {
  const nowIso = new Date().toISOString();

  const { data: existingVersions, error: loadError } = await adminClient
    .from("family_profile_versions")
    .select("id")
    .eq("family_profile_id", args.familyProfileId)
    .in("content_status", args.statusesToSupersede);

  if (loadError) {
    throw new Error(`Failed to load older family versions: ${loadError.message}`);
  }

  const versionIds = (existingVersions || []).map((row) => row.id).filter(Boolean);
  if (!versionIds.length) return;

  const { error: versionUpdateError } = await adminClient
    .from("family_profile_versions")
    .update({
      content_status: "superseded",
      is_live: false,
      reviewed_at: nowIso,
      moderation_reason: "superseded_by_newer_submission",
      moderation_details: {
        system_resolution: "superseded",
      },
    })
    .in("id", versionIds);

  if (versionUpdateError) {
    throw new Error(`Failed to supersede older family versions: ${versionUpdateError.message}`);
  }

  await resolveSupersededQueueItems(adminClient, {
    relatedTable: "family_profile_versions",
    relatedIds: versionIds,
    notes: args.notes,
  });
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

async function getNextVersionNumber(
  adminClient: ReturnType<typeof createClient>,
  familyProfileId: string,
) {
  const { data, error } = await adminClient
    .from("family_profile_versions")
    .select("version_number")
    .eq("family_profile_id", familyProfileId)
    .order("version_number", { ascending: false })
    .limit(1)
    .maybeSingle();

  if (error) {
    throw new Error(`Failed to determine family version number: ${error.message}`);
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

  return created;
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
