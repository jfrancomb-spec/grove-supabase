begin;

alter table public.family_profile_versions
  drop column if exists email,
  drop column if exists phone,
  drop column if exists first_name,
  drop column if exists last_name;

alter table public.caregiver_profile_versions
  drop column if exists email,
  drop column if exists phone,
  drop column if exists first_name,
  drop column if exists last_name;

alter table public.family_profiles
  drop column if exists email,
  drop column if exists phone,
  drop column if exists first_name,
  drop column if exists last_name;

alter table public.caregiver_profiles
  drop column if exists email,
  drop column if exists phone,
  drop column if exists first_name,
  drop column if exists last_name;

commit;
