-- FINAL BATCH OF FUNCTION SECURITY FIXES
-- Complete the remaining function security warnings

-- Fix redeem_voucher function
CREATE OR REPLACE FUNCTION public.redeem_voucher(voucher_code_input text)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path TO 'public'
AS $function$
DECLARE
  voucher_record public.vouchers%ROWTYPE;
  facility_id_val UUID;
  result JSONB;
BEGIN
  -- Get the provider's facility
  SELECT id INTO facility_id_val FROM public.facilities WHERE admin_user_id = auth.uid();
  
  IF facility_id_val IS NULL THEN
    RETURN jsonb_build_object('success', false, 'error', 'No facility found for user');
  END IF;
  
  -- Get the voucher
  SELECT * INTO voucher_record FROM public.vouchers 
  WHERE voucher_code = voucher_code_input;
  
  IF NOT FOUND THEN
    RETURN jsonb_build_object('success', false, 'error', 'Voucher not found');
  END IF;
  
  -- Check if already redeemed
  IF voucher_record.status = 'used' THEN
    RETURN jsonb_build_object('success', false, 'error', 'Voucher already redeemed');
  END IF;
  
  -- Check if expired
  IF voucher_record.expires_at < now() THEN
    RETURN jsonb_build_object('success', false, 'error', 'Voucher has expired');
  END IF;
  
  -- Check if active
  IF voucher_record.status != 'active' THEN
    RETURN jsonb_build_object('success', false, 'error', 'Voucher is not active');
  END IF;
  
  -- Redeem the voucher
  UPDATE public.vouchers 
  SET 
    status = 'used',
    facility_id = facility_id_val,
    redeemed_at = now(),
    facility_redeemed = (SELECT name FROM public.facilities WHERE id = facility_id_val)
  WHERE voucher_code = voucher_code_input;
  
  -- Return success with voucher details
  RETURN jsonb_build_object(
    'success', true,
    'voucher', jsonb_build_object(
      'id', voucher_record.id,
      'phone_number', left(voucher_record.phone_number, 3) || '****' || right(voucher_record.phone_number, 2),
      'amount', voucher_record.amount,
      'currency', voucher_record.currency,
      'services_included', voucher_record.services_included,
      'redeemed_at', now()
    )
  );
END;
$function$;

-- Fix mark_vouchers_as_paid function
CREATE OR REPLACE FUNCTION public.mark_vouchers_as_paid(voucher_ids uuid[], payment_method_input text DEFAULT 'bank_transfer'::text)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path TO 'public'
AS $function$
DECLARE
  updated_count INTEGER;
  batch_id TEXT;
BEGIN
  -- Check if user is admin
  IF NOT has_role('admin'::app_role) THEN
    RETURN jsonb_build_object('success', false, 'error', 'Unauthorized: Admin access required');
  END IF;
  
  -- Generate batch ID
  batch_id := 'batch_' || to_char(now(), 'YYYYMMDD_HHMISS') || '_' || substr(md5(random()::text), 1, 8);
  
  -- Update vouchers
  UPDATE public.vouchers 
  SET 
    payout_status = 'paid',
    payout_date = now(),
    payout_batch_id = batch_id,
    payment_method = payment_method_input
  WHERE id = ANY(voucher_ids)
    AND status = 'used'
    AND payout_status = 'unpaid';
  
  GET DIAGNOSTICS updated_count = ROW_COUNT;
  
  RETURN jsonb_build_object(
    'success', true,
    'updated_count', updated_count,
    'batch_id', batch_id
  );
END;
$function$;

-- Fix get_payout_stats function
CREATE OR REPLACE FUNCTION public.get_payout_stats()
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path TO 'public'
AS $function$
DECLARE
  stats JSONB;
BEGIN
  -- Check if user is admin
  IF NOT has_role('admin'::app_role) THEN
    RETURN jsonb_build_object('error', 'Unauthorized');
  END IF;
  
  SELECT jsonb_build_object(
    'total_unpaid_vouchers', (
      SELECT COUNT(*) FROM public.vouchers 
      WHERE status = 'used' AND payout_status = 'unpaid'
    ),
    'total_unpaid_amount', (
      SELECT COALESCE(SUM(amount), 0) FROM public.vouchers 
      WHERE status = 'used' AND payout_status = 'unpaid'
    ),
    'total_paid_vouchers', (
      SELECT COUNT(*) FROM public.vouchers 
      WHERE status = 'used' AND payout_status = 'paid'
    ),
    'total_paid_amount', (
      SELECT COALESCE(SUM(amount), 0) FROM public.vouchers 
      WHERE status = 'used' AND payout_status = 'paid'
    ),
    'facilities_with_unpaid', (
      SELECT COUNT(DISTINCT facility_id) FROM public.vouchers 
      WHERE status = 'used' AND payout_status = 'unpaid' AND facility_id IS NOT NULL
    )
  ) INTO stats;
  
  RETURN stats;
