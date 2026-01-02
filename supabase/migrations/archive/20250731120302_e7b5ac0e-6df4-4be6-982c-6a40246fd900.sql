-- Remove the placeholder super admin record
DELETE FROM public.users WHERE id = 'a0000000-0000-0000-0000-000000000001';

-- Create a function to promote a user to super admin
CREATE OR REPLACE FUNCTION public.promote_to_super_admin(user_phone text)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER SET search_path = ''
AS $$
DECLARE
  target_user_id uuid;
  result jsonb;
BEGIN
  -- Find the user by phone number
  SELECT auth_user_id INTO target_user_id
  FROM public.users
  WHERE phone_number = user_phone
  LIMIT 1;

  IF target_user_id IS NULL THEN
    RETURN jsonb_build_object('success', false, 'error', 'User not found with phone: ' || user_phone);
  END IF;

  -- Update user role to super_admin
  UPDATE public.users
  SET user_role = 'super_admin',
      updated_at = now()
  WHERE auth_user_id = target_user_id;

  RETURN jsonb_build_object(
    'success', true,
    'message', 'User promoted to super admin successfully',
    'user_id', target_user_id
  );
END;
$$;