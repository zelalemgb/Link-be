
-- =====================================================
-- CLEANUP: Delete all test data except super admin
-- Preserves: super admin user (auth_user_id: d0fa4ee5-b4c9-403a-a6c7-35fcfb30fc2b)
-- =====================================================

-- 1. Delete clinical assessment records
DELETE FROM public.anc_assessments;
DELETE FROM public.delivery_records;
DELETE FROM public.emergency_assessments;
DELETE FROM public.family_planning_visits;
DELETE FROM public.pediatric_assessments;
DELETE FROM public.surgical_assessments;
DELETE FROM public.immunization_records;
DELETE FROM public.triage;

-- 2. Delete care plans and interventions
DELETE FROM public.intervention_completions;
DELETE FROM public.care_plan_interventions;
DELETE FROM public.nursing_care_plans;

-- 3. Delete visit-related data
DELETE FROM public.visit_associated_symptoms;
DELETE FROM public.visit_negative_symptoms;
DELETE FROM public.visit_narratives;
DELETE FROM public.visit_tags;

-- 4. Delete orders
DELETE FROM public.rx_items;
DELETE FROM public.medication_orders;
DELETE FROM public.lab_orders;
DELETE FROM public.imaging_orders;
DELETE FROM public.patient_order_items;
DELETE FROM public.patient_orders;

-- 5. Delete payments and billing
DELETE FROM public.payment_transactions;
DELETE FROM public.payment_line_items;
DELETE FROM public.payments;
DELETE FROM public.billing_items;

-- 6. Delete IPD related
DELETE FROM public.ipd_charges;
DELETE FROM public.ipd_tasks;

-- 7. Delete patient notifications
DELETE FROM public.notification_receipts;
DELETE FROM public.notifications;
DELETE FROM public.patient_notifications;

-- 8. Delete admissions
DELETE FROM public.admissions;

-- 9. Delete visits and patient status
DELETE FROM public.patient_status_events;
DELETE FROM public.patient_visit_summaries;
DELETE FROM public.visits;

-- 10. Delete patient data
DELETE FROM public.patient_identifiers;
DELETE FROM public.patient_accounts;
DELETE FROM public.patient_documents;
DELETE FROM public.patient_appointment_requests;
DELETE FROM public.patient_symptom_logs;
DELETE FROM public.patients;

-- 11. Delete beds
DELETE FROM public.beds;

-- 12. Delete wards
DELETE FROM public.wards;

-- 13. Delete departments
DELETE FROM public.departments;

-- 14. Delete inventory
DELETE FROM public.issue_order_items;
DELETE FROM public.issue_orders;
DELETE FROM public.request_line_items;
DELETE FROM public.request_for_resupply;
DELETE FROM public.stock_requests;
DELETE FROM public.loss_adjustments;
DELETE FROM public.stock_movements;
DELETE FROM public.receiving_invoice_items;
DELETE FROM public.receiving_invoices;
DELETE FROM public.inventory_accounts;
DELETE FROM public.inventory_items;

-- 15. Delete master data (facility-specific)
DELETE FROM public.medical_services;
DELETE FROM public.lab_test_master;
DELETE FROM public.medication_master;
DELETE FROM public.imaging_order_templates;
DELETE FROM public.programs;
DELETE FROM public.insurers;
DELETE FROM public.insurance_providers;
DELETE FROM public.creditors;
DELETE FROM public.suppliers;
DELETE FROM public.dispensing_units;

-- 16. Delete staff invitations and requests
DELETE FROM public.staff_invitations;
DELETE FROM public.staff_registration_requests;

-- 17. Delete feature requests and votes
DELETE FROM public.feature_request_votes;
DELETE FROM public.feature_requests;

-- 18. Delete email verification codes
DELETE FROM public.email_verification_codes;

-- 19. Delete KPI data
DELETE FROM public.kpi_values;
DELETE FROM public.kpi_targets;
DELETE FROM public.kpi_definitions;

-- 20. Delete system metrics and alerts
DELETE FROM public.system_metrics;
DELETE FROM public.system_alerts;
DELETE FROM public.outbox_events;

-- 21. Delete user preferences
DELETE FROM public.user_preferences WHERE user_id NOT IN (
  SELECT id FROM public.users WHERE user_role = 'super_admin'
);

-- 22. Delete waitlist
DELETE FROM public.waitlist;

-- 23. Delete user roles (except super admin)
DELETE FROM public.user_roles 
WHERE user_id NOT IN (
  SELECT id FROM public.users WHERE user_role = 'super_admin'
);

-- 24. Delete role assignments audit (except super admin)
DELETE FROM public.role_assignments_audit
WHERE user_id NOT IN (
  SELECT id FROM public.users WHERE user_role = 'super_admin'
);

-- 25. Delete clinic registrations
DELETE FROM public.clinic_registrations;

-- 26. Delete beta registrations
DELETE FROM public.beta_registrations;

-- 27. Delete non-super-admin users from public.users
DELETE FROM public.users 
WHERE user_role != 'super_admin';

-- 28. Delete facilities (except system tenant facility if any)
DELETE FROM public.facilities 
WHERE tenant_id NOT IN (
  SELECT id FROM public.tenants WHERE name = 'System Administration'
);

-- 29. Delete non-system tenants
DELETE FROM public.tenants 
WHERE name != 'System Administration';