END;
$function$;

-- Fix update_challenge_stats function
CREATE OR REPLACE FUNCTION public.update_challenge_stats()
RETURNS trigger
LANGUAGE plpgsql
SET search_path TO 'public'
AS $function$
BEGIN
  IF TG_OP = 'INSERT' AND NEW.verified = true THEN
    UPDATE public.challenges 
    SET current_redemptions = current_redemptions + 1
    WHERE id = NEW.challenge_id;
    
    UPDATE public.sponsors 
    SET total_spent = total_spent + (
      SELECT unit_cost FROM public.challenges WHERE id = NEW.challenge_id
    )
    WHERE id = (
      SELECT sponsor_id FROM public.challenges WHERE id = NEW.challenge_id
    );
  END IF;
  
  RETURN NEW;
END;
$function$;

-- Fix get_sponsor_dashboard_stats function
CREATE OR REPLACE FUNCTION public.get_sponsor_dashboard_stats(sponsor_uuid uuid)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path TO 'public'
AS $function$
DECLARE
  stats JSONB;
BEGIN
  SELECT jsonb_build_object(
    'total_challenges', (
      SELECT COUNT(*) FROM public.challenges WHERE sponsor_id = sponsor_uuid
    ),
    'active_challenges', (
      SELECT COUNT(*) FROM public.challenges 
      WHERE sponsor_id = sponsor_uuid AND visible = true 
      AND start_date <= CURRENT_DATE AND end_date >= CURRENT_DATE
    ),
    'total_completions', (
      SELECT COUNT(*) FROM public.user_challenges uc
      JOIN public.challenges c ON uc.challenge_id = c.id
      WHERE c.sponsor_id = sponsor_uuid AND uc.verified = true
    ),
    'total_budget_used', (
      SELECT COALESCE(total_spent, 0) FROM public.sponsors WHERE id = sponsor_uuid
    ),
    'total_budget_pledged', (
      SELECT COALESCE(total_pledged, 0) FROM public.sponsors WHERE id = sponsor_uuid
    )
  ) INTO stats;
  
  RETURN stats;
END;
$function$;

-- Fix check_challenge_eligibility function
CREATE OR REPLACE FUNCTION public.check_challenge_eligibility(challenge_uuid uuid, user_phone text DEFAULT NULL::text, user_age integer DEFAULT NULL::integer, user_gender text DEFAULT NULL::text, user_location text DEFAULT NULL::text)
RETURNS boolean
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path TO 'public'
AS $function$
DECLARE
  challenge_record public.challenges%ROWTYPE;
  target_criteria JSONB;
  is_eligible BOOLEAN := TRUE;
BEGIN
  -- Get challenge details
  SELECT * INTO challenge_record FROM public.challenges WHERE id = challenge_uuid;
  
  IF NOT FOUND THEN
    RETURN FALSE;
  END IF;
  
  -- Check if challenge is active and visible
  IF NOT challenge_record.visible 
     OR challenge_record.start_date > CURRENT_DATE 
     OR challenge_record.end_date < CURRENT_DATE THEN
    RETURN FALSE;
  END IF;
  
  -- Check if user already participated
  IF user_phone IS NOT NULL THEN
    IF EXISTS (
      SELECT 1 FROM public.user_challenges 
      WHERE challenge_id = challenge_uuid 
      AND phone_number = user_phone
    ) THEN
      RETURN FALSE;
    END IF;
  END IF;
  
  -- Check target group criteria
  target_criteria := challenge_record.target_group;
  
  IF target_criteria IS NOT NULL THEN
    -- Check age criteria
    IF target_criteria ? 'age_min' AND user_age IS NOT NULL THEN
      IF user_age < (target_criteria->>'age_min')::INT THEN
        is_eligible := FALSE;
      END IF;
    END IF;
    
    IF target_criteria ? 'age_max' AND user_age IS NOT NULL THEN
      IF user_age > (target_criteria->>'age_max')::INT THEN
        is_eligible := FALSE;
      END IF;
    END IF;
    
    -- Check gender criteria
    IF target_criteria ? 'gender' AND user_gender IS NOT NULL THEN
      IF target_criteria->>'gender' != 'all' 
         AND target_criteria->>'gender' != user_gender THEN
        is_eligible := FALSE;
      END IF;
    END IF;
    
    -- Check location criteria (simplified)
    IF target_criteria ? 'location' AND user_location IS NOT NULL THEN
      IF NOT (target_criteria->'location' @> to_jsonb(ARRAY[user_location])) THEN
        is_eligible := FALSE;
      END IF;
    END IF;
  END IF;
  
  RETURN is_eligible;
END;
$function$;

-- Fix process_challenge_payouts function
CREATE OR REPLACE FUNCTION public.process_challenge_payouts(challenge_ids uuid[], payout_batch_id text DEFAULT NULL::text)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path TO 'public'
AS $function$
DECLARE
  updated_count INTEGER;
  batch_id TEXT;
  total_amount NUMERIC := 0;
BEGIN
  -- Check if user is admin
  IF NOT has_role('admin'::app_role) THEN
    RETURN jsonb_build_object('success', false, 'error', 'Unauthorized: Admin access required');
  END IF;
  
  -- Generate batch ID if not provided
  IF payout_batch_id IS NULL THEN
    batch_id := 'challenge_batch_' || to_char(now(), 'YYYYMMDD_HHMISS') || '_' || substr(md5(random()::text), 1, 8);
  ELSE
    batch_id := payout_batch_id;
  END IF;
  
  -- Calculate total amount
  SELECT COALESCE(SUM(c.unit_cost), 0) INTO total_amount
  FROM public.user_challenges uc
  JOIN public.challenges c ON uc.challenge_id = c.id
  WHERE uc.challenge_id = ANY(challenge_ids)
    AND uc.status = 'completed'
    AND uc.verified_by IS NOT NULL
    AND uc.payout_status = 'unpaid';
  
  -- Update challenge completions
  UPDATE public.user_challenges 
  SET 
    payout_status = 'paid',
    payout_date = now()
  WHERE challenge_id = ANY(challenge_ids)
    AND status = 'completed'
    AND verified_by IS NOT NULL
    AND payout_status = 'unpaid';
  
  GET DIAGNOSTICS updated_count = ROW_COUNT;
  
  RETURN jsonb_build_object(
    'success', true,
    'updated_count', updated_count,
    'batch_id', batch_id,
    'total_amount', total_amount
  );
END;
$function$;

-- Fix schedule_challenge_reminder function
CREATE OR REPLACE FUNCTION public.schedule_challenge_reminder(p_user_id uuid, p_challenge_id uuid, p_phone_number text DEFAULT NULL::text, p_reminder_type text DEFAULT 'eligibility'::text)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path TO 'public'
AS $function$
DECLARE
  settings_record public.reminder_settings%ROWTYPE;
  challenge_record public.challenges%ROWTYPE;
  existing_reminders INTEGER;
  local_scheduled_time TIMESTAMP WITH TIME ZONE;
  sms_scheduled_time TIMESTAMP WITH TIME ZONE;
  result JSONB;
