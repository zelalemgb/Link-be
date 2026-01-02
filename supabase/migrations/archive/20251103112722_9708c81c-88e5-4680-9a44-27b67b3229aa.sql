-- Fix search_path for notification functions
CREATE OR REPLACE FUNCTION notify_patient_lab_result()
RETURNS TRIGGER 
LANGUAGE plpgsql 
SECURITY DEFINER
SET search_path = public
AS $$
BEGIN
  IF (NEW.status = 'completed' OR NEW.result IS NOT NULL) AND 
     (OLD.status IS DISTINCT FROM NEW.status OR OLD.result IS DISTINCT FROM NEW.result) THEN
    
    INSERT INTO public.patient_notifications (
      patient_id,
      visit_id,
      notification_type,
      title,
      message,
      priority
    )
    VALUES (
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
$$;

CREATE OR REPLACE FUNCTION notify_patient_imaging_result()
RETURNS TRIGGER
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
BEGIN
  IF (NEW.status = 'completed' OR NEW.result IS NOT NULL) AND 
     (OLD.status IS DISTINCT FROM NEW.status OR OLD.result IS DISTINCT FROM NEW.result) THEN
    
    INSERT INTO public.patient_notifications (
      patient_id,
      visit_id,
      notification_type,
      title,
      message,
      priority
    )
    VALUES (
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
$$;