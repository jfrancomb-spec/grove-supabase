import { serve } from "https://deno.land/std@0.224.0/http/server.ts";
import { createClient } from "https://esm.sh/@supabase/supabase-js@2.49.1";

type AccountStatus = "normal" | "queued" | "watched" | "paused" | "suspended" | "banned";
type MessageContentStatus = "published" | "flagged" | "queued";
type MessageDeliveryStatus = "delivered" | "hidden" | "blocked";
type ReviewStatus = "Passed AI Scan" | "Manual Review Approved" | "Manual Review Rejected" | null;

type SendMessageRequest = {
  conversationId: string;
  messageText: string;
};

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

    const supabaseUrl = Deno.env.get("SUPABASE_URL");
    const anonKey = Deno.env.get("SUPABASE_ANON_KEY");
    const serviceRoleKey = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY");

    const authHeader = req.headers.get("Authorization");

    const userClient = createClient(supabaseUrl!, anonKey!, {
      global: { headers: { Authorization: authHeader! } },
    });

    const adminClient = createClient(supabaseUrl!, serviceRoleKey!);

    const {
      data: { user },
    } = await userClient.auth.getUser();

    if (!user) return jsonResponse({ error: "Unauthorized" }, 401);

    const body = (await req.json()) as SendMessageRequest;
    const conversationId = body?.conversationId?.trim();
    const messageText = normalizeMessage(body?.messageText ?? "");

    if (!conversationId) return jsonResponse({ error: "conversationId is required" }, 400);
    if (!messageText) return jsonResponse({ error: "messageText is required" }, 400);

    const riskProfile = await getOrCreateUserRiskProfile(adminClient, user.id);

    if (["paused", "suspended", "banned"].includes(riskProfile.account_status)) {
      return jsonResponse({ error: "Account cannot send messages." }, 403);
    }

    const nowIso = new Date().toISOString();

    let contentStatus: MessageContentStatus;
    let deliveryStatus: MessageDeliveryStatus;
    let visibleToRecipient = false;
    let receivedAt: string | null = null;
    let reviewStatus: ReviewStatus = null;
    let flagTriggerType: "none" | "suspicious_content" | "queued_account" = "none";

    if (riskProfile.account_status === "queued") {
      contentStatus = "queued";
      deliveryStatus = "hidden";
      reviewStatus = null;
      flagTriggerType = "queued_account";
    } else {
      const moderation = moderateMessageHeuristics(messageText);

      if (moderation.suspicious) {
        contentStatus = "flagged";
        deliveryStatus = "hidden";
        reviewStatus = null;
        flagTriggerType = "suspicious_content";
      } else {
        contentStatus = "published";
        deliveryStatus = "delivered";
        visibleToRecipient = true;
        receivedAt = nowIso;
        reviewStatus = "Passed AI Scan";
      }
    }

    const { data: message } = await adminClient
      .from("messages")
      .insert({
        conversation_id: conversationId,
        sender_user_id: user.id,
        message_text: messageText,
        created_at: nowIso,
        sent_at: nowIso,
        received_at: receivedAt,
        content_status: contentStatus,
        delivery_status: deliveryStatus,
        visible_to_sender: true,
        visible_to_recipient: visibleToRecipient,
        review_status: reviewStatus,
        flag_trigger_type: flagTriggerType,
      })
      .select("*")
      .single();

    if (contentStatus === "flagged") {
      await queueUserAccount(adminClient, user.id);

      await createAdminReviewQueueItem(adminClient, {
        userId: user.id,
        queueType: "message",
        priority: "high",
        summary: `Flagged message: ${messageText.slice(0, 80)}`,
        relatedTable: "messages",
        relatedId: message.id,
      });
    }

    if (contentStatus === "queued") {
      await createAdminReviewQueueItemIfMissing(adminClient, {
        userId: user.id,
        queueType: "message",
        priority: "normal",
        summary: `Queued message: ${messageText.slice(0, 80)}`,
        relatedTable: "messages",
        relatedId: message.id,
      });
    }

    return jsonResponse({ success: true, message });
  } catch (e) {
    return jsonResponse({ error: (e as Error).message }, 500);
  }
});

function normalizeMessage(v: string) {
  return v.trim();
}

function moderateMessageHeuristics(text: string) {
  const risky = /(gift card|wire money|telegram|whatsapp)/i.test(text);
  return { suspicious: risky };
}

async function getOrCreateUserRiskProfile(adminClient: any, userId: string) {
  const { data } = await adminClient
    .from("user_risk_profiles")
    .select("*")
    .eq("user_id", userId)
    .maybeSingle();

  if (data) return data;

  const { data: created } = await adminClient
    .from("user_risk_profiles")
    .insert({ user_id: userId, account_status: "normal" })
    .select("*")
    .single();

  return created;
}

async function queueUserAccount(adminClient: any, userId: string) {
  await adminClient
    .from("user_risk_profiles")
    .update({ account_status: "queued" })
    .eq("user_id", userId);
}

async function createAdminReviewQueueItem(adminClient: any, args: any) {
  await adminClient.from("admin_review_queue").insert({
    user_id: args.userId,
    queue_type: args.queueType,
    priority: args.priority,
    status: "open",
    summary: args.summary,
    related_table: args.relatedTable,
    related_id: args.relatedId,
  });
}

async function createAdminReviewQueueItemIfMissing(adminClient: any, args: any) {
  const { data } = await adminClient
    .from("admin_review_queue")
    .select("id")
    .eq("related_id", args.relatedId)
    .maybeSingle();

  if (!data) {
    await createAdminReviewQueueItem(adminClient, args);
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
