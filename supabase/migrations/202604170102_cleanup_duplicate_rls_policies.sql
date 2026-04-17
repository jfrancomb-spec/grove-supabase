begin;

-- care_requests: consolidate duplicate public/admin select and insert policies
drop policy if exists care_requests_select_public on public.care_requests;
drop policy if exists care_requests_insert_public on public.care_requests;
drop policy if exists "Anon can select care requests" on public.care_requests;
drop policy if exists "Authenticated can select care requests" on public.care_requests;
drop policy if exists admin_select_care_requests on public.care_requests;
drop policy if exists "Public can insert care requests" on public.care_requests;
drop policy if exists care_requests_insert_anon on public.care_requests;
drop policy if exists care_requests_insert_auth on public.care_requests;
drop policy if exists public_insert_care_requests on public.care_requests;

create policy care_requests_select_public
on public.care_requests
as permissive
for select
to anon, authenticated
using (true);

create policy care_requests_insert_public
on public.care_requests
as permissive
for insert
to anon, authenticated
with check (true);

-- caregiver_applications: consolidate overlapping public insert policies
drop policy if exists caregiver_applications_insert_public on public.caregiver_applications;
drop policy if exists "Public can insert caregiver applications" on public.caregiver_applications;
drop policy if exists caregiver_applications_insert_auth on public.caregiver_applications;
drop policy if exists public_insert_caregiver_applications on public.caregiver_applications;

create policy caregiver_applications_insert_public
on public.caregiver_applications
as permissive
for insert
to anon, authenticated
with check (true);

-- family_profiles: remove exact duplicate public active-profile select policy
drop policy if exists public_select_family_profiles on public.family_profiles;

commit;
