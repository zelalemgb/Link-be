-- Update allowed status values to include payment stages used in journey
ALTER TABLE public.patient_status_events
  DROP CONSTRAINT IF EXISTS valid_status_values;

ALTER TABLE public.patient_status_events
  ADD CONSTRAINT valid_status_values CHECK (
    new_status IN (
      'registered',
      'paying_consultation',
      'paying_diagnosis',
      'paying_pharmacy',
      'at_triage',
      'vitals_taken',
      'with_doctor',
      'awaiting_results',
      'at_lab',
      'at_imaging',
      'at_pharmacy',
      'ready_for_discharge',
      'discharged',
      'admitted',
      'cancelled'
    )
  );

COMMENT ON CONSTRAINT valid_status_values ON public.patient_status_events IS 'Ensure new_status only includes supported journey stages, including payment stages.';