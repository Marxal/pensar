-- pensar: images storage bucket
-- One object per card cover image, plus any images pasted into a note body.
-- See pensar-build-plan.md ("Storage: a `pensar-images` bucket").

-- ## The bucket has to be made by hand, once
--
-- In the Supabase dashboard: **Storage → New bucket**, named exactly
-- `pensar-images`, and **not public**. Then run this file, which writes its
-- policies.
--
-- Private rather than public: this is a single-user app, but there's no
-- reason to let a leaked object URL serve an image forever. Private means the
-- app asks for a signed link that expires, which is the right default here.
--
-- ## The path is the permission
--
-- Every object is stored as `<user_id>/<filename>`. The first folder is
-- therefore the owner, and every policy below is the same sentence: you may
-- touch an object whose first folder is you. That is why the path convention
-- is not a convention — it is the security model, and changing it in the app
-- without changing it here would open the bucket up.

-- Reads the owning user out of an object's path, or null if the path is not
-- that shape. A plain `::uuid` cast would *throw* on anything else, and a
-- policy that throws fails the whole query — including for objects in other
-- buckets, since SQL does not promise to test `bucket_id` first. Returning
-- null instead makes the `auth.uid() = ...` comparison answer false, which is
-- the right answer.
create or replace function public.pensar_image_owner(object_name text)
returns uuid
language sql
immutable
set search_path = ''
as $$
  select case
    when (storage.foldername(object_name))[1] ~
         '^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$'
    then ((storage.foldername(object_name))[1])::uuid
  end;
$$;

grant execute on function public.pensar_image_owner(text) to authenticated;

drop policy if exists "pensar_images_select_own" on storage.objects;
create policy "pensar_images_select_own"
  on storage.objects for select to authenticated
  using (
    bucket_id = 'pensar-images'
    and auth.uid() = public.pensar_image_owner(name)
  );

drop policy if exists "pensar_images_insert_own" on storage.objects;
create policy "pensar_images_insert_own"
  on storage.objects for insert to authenticated
  with check (
    bucket_id = 'pensar-images'
    and auth.uid() = public.pensar_image_owner(name)
  );

drop policy if exists "pensar_images_update_own" on storage.objects;
create policy "pensar_images_update_own"
  on storage.objects for update to authenticated
  using (
    bucket_id = 'pensar-images'
    and auth.uid() = public.pensar_image_owner(name)
  )
  with check (
    bucket_id = 'pensar-images'
    and auth.uid() = public.pensar_image_owner(name)
  );

drop policy if exists "pensar_images_delete_own" on storage.objects;
create policy "pensar_images_delete_own"
  on storage.objects for delete to authenticated
  using (
    bucket_id = 'pensar-images'
    and auth.uid() = public.pensar_image_owner(name)
  );
