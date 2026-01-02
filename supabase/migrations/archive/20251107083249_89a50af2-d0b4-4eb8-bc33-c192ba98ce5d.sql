-- Fix the notify_patient_lab_result trigger to include tenant_id
CREATE OR REPLACE FUNCTION public.notify_patient_lab_result()
 RETURNS trigger
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
DECLARE
  v_tenant_id uuid;
BEGIN
  IF (NEW.status = 'completed' OR NEW.result IS NOT NULL) AND 
     (OLD.status IS DISTINCT FROM NEW.status OR OLD.result IS DISTINCT FROM NEW.result) THEN
    
    -- Get tenant_id from the lab order
    v_tenant_id := NEW.tenant_id;
    
    INSERT INTO public.patient_notifications (
      tenant_id,
      patient_id,
      visit_id,
      notification_type,
      title,
      message,
      priority
    )
    VALUES (
      v_tenant_id,
      NEW.patient_id,
      NEW.visit_id,
      'result_ready',
      'Lab Results Ready',
      'Your lab test results for ' || NEW.test_name || ' are now available. Please return to your doctor for review.',
      CASE WHEN NEW.urgency = 'STAT' THEN 'urgent' ELSE 'high' END
    );
  END IF;
  
  RETURN NEW;
END;
$function$;

-- Also fix the imaging notification trigger
CREATE OR REPLACE FUNCTION public.notify_patient_imaging_result()
 RETURNS trigger
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
DECLARE
  v_tenant_id uuid;
BEGIN
  IF (NEW.status = 'completed' OR NEW.result IS NOT NULL) AND 
     (OLD.status IS DISTINCT FROM NEW.status OR OLD.result IS DISTINCT FROM NEW.result) THEN
    
    -- Get tenant_id from the imaging order
    v_tenant_id := NEW.tenant_id;
    
    INSERT INTO public.patient_notifications (
      tenant_id,
      patient_id,
      visit_id,
      notification_type,
      title,
      message,
      priority
    )
    VALUES (
      v_tenant_id,
      NEW.patient_id,
      NEW.visit_id,
      'result_ready',
      'Imaging Results Ready',
      'Your imaging results for ' || NEW.study_name || ' are now available. Please return to your doctor for review.',
      CASE WHEN NEW.urgency = 'urgent' THEN 'urgent' ELSE 'high' END
    );
  END IF;
  
  RETURN NEW;
END;
$function$;