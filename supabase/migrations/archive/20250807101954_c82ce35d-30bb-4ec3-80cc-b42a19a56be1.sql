-- FIX REMAINING FUNCTIONS WITH SECURITY DEFINER SEARCH PATH
-- This addresses the remaining function security warnings

-- Fix all remaining functions that need secure search_path

-- Fix calculate_reputation_score function
CREATE OR REPLACE FUNCTION public.calculate_reputation_score(p_provider_id uuid)
RETURNS integer
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path TO 'public'
AS $function$
DECLARE
  total_score INTEGER := 0;
  questions_answered INTEGER := 0;
  posts_created INTEGER := 0;
  likes_received INTEGER := 0;
  flagged_posts INTEGER := 0;
BEGIN
  -- Count questions answered (+10 each)
  SELECT COUNT(*) INTO questions_answered
  FROM public.feed_posts fp
  WHERE fp.user_id = p_provider_id
    AND fp.type = 'answer'
    AND fp.parent_post_id IS NOT NULL
    AND fp.is_deleted = false;
  
  -- Count posts created (+5 each, min 50 chars)
  SELECT COUNT(*) INTO posts_created
  FROM public.feed_posts fp
  WHERE fp.user_id = p_provider_id
    AND fp.type IN ('tip', 'announcement')
    AND LENGTH(fp.body) >= 50
    AND fp.is_deleted = false;
  
  -- Count likes received (+1 each)
  SELECT COUNT(*) INTO likes_received
  FROM public.post_likes pl
  JOIN public.feed_posts fp ON pl.post_id = fp.id
  WHERE fp.user_id = p_provider_id
    AND fp.is_deleted = false;
  
  -- Count flagged posts (-10 each)
  SELECT COUNT(*) INTO flagged_posts
  FROM public.feed_posts fp
  WHERE fp.user_id = p_provider_id
    AND fp.is_flagged = true;
  
  -- Calculate total score
  total_score := (questions_answered * 10) + (posts_created * 5) + likes_received - (flagged_posts * 10);
  
  -- Ensure score is not negative
  total_score := GREATEST(total_score, 0);
  
  -- Update reputation table
  INSERT INTO public.provider_reputation (
    provider_id, score, questions_answered, posts_created, likes_received, last_updated
  )
  VALUES (
    p_provider_id, total_score, questions_answered, posts_created, likes_received, now()
  )
  ON CONFLICT (provider_id) DO UPDATE SET
    score = EXCLUDED.score,
    questions_answered = EXCLUDED.questions_answered,
    posts_created = EXCLUDED.posts_created,
    likes_received = EXCLUDED.likes_received,
    last_updated = now();
  
  RETURN total_score;
END;
$function$;

-- Fix update_provider_badge function
CREATE OR REPLACE FUNCTION public.update_provider_badge(p_provider_id uuid)
RETURNS text
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path TO 'public'
AS $function$
DECLARE
  current_score INTEGER;
  current_questions INTEGER;
  new_badge TEXT;
  current_badge TEXT;
BEGIN
  -- Get current reputation data
  SELECT score, questions_answered INTO current_score, current_questions
  FROM public.provider_reputation
  WHERE provider_id = p_provider_id;
  
  -- Get current badge
  SELECT role_badge INTO current_badge
  FROM public.users
  WHERE id = p_provider_id;
  
  -- Determine new badge based on criteria
  IF current_score >= 500 AND current_questions >= 20 THEN
    new_badge := 'trusted_expert';
  ELSIF current_score >= 100 AND current_questions >= 5 THEN
    new_badge := 'bookable';
  ELSE
    new_badge := 'verified';
  END IF;
  
  -- Update badge if changed
  IF new_badge != current_badge THEN
    UPDATE public.users
    SET role_badge = new_badge
    WHERE id = p_provider_id;
    
    -- Add to badges_awarded array
    UPDATE public.provider_reputation
    SET badges_awarded = array_append(badges_awarded, new_badge)
    WHERE provider_id = p_provider_id;
  END IF;
  
  RETURN new_badge;
END;
$function$;

-- Fix update_reputation_after_post function
CREATE OR REPLACE FUNCTION public.update_reputation_after_post()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path TO 'public'
AS $function$
BEGIN
  -- Only update for provider roles
  IF EXISTS (
    SELECT 1 FROM public.users 
    WHERE id = NEW.user_id AND role = 'provider'
  ) THEN
    -- Recalculate reputation score
    PERFORM public.calculate_reputation_score(NEW.user_id);
    
    -- Update badge if necessary
    PERFORM public.update_provider_badge(NEW.user_id);
  END IF;
  
  RETURN NEW;