BEGIN
  -- Get challenge details
  SELECT * INTO challenge_record FROM public.challenges WHERE id = p_challenge_id;
  
  IF NOT FOUND THEN
    RETURN jsonb_build_object('success', false, 'error', 'Challenge not found');
  END IF;
  
  -- Get reminder settings for this challenge
  SELECT * INTO settings_record FROM public.reminder_settings WHERE challenge_id = p_challenge_id;
  
  -- Use default settings if none configured
  IF NOT FOUND THEN
    INSERT INTO public.reminder_settings (challenge_id) VALUES (p_challenge_id)
    RETURNING * INTO settings_record;
  END IF;
  
  -- Check if reminders are enabled
  IF NOT settings_record.enabled THEN
    RETURN jsonb_build_object('success', true, 'message', 'Reminders disabled for this challenge');
  END IF;
  
  -- Count existing reminders for this user/challenge combo
  SELECT COUNT(*) INTO existing_reminders
  FROM public.reminders_log
  WHERE user_id = p_user_id 
    AND challenge_id = p_challenge_id 
    AND status IN ('scheduled', 'sent');
  
  -- Check if max reminders reached
  IF existing_reminders >= settings_record.max_reminders_per_user THEN
    RETURN jsonb_build_object('success', false, 'error', 'Max reminders reached for this user');
  END IF;
  
  result := jsonb_build_object('success', true, 'reminders_scheduled', jsonb_build_array());
  
  -- Schedule local notification (for all users)
  local_scheduled_time := now() + (settings_record.local_reminder_delay_hours || ' hours')::INTERVAL;
  
  INSERT INTO public.reminders_log (
    user_id, challenge_id, phone_number, channel, reminder_type, 
    message_content, scheduled_for, status
  ) VALUES (
    p_user_id, p_challenge_id, p_phone_number, 'local', p_reminder_type,
    replace(settings_record.local_template, '{challenge_name}', challenge_record.title),
    local_scheduled_time, 'scheduled'
  );
  
  result := jsonb_set(
    result, 
    '{reminders_scheduled}', 
    (result->'reminders_scheduled') || jsonb_build_object('local', local_scheduled_time)
  );
  
  -- Schedule SMS reminder (only for phone-verified users)
  IF p_phone_number IS NOT NULL AND length(p_phone_number) > 0 THEN
    sms_scheduled_time := now() + (settings_record.sms_reminder_delay_days || ' days')::INTERVAL;
    
    INSERT INTO public.reminders_log (
      user_id, challenge_id, phone_number, channel, reminder_type,
      message_content, scheduled_for, status
    ) VALUES (
      p_user_id, p_challenge_id, p_phone_number, 'sms', p_reminder_type,
      replace(replace(settings_record.sms_template, '{challenge_name}', challenge_record.title), 
              '{link}', 'https://your-app.com/challenges/' || p_challenge_id),
      sms_scheduled_time, 'scheduled'
    );
    
    result := jsonb_set(
      result, 
      '{reminders_scheduled}', 
      (result->'reminders_scheduled') || jsonb_build_object('sms', sms_scheduled_time)
    );
  END IF;
  
  RETURN result;
END;
$function$;

-- Fix cancel_challenge_reminders function
CREATE OR REPLACE FUNCTION public.cancel_challenge_reminders(p_user_id uuid, p_challenge_id uuid)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path TO 'public'
AS $function$
DECLARE
  cancelled_count INTEGER;
BEGIN
  UPDATE public.reminders_log 
  SET 
    status = 'cancelled',
    cancelled_at = now()
  WHERE user_id = p_user_id 
    AND challenge_id = p_challenge_id 
    AND status = 'scheduled';
  
  GET DIAGNOSTICS cancelled_count = ROW_COUNT;
  
  RETURN jsonb_build_object(
    'success', true,
    'cancelled_count', cancelled_count
  );
END;
$function$;

-- Fix get_pending_reminders function
CREATE OR REPLACE FUNCTION public.get_pending_reminders(p_channel text DEFAULT NULL::text, p_limit integer DEFAULT 100)
RETURNS TABLE(id uuid, user_id uuid, challenge_id uuid, phone_number text, channel text, message_content text, scheduled_for timestamp with time zone)
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path TO 'public'
AS $function$
BEGIN
  RETURN QUERY
  SELECT 
    rl.id, rl.user_id, rl.challenge_id, rl.phone_number, 
    rl.channel, rl.message_content, rl.scheduled_for
  FROM public.reminders_log rl
  WHERE rl.status = 'scheduled'
    AND rl.scheduled_for <= now()
    AND (p_channel IS NULL OR rl.channel = p_channel)
  ORDER BY rl.scheduled_for ASC
  LIMIT p_limit;
END;
$function$;

-- Fix check_reward_eligibility function
CREATE OR REPLACE FUNCTION public.check_reward_eligibility(p_user_id uuid)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path TO 'public'
AS $function$
DECLARE
  completed_challenges INTEGER;
  existing_claims INTEGER;
  result JSONB;
  twelve_months_ago TIMESTAMP WITH TIME ZONE;
BEGIN
  twelve_months_ago := now() - INTERVAL '12 months';
  
  -- Count completed and verified challenges in the last 12 months
  SELECT COUNT(*) INTO completed_challenges
  FROM public.user_challenges
  WHERE user_id = p_user_id
    AND status = 'completed'
    AND verified = true
    AND completed_at >= twelve_months_ago;
  
  -- Count existing reward claims in the last 12 months
  SELECT COUNT(*) INTO existing_claims
  FROM public.rewards_claimed
  WHERE user_id = p_user_id
    AND claimed_at >= twelve_months_ago;
  
  -- Check if user is eligible (2+ challenges, no existing claims)
  result := jsonb_build_object(
    'eligible', (completed_challenges >= 2 AND existing_claims = 0),
    'completed_challenges', completed_challenges,
    'existing_claims', existing_claims,
    'challenges_needed', GREATEST(0, 2 - completed_challenges)
  );
  
  RETURN result;
