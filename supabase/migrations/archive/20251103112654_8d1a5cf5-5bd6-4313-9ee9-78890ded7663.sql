-- Create notifications table for patient alerts
CREATE TABLE IF NOT EXISTS public.patient_notifications (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  patient_id UUID NOT NULL REFERENCES public.patients(id) ON DELETE CASCADE,
  visit_id UUID REFERENCES public.visits(id) ON DELETE CASCADE,
  notification_type TEXT NOT NULL CHECK (notification_type IN ('result_ready', 'appointment_reminder', 'payment_due', 'discharge_ready', 'general')),
  title TEXT NOT NULL,
  message TEXT NOT NULL,
  read BOOLEAN DEFAULT false,
  created_at TIMESTAMPTZ DEFAULT now(),
  read_at TIMESTAMPTZ,
  action_url TEXT,
  priority TEXT DEFAULT 'normal' CHECK (priority IN ('low', 'normal', 'high', 'urgent'))
);

-- Enable RLS
ALTER TABLE public.patient_notifications ENABLE ROW LEVEL SECURITY;

-- Patients can view their own notifications
CREATE POLICY "Patients can view their own notifications"
  ON public.patient_notifications
  FOR SELECT
  USING (
    patient_id IN (
      SELECT id FROM public.patients 
      WHERE patient_account_id IN (
        SELECT id FROM public.patient_accounts 
        WHERE phone_number = (current_setting('request.jwt.claims', true)::json->>'phone')
      )
    )
  );

-- Staff can create notifications
CREATE POLICY "Staff can create notifications"
  ON public.patient_notifications
  FOR INSERT
  WITH CHECK (
    EXISTS (
      SELECT 1 FROM public.users 
      WHERE auth_user_id = auth.uid()
    )
  );

-- Patients can update their own notifications (mark as read)
CREATE POLICY "Patients can update their own notifications"
  ON public.patient_notifications
  FOR UPDATE
  USING (
    patient_id IN (
      SELECT id FROM public.patients 
      WHERE patient_account_id IN (
        SELECT id FROM public.patient_accounts 
        WHERE phone_number = (current_setting('request.jwt.claims', true)::json->>'phone')
      )
    )
  );

-- Create index for performance
CREATE INDEX IF NOT EXISTS idx_patient_notifications_patient_id ON public.patient_notifications(patient_id);
CREATE INDEX IF NOT EXISTS idx_patient_notifications_read ON public.patient_notifications(read);
CREATE INDEX IF NOT EXISTS idx_patient_notifications_created_at ON public.patient_notifications(created_at DESC);

-- Function to create notification when lab result is ready
CREATE OR REPLACE FUNCTION notify_patient_lab_result()
RETURNS TRIGGER AS $$
BEGIN
  -- Only notify when status changes to completed or result is entered
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
$$ LANGUAGE plpgsql SECURITY DEFINER;

-- Trigger for lab orders
DROP TRIGGER IF EXISTS trigger_notify_lab_result ON public.lab_orders;
CREATE TRIGGER trigger_notify_lab_result
  AFTER UPDATE ON public.lab_orders
  FOR EACH ROW
  EXECUTE FUNCTION notify_patient_lab_result();

-- Function to create notification when imaging result is ready
CREATE OR REPLACE FUNCTION notify_patient_imaging_result()
RETURNS TRIGGER AS $$
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
$$ LANGUAGE plpgsql SECURITY DEFINER;

-- Trigger for imaging orders
DROP TRIGGER IF EXISTS trigger_notify_imaging_result ON public.imaging_orders;
CREATE TRIGGER trigger_notify_imaging_result
  AFTER UPDATE ON public.imaging_orders
  FOR EACH ROW
  EXECUTE FUNCTION notify_patient_imaging_result();