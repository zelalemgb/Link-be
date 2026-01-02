-- Mark Zelalem's invitation as accepted since they have successfully registered
UPDATE public.staff_invitations si
SET accepted = true,
    accepted_at = (SELECT u.created_at FROM users u WHERE u.auth_user_id = '7ffc350a-acad-4674-8f40-7e557999cd82'),
    updated_at = now()
FROM auth.users au
WHERE si.email = au.email
  AND au.id = '7ffc350a-acad-4674-8f40-7e557999cd82'
  AND si.facility_id = 'b851c4ea-3760-4653-97c2-7d935622b036'
  AND si.accepted = false;