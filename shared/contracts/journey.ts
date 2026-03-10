export const JOURNEY_STAGES = [
  'registered',
  'at_triage',
  'vitals_taken',
  'paying_consultation',
  'with_doctor',
  'paying_diagnosis',
  'at_lab',
  'at_imaging',
  'paying_pharmacy',
  'at_pharmacy',
  'admitted',
  'discharged',
] as const;

export type PatientJourneyStage = typeof JOURNEY_STAGES[number];
