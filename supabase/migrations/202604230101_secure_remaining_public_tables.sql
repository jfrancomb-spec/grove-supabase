begin;

-- Shared helpers keep policies readable and avoid recursive RLS checks.
create or replace function public.grove_is_admin()
returns boolean
language sql
stable
security definer
set search_path = public
as $$
  select exists (
    select 1
    from public.admin_users au
    where au.user_id = auth.uid()
  );
$$;

create or replace function public.grove_is_conversation_participant(p_conversation_id uuid)
returns boolean
language sql
stable
security definer
set search_path = public
as $$
  select exists (
    select 1
    from public.conversation_participants cp
    where cp.conversation_id = p_conversation_id
      and cp.user_id = auth.uid()
  );
$$;

create or replace function public.grove_conversation_created_by_current_user(p_conversation_id uuid)
returns boolean
language sql
stable
security definer
set search_path = public
as $$
  select exists (
    select 1
    from public.conversations c
    where c.id = p_conversation_id
      and c.created_by_user_id = auth.uid()
  );
$$;

alter table public.account_status_history enable row level security;
alter table public.admin_action_log enable row level security;
alter table public.admin_review_queue enable row level security;
alter table public.caregiver_profile_versions enable row level security;
alter table public.content_status_history enable row level security;
alter table public.conversation_participants enable row level security;
alter table public.conversations enable row level security;
alter table public.family_profile_versions enable row level security;
alter table public.fraud_signals enable row level security;
alter table public.messages enable row level security;
alter table public.user_risk_profiles enable row level security;

-- Admin/moderation tables are not public. Service-role Edge Functions bypass RLS.
drop policy if exists account_status_history_admin_select on public.account_status_history;
drop policy if exists admin_action_log_admin_select on public.admin_action_log;
drop policy if exists admin_review_queue_admin_select on public.admin_review_queue;
drop policy if exists admin_review_queue_admin_update on public.admin_review_queue;
drop policy if exists content_status_history_admin_select on public.content_status_history;
drop policy if exists fraud_signals_admin_select on public.fraud_signals;
drop policy if exists fraud_signals_admin_update on public.fraud_signals;
drop policy if exists user_risk_profiles_admin_select on public.user_risk_profiles;

create policy account_status_history_admin_select
on public.account_status_history
as permissive
for select
to authenticated
using (public.grove_is_admin());

create policy admin_action_log_admin_select
on public.admin_action_log
as permissive
for select
to authenticated
using (public.grove_is_admin());

create policy admin_review_queue_admin_select
on public.admin_review_queue
as permissive
for select
to authenticated
using (public.grove_is_admin());

create policy admin_review_queue_admin_update
on public.admin_review_queue
as permissive
for update
to authenticated
using (public.grove_is_admin())
with check (public.grove_is_admin());

create policy content_status_history_admin_select
on public.content_status_history
as permissive
for select
to authenticated
using (public.grove_is_admin());

create policy fraud_signals_admin_select
on public.fraud_signals
as permissive
for select
to authenticated
using (public.grove_is_admin());

create policy fraud_signals_admin_update
on public.fraud_signals
as permissive
for update
to authenticated
using (public.grove_is_admin())
with check (public.grove_is_admin());

create policy user_risk_profiles_admin_select
on public.user_risk_profiles
as permissive
for select
to authenticated
using (public.grove_is_admin());

-- Public profile versions: live/published versions are visible for browsing;
-- owners can see their own pending/working versions in account and edit pages.
drop policy if exists caregiver_profile_versions_public_live_select on public.caregiver_profile_versions;
drop policy if exists caregiver_profile_versions_owner_select on public.caregiver_profile_versions;
drop policy if exists caregiver_profile_versions_admin_select on public.caregiver_profile_versions;
drop policy if exists family_profile_versions_public_live_select on public.family_profile_versions;
drop policy if exists family_profile_versions_owner_select on public.family_profile_versions;
drop policy if exists family_profile_versions_admin_select on public.family_profile_versions;

create policy caregiver_profile_versions_public_live_select
on public.caregiver_profile_versions
as permissive
for select
to anon, authenticated
using (
  is_live = true
  and content_status in ('visible', 'approved', 'published')
);

create policy caregiver_profile_versions_owner_select
on public.caregiver_profile_versions
as permissive
for select
to authenticated
using (
  exists (
    select 1
    from public.caregiver_profiles cp
    where cp.id = caregiver_profile_versions.caregiver_profile_id
      and cp.user_id = auth.uid()
  )
);

create policy caregiver_profile_versions_admin_select
on public.caregiver_profile_versions
as permissive
for select
to authenticated
using (public.grove_is_admin());

create policy family_profile_versions_public_live_select
on public.family_profile_versions
as permissive
for select
to anon, authenticated
using (
  is_live = true
  and content_status in ('visible', 'approved', 'published')
);

create policy family_profile_versions_owner_select
on public.family_profile_versions
as permissive
for select
to authenticated
using (
  exists (
    select 1
    from public.family_profiles fp
    where fp.id = family_profile_versions.family_profile_id
      and fp.user_id = auth.uid()
  )
);

create policy family_profile_versions_admin_select
on public.family_profile_versions
as permissive
for select
to authenticated
using (public.grove_is_admin());

-- Messaging tables: users can only access conversations they participate in.
drop policy if exists conversations_participant_select on public.conversations;
drop policy if exists conversations_user_insert on public.conversations;
drop policy if exists conversations_admin_select on public.conversations;
drop policy if exists conversation_participants_participant_select on public.conversation_participants;
drop policy if exists conversation_participants_user_or_creator_insert on public.conversation_participants;
drop policy if exists conversation_participants_owner_update on public.conversation_participants;
drop policy if exists conversation_participants_admin_select on public.conversation_participants;
drop policy if exists messages_participant_select_visible on public.messages;
drop policy if exists messages_sender_insert on public.messages;
drop policy if exists messages_admin_select on public.messages;

create policy conversations_participant_select
on public.conversations
as permissive
for select
to authenticated
using (public.grove_is_conversation_participant(id));

create policy conversations_user_insert
on public.conversations
as permissive
for insert
to authenticated
with check (created_by_user_id = auth.uid());

create policy conversations_admin_select
on public.conversations
as permissive
for select
to authenticated
using (public.grove_is_admin());

create policy conversation_participants_participant_select
on public.conversation_participants
as permissive
for select
to authenticated
using (public.grove_is_conversation_participant(conversation_id));

create policy conversation_participants_user_or_creator_insert
on public.conversation_participants
as permissive
for insert
to authenticated
with check (
  user_id = auth.uid()
  or public.grove_conversation_created_by_current_user(conversation_id)
);

create policy conversation_participants_owner_update
on public.conversation_participants
as permissive
for update
to authenticated
using (user_id = auth.uid())
with check (user_id = auth.uid());

create policy conversation_participants_admin_select
on public.conversation_participants
as permissive
for select
to authenticated
using (public.grove_is_admin());

create policy messages_participant_select_visible
on public.messages
as permissive
for select
to authenticated
using (
  public.grove_is_conversation_participant(conversation_id)
  and (
    (sender_user_id = auth.uid() and visible_to_sender = true)
    or
    (sender_user_id <> auth.uid() and visible_to_recipient = true)
  )
);

create policy messages_sender_insert
on public.messages
as permissive
for insert
to authenticated
with check (
  sender_user_id = auth.uid()
  and public.grove_is_conversation_participant(conversation_id)
);

create policy messages_admin_select
on public.messages
as permissive
for select
to authenticated
using (public.grove_is_admin());

commit;