END;
$function$;

-- Fix auto_assign_reward function
CREATE OR REPLACE FUNCTION public.auto_assign_reward(p_user_id uuid)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path TO 'public'
AS $function$
DECLARE
  available_reward public.reward_pool%ROWTYPE;
  eligibility_check JSONB;
  result JSONB;
BEGIN
  -- Check eligibility first
  eligibility_check := public.check_reward_eligibility(p_user_id);
  
  IF NOT (eligibility_check->>'eligible')::BOOLEAN THEN
    RETURN jsonb_build_object(
      'success', false,
      'error', 'User not eligible for reward',
      'eligibility', eligibility_check
    );
  END IF;
  
  -- Find an available reward
  SELECT * INTO available_reward 
  FROM public.reward_pool 
  WHERE claimed = FALSE 
    AND claimed_by IS NULL
  ORDER BY created_at ASC
  LIMIT 1;
  
  -- If no reward available
  IF available_reward.id IS NULL THEN
    RETURN jsonb_build_object(
      'success', false,
      'error', 'No rewards available in pool'
    );
  END IF;
  
  -- Claim the reward
  UPDATE public.reward_pool 
  SET 
    claimed = TRUE,
    claimed_by = p_user_id,
    claimed_at = now()
  WHERE id = available_reward.id;
  
  -- Record in rewards_claimed table
  INSERT INTO public.rewards_claimed (
    user_id, reward_id, sponsor_id, delivery_method
  ) VALUES (
    p_user_id, available_reward.id, available_reward.sponsor_id, 'in_app'
  );
  
  -- Return success with reward details
  RETURN jsonb_build_object(
    'success', true,
    'reward', jsonb_build_object(
      'id', available_reward.id,
      'code', available_reward.code,
      'value', available_reward.value,
      'reward_type', available_reward.reward_type,
      'sponsor_id', available_reward.sponsor_id
    )
  );
END;
$function$;

-- Fix auto_assign_reward trigger function
CREATE OR REPLACE FUNCTION public.auto_assign_reward()
RETURNS trigger
LANGUAGE plpgsql
SET search_path TO 'public'
AS $function$
DECLARE
  eligibility_result JSONB;
  reward_result JSONB;
BEGIN
  -- Only process when status changes to 'completed' and is verified
  IF NEW.status = 'completed' AND NEW.verified = true AND 
     (OLD.status != 'completed' OR OLD.verified != true) THEN
    
    -- Check if user is eligible for a reward
    eligibility_result := public.check_reward_eligibility(NEW.user_id);
    
    -- If eligible, auto-assign reward
    IF (eligibility_result->>'eligible')::BOOLEAN THEN
      reward_result := public.auto_assign_reward(NEW.user_id);
      
      -- Log the result (you can extend this for notifications)
      IF (reward_result->>'success')::BOOLEAN THEN
        -- Update challenge with reward reference
        NEW.proof_url := COALESCE(NEW.proof_url, 'auto_reward_assigned');
      END IF;
    END IF;
  END IF;
  
  RETURN NEW;
END;
$function$;

-- Fix get_user_rewards function
CREATE OR REPLACE FUNCTION public.get_user_rewards(p_user_id uuid)
RETURNS TABLE(id uuid, reward_code text, reward_value numeric, reward_type text, sponsor_name text, claimed_at timestamp with time zone, delivery_method text)
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path TO 'public'
AS $function$
BEGIN
  RETURN QUERY
  SELECT 
    rc.id,
    rp.code as reward_code,
    rp.value as reward_value,
    rp.reward_type,
    s.name as sponsor_name,
    rc.claimed_at,
    rc.delivery_method
  FROM public.rewards_claimed rc
  JOIN public.reward_pool rp ON rc.reward_id = rp.id
  JOIN public.sponsors s ON rc.sponsor_id = s.id
  WHERE rc.user_id = p_user_id
  ORDER BY rc.claimed_at DESC;
END;
$function$;

-- Fix update_updated_at_column function (this is a trigger function)
CREATE OR REPLACE FUNCTION public.update_updated_at_column()
RETURNS trigger
LANGUAGE plpgsql
SET search_path TO 'public'
AS $function$
BEGIN
  NEW.updated_at = now();
  RETURN NEW;
END;
$function$;