END;
$function$;

-- Fix update_reputation_after_like function
CREATE OR REPLACE FUNCTION public.update_reputation_after_like()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path TO 'public'
AS $function$
DECLARE
  post_owner_id UUID;
BEGIN
  -- Get the post owner
  SELECT user_id INTO post_owner_id
  FROM public.feed_posts
  WHERE id = NEW.post_id;
  
  -- Only update for provider roles
  IF EXISTS (
    SELECT 1 FROM public.users 
    WHERE id = post_owner_id AND role = 'provider'
  ) THEN
    -- Recalculate reputation score
    PERFORM public.calculate_reputation_score(post_owner_id);
    
    -- Update badge if necessary
    PERFORM public.update_provider_badge(post_owner_id);
  END IF;
  
  RETURN NEW;
END;
$function$;

-- Fix get_feed_posts_with_likes function
CREATE OR REPLACE FUNCTION public.get_feed_posts_with_likes(p_limit integer DEFAULT 20, p_offset integer DEFAULT 0, p_type text DEFAULT NULL::text, p_region text DEFAULT NULL::text)
RETURNS TABLE(id uuid, user_id uuid, role text, type text, parent_post_id uuid, title text, body text, region text, tags text[], is_anonymous boolean, is_flagged boolean, created_at timestamp with time zone, like_count bigint, user_liked boolean, author_name text, reply_count bigint, author_badge text, author_reputation_score integer)
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path TO 'public'
AS $function$
BEGIN
  RETURN QUERY
  SELECT 
    fp.id,
    fp.user_id,
    fp.role,
    fp.type,
    fp.parent_post_id,
    fp.title,
    fp.body,
    fp.region,
    fp.tags,
    fp.is_anonymous,
    fp.is_flagged,
    fp.created_at,
    COALESCE(like_counts.like_count, 0) as like_count,
    CASE 
      WHEN auth.uid() IS NOT NULL AND user_likes.post_id IS NOT NULL 
      THEN true 
      ELSE false 
    END as user_liked,
    CASE 
      WHEN fp.is_anonymous = true 
      THEN 'Anonymous' 
      ELSE COALESCE(u.name, 'Unknown User') 
    END as author_name,
    COALESCE(reply_counts.reply_count, 0) as reply_count,
    COALESCE(u.role_badge, 'verified') as author_badge,
    COALESCE(pr.score, 0) as author_reputation_score
  FROM feed_posts fp
  LEFT JOIN users u ON fp.user_id = u.id
  LEFT JOIN provider_reputation pr ON fp.user_id = pr.provider_id
  LEFT JOIN (
    SELECT 
      pl.post_id,
      COUNT(*) as like_count
    FROM post_likes pl
    GROUP BY pl.post_id
  ) like_counts ON fp.id = like_counts.post_id
  LEFT JOIN (
    SELECT 
      pl.post_id
    FROM post_likes pl
    WHERE pl.user_id = auth.uid()
  ) user_likes ON fp.id = user_likes.post_id
  LEFT JOIN (
    SELECT 
      fp_replies.parent_post_id,
      COUNT(*) as reply_count
    FROM feed_posts fp_replies
    WHERE fp_replies.parent_post_id IS NOT NULL
    GROUP BY fp_replies.parent_post_id
  ) reply_counts ON fp.id = reply_counts.parent_post_id
  WHERE 
    fp.is_deleted = false
    AND (p_type IS NULL OR fp.type = p_type)
    AND (p_region IS NULL OR fp.region = p_region)
  ORDER BY fp.created_at DESC
  LIMIT p_limit
  OFFSET p_offset;
END;
$function$;

-- Fix get_reminder_stats function
CREATE OR REPLACE FUNCTION public.get_reminder_stats(p_challenge_id uuid DEFAULT NULL::uuid, p_days_back integer DEFAULT 30)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path TO 'public'
AS $function$
DECLARE
  stats JSONB;
BEGIN
  SELECT jsonb_build_object(
    'total_scheduled', (
      SELECT COUNT(*) FROM public.reminders_log 
      WHERE (p_challenge_id IS NULL OR challenge_id = p_challenge_id)
        AND created_at >= now() - (p_days_back || ' days')::INTERVAL
    ),
    'total_sent', (
      SELECT COUNT(*) FROM public.reminders_log 
      WHERE status = 'sent'
        AND (p_challenge_id IS NULL OR challenge_id = p_challenge_id)
        AND created_at >= now() - (p_days_back || ' days')::INTERVAL
    ),
    'total_cancelled', (
      SELECT COUNT(*) FROM public.reminders_log 
      WHERE status = 'cancelled'
        AND (p_challenge_id IS NULL OR challenge_id = p_challenge_id)
        AND created_at >= now() - (p_days_back || ' days')::INTERVAL
    ),
    'total_failed', (
      SELECT COUNT(*) FROM public.reminders_log 
      WHERE status = 'failed'
        AND (p_challenge_id IS NULL OR challenge_id = p_challenge_id)
        AND created_at >= now() - (p_days_back || ' days')::INTERVAL
    ),
    'sms_sent', (
      SELECT COUNT(*) FROM public.reminders_log 
      WHERE channel = 'sms' AND status = 'sent'
        AND (p_challenge_id IS NULL OR challenge_id = p_challenge_id)
        AND created_at >= now() - (p_days_back || ' days')::INTERVAL
    ),
    'local_sent', (
      SELECT COUNT(*) FROM public.reminders_log 
      WHERE channel = 'local' AND status = 'sent'
        AND (p_challenge_id IS NULL OR challenge_id = p_challenge_id)
        AND created_at >= now() - (p_days_back || ' days')::INTERVAL
    ),
    'completion_rate', (
      SELECT ROUND(
        CASE 
          WHEN COUNT(*) = 0 THEN 0 
          ELSE (
            SELECT COUNT(*) FROM public.user_challenges uc
            WHERE uc.status = 'completed' 
              AND (p_challenge_id IS NULL OR uc.challenge_id = p_challenge_id)
              AND EXISTS (
                SELECT 1 FROM public.reminders_log rl 
                WHERE rl.user_id = uc.user_id 
                  AND rl.challenge_id = uc.challenge_id
                  AND rl.status = 'sent'
              )
          ) * 100.0 / COUNT(*)
        END, 2
      ) FROM public.reminders_log 
      WHERE status = 'sent'
        AND (p_challenge_id IS NULL OR challenge_id = p_challenge_id)
        AND created_at >= now() - (p_days_back || ' days')::INTERVAL
    )
  ) INTO stats;
  
  RETURN stats;
END;
$function$;

-- Fix mark_reminder_sent function
CREATE OR REPLACE FUNCTION public.mark_reminder_sent(p_reminder_id uuid, p_success boolean DEFAULT true, p_error_message text DEFAULT NULL::text)
RETURNS boolean
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path TO 'public'
AS $function$
BEGIN
  IF p_success THEN
    UPDATE public.reminders_log 
    SET 
      status = 'sent',
      sent_at = now()
    WHERE id = p_reminder_id;
  ELSE
    UPDATE public.reminders_log 
    SET 
      status = 'failed',
      error_message = p_error_message
    WHERE id = p_reminder_id;
  END IF;
  
  RETURN FOUND;
END;
$function$;

-- Fix generate_voucher_code function
CREATE OR REPLACE FUNCTION public.generate_voucher_code()
RETURNS text
LANGUAGE plpgsql
SET search_path TO 'public'
AS $function$
DECLARE
  code TEXT;
  exists_check BOOLEAN;
BEGIN
  LOOP
    -- Generate 8-character alphanumeric code
    code := upper(substr(encode(gen_random_bytes(6), 'base64'), 1, 8));
    code := replace(replace(replace(code, '+', ''), '/', ''), '=', '');
    
    -- Check if code already exists
    SELECT EXISTS(SELECT 1 FROM public.vouchers WHERE voucher_code = code) INTO exists_check;
    
    -- Exit loop if code is unique
    EXIT WHEN NOT exists_check;
  END LOOP;
  
  RETURN code;
END;
$function$;

-- Fix expire_old_vouchers function
CREATE OR REPLACE FUNCTION public.expire_old_vouchers()
RETURNS void
LANGUAGE plpgsql
SET search_path TO 'public'
AS $function$
BEGIN
  UPDATE public.vouchers 
  SET status = 'expired'
  WHERE status = 'active' 
  AND expires_at < now();
END;
$function$;

-- Fix auto_generate_voucher_code function
CREATE OR REPLACE FUNCTION public.auto_generate_voucher_code()
RETURNS trigger
LANGUAGE plpgsql
SET search_path TO 'public'
AS $function$
BEGIN
  IF NEW.voucher_code IS NULL OR NEW.voucher_code = '' THEN
    NEW.voucher_code := generate_voucher_code();
  END IF;
  RETURN NEW;
END;
$function$;