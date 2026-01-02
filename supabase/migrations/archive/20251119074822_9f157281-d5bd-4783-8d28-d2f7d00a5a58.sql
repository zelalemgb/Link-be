-- Phase 4: Seed default roles & permissions

ALTER TABLE public.permissions ADD COLUMN IF NOT EXISTS resource_type TEXT;
ALTER TABLE public.roles ADD COLUMN IF NOT EXISTS is_active BOOLEAN DEFAULT true;
ALTER TABLE public.roles ADD COLUMN IF NOT EXISTS scope TEXT DEFAULT 'facility';

CREATE OR REPLACE FUNCTION assign_permissions(role_name TEXT, permission_names TEXT[])
RETURNS void LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS $$
DECLARE v_role_id uuid; v_permission_id uuid; perm_name TEXT;
BEGIN
  SELECT id INTO v_role_id FROM public.roles WHERE name = role_name;
  FOREACH perm_name IN ARRAY permission_names LOOP
    SELECT id INTO v_permission_id FROM public.permissions WHERE name = perm_name;
    IF v_permission_id IS NOT NULL AND v_role_id IS NOT NULL THEN
      INSERT INTO public.role_permissions (role_id, permission_id) VALUES (v_role_id, v_permission_id) ON CONFLICT DO NOTHING;
    END IF;
  END LOOP;
END $$;

DO $$ BEGIN
  IF NOT EXISTS (SELECT 1 FROM public.permissions WHERE name = 'patient.create') THEN
    INSERT INTO public.permissions (name, description, resource, action, resource_type) VALUES
    ('patient.create','Create new patients','patient','create','data'),('patient.view','View patient information','patient','view','data'),
    ('patient.update','Update patient information','patient','update','data'),('patient.delete','Delete patient records','patient','delete','data'),
    ('patient.view_sensitive','View sensitive patient data','patient','view_sensitive','data'),('visit.create','Create new visits','visit','create','data'),
    ('visit.view','View visit information','visit','view','data'),('visit.update','Update visit information','visit','update','data'),
    ('visit.advance_stage','Advance patient journey stage','visit','advance_stage','action'),('reception.access','Access reception dashboard','reception','access','module'),
    ('reception.register_patient','Register new patients','reception','register_patient','action'),('reception.quick_service','Use quick service entry','reception','quick_service','action'),
    ('triage.access','Access triage dashboard','triage','access','module'),('triage.record_vitals','Record patient vital signs','triage','record_vitals','action'),
    ('triage.assess_urgency','Assess patient urgency','triage','assess_urgency','action'),('clinical.access','Access clinical dashboard','clinical','access','module'),
    ('clinical.assess','Perform clinical assessment','clinical','assess','action'),('clinical.diagnose','Create diagnoses','clinical','diagnose','action'),
    ('clinical.view_history','View patient medical history','clinical','view_history','data'),('order.create','Create orders','order','create','action'),
    ('order.view','View orders','order','view','data'),('order.update','Update orders','order','update','action'),
    ('order.cancel','Cancel orders','order','cancel','action'),('order.lab','Create lab orders','order','lab','action'),
    ('order.imaging','Create imaging orders','order','imaging','action'),('order.medication','Create medication orders','order','medication','action'),
    ('lab.access','Access lab dashboard','lab','access','module'),('lab.collect_sample','Collect lab samples','lab','collect_sample','action'),
    ('lab.process','Process lab tests','lab','process','action'),('lab.enter_results','Enter lab results','lab','enter_results','action'),
    ('lab.verify_results','Verify lab results','lab','verify_results','action'),('lab.quality_control','Perform quality control','lab','quality_control','action'),
    ('imaging.access','Access imaging dashboard','imaging','access','module'),('imaging.perform_study','Perform imaging studies','imaging','perform_study','action'),
    ('imaging.enter_results','Enter imaging results','imaging','enter_results','action'),('imaging.view_dicom','View DICOM images','imaging','view_dicom','data'),
    ('pharmacy.access','Access pharmacy dashboard','pharmacy','access','module'),('pharmacy.dispense','Dispense medications','pharmacy','dispense','action'),
    ('pharmacy.manage_inventory','Manage pharmacy inventory','pharmacy','manage_inventory','action'),('pharmacy.return','Process medication returns','pharmacy','return','action'),
    ('finance.access','Access finance dashboard','finance','access','module'),('finance.process_payment','Process payments','finance','process_payment','action'),
    ('finance.view_billing','View billing information','finance','view_billing','data'),('finance.create_billing','Create billing items','finance','create_billing','action'),
    ('finance.refund','Process refunds','finance','refund','action'),('finance.view_reports','View financial reports','finance','view_reports','data'),
    ('inpatient.access','Access inpatient dashboard','inpatient','access','module'),('inpatient.admit','Admit patients','inpatient','admit','action'),
    ('inpatient.discharge','Discharge patients','inpatient','discharge','action'),('inpatient.manage_beds','Manage bed assignments','inpatient','manage_beds','action'),
    ('inpatient.care_plan','Manage care plans','inpatient','care_plan','action'),('admin.access','Access admin dashboard','admin','access','module'),
    ('admin.manage_users','Manage user accounts','admin','manage_users','action'),('admin.manage_roles','Manage roles and permissions','admin','manage_roles','action'),
    ('admin.manage_facility','Manage facility settings','admin','manage_facility','action'),('admin.view_audit','View audit logs','admin','view_audit','data'),
    ('admin.manage_master_data','Manage master data','admin','manage_master_data','action'),('inventory.access','Access inventory dashboard','inventory','access','module'),
    ('inventory.view','View inventory','inventory','view','data'),('inventory.update','Update inventory','inventory','update','action'),
    ('inventory.request_resupply','Request inventory resupply','inventory','request_resupply','action'),('reports.access','Access reports','reports','access','module'),
    ('reports.clinical','View clinical reports','reports','clinical','data'),('reports.financial','View financial reports','reports','financial','data'),
    ('reports.operational','View operational reports','reports','operational','data'),('reports.export','Export reports','reports','export','action');
  END IF;
END $$;

DO $$ BEGIN
  IF NOT EXISTS (SELECT 1 FROM public.roles WHERE name = 'super_admin') THEN
    INSERT INTO public.roles (name, slug, description, scope, is_system_role, is_active) VALUES
    ('super_admin','super-admin','System administrator with all permissions','system',true,true),
    ('clinic_admin','clinic-admin','Clinic administrator','facility',true,true),
    ('receptionist','receptionist','Front desk staff','facility',true,true),
    ('nurse','nurse','Nursing staff','facility',true,true),
    ('triage_nurse','triage-nurse','Triage specialist','facility',true,true),
    ('doctor','doctor','Medical doctor','facility',true,true),
    ('lab_technician','lab-technician','Laboratory technician','facility',true,true),
    ('lab_supervisor','lab-supervisor','Laboratory supervisor','facility',true,true),
    ('imaging_technician','imaging-technician','Radiology/imaging technician','facility',true,true),
    ('pharmacist','pharmacist','Pharmacy staff','facility',true,true),
    ('cashier','cashier','Finance/cashier staff','facility',true,true),
    ('finance_officer','finance-officer','Finance officer','facility',true,true),
    ('inpatient_nurse','inpatient-nurse','Inpatient nursing staff','facility',true,true),
    ('medical_director','medical-director','Medical director','facility',true,true),
    ('nursing_head','nursing-head','Head of nursing','facility',true,true),
    ('logistic_officer','logistic-officer','Logistics/inventory officer','facility',true,true),
    ('rhb_officer','rhb-officer','Regional Health Bureau officer','system',true,true);
  END IF;
END $$;

DO $$ BEGIN
  PERFORM assign_permissions('super_admin', ARRAY(SELECT name FROM public.permissions));
  PERFORM assign_permissions('clinic_admin', ARRAY['patient.view','patient.view_sensitive','visit.view','admin.access','admin.manage_users','admin.manage_facility','admin.view_audit','admin.manage_master_data','reports.access','reports.clinical','reports.financial','reports.operational','reports.export','finance.view_billing','finance.view_reports','inventory.access','inventory.view']);
  PERFORM assign_permissions('receptionist', ARRAY['patient.create','patient.view','patient.update','visit.create','visit.view','visit.update','visit.advance_stage','reception.access','reception.register_patient','reception.quick_service','finance.view_billing','finance.create_billing']);
  PERFORM assign_permissions('nurse', ARRAY['patient.view','visit.view','visit.update','visit.advance_stage','triage.access','triage.record_vitals','triage.assess_urgency','order.view']);
  PERFORM assign_permissions('triage_nurse', ARRAY['patient.view','visit.view','visit.update','visit.advance_stage','triage.access','triage.record_vitals','triage.assess_urgency','clinical.view_history','order.view']);
  PERFORM assign_permissions('doctor', ARRAY['patient.view','patient.view_sensitive','patient.update','visit.view','visit.update','visit.advance_stage','clinical.access','clinical.assess','clinical.diagnose','clinical.view_history','order.create','order.view','order.update','order.cancel','order.lab','order.imaging','order.medication','inpatient.admit','inpatient.discharge','inpatient.care_plan']);
  PERFORM assign_permissions('lab_technician', ARRAY['patient.view','visit.view','lab.access','lab.collect_sample','lab.process','lab.enter_results','order.view']);
  PERFORM assign_permissions('lab_supervisor', ARRAY['patient.view','visit.view','lab.access','lab.collect_sample','lab.process','lab.enter_results','lab.verify_results','lab.quality_control','order.view','reports.clinical']);
  PERFORM assign_permissions('imaging_technician', ARRAY['patient.view','visit.view','imaging.access','imaging.perform_study','imaging.enter_results','imaging.view_dicom','order.view']);
  PERFORM assign_permissions('pharmacist', ARRAY['patient.view','visit.view','pharmacy.access','pharmacy.dispense','pharmacy.manage_inventory','pharmacy.return','order.view','inventory.access','inventory.view','inventory.update','inventory.request_resupply']);
  PERFORM assign_permissions('cashier', ARRAY['patient.view','visit.view','visit.advance_stage','finance.access','finance.process_payment','finance.view_billing','finance.create_billing','order.view']);
  PERFORM assign_permissions('finance_officer', ARRAY['patient.view','visit.view','finance.access','finance.process_payment','finance.view_billing','finance.create_billing','finance.refund','finance.view_reports','order.view','reports.financial','reports.export']);
  PERFORM assign_permissions('inpatient_nurse', ARRAY['patient.view','patient.view_sensitive','visit.view','visit.update','inpatient.access','inpatient.manage_beds','inpatient.care_plan','triage.record_vitals','order.view','clinical.view_history']);
  PERFORM assign_permissions('medical_director', ARRAY['patient.view','patient.view_sensitive','visit.view','clinical.access','clinical.view_history','admin.access','admin.view_audit','admin.manage_facility','reports.access','reports.clinical','reports.operational','reports.export','order.view']);
  PERFORM assign_permissions('nursing_head', ARRAY['patient.view','visit.view','triage.access','inpatient.access','admin.access','admin.manage_users','admin.view_audit','reports.access','reports.clinical','reports.operational']);
  PERFORM assign_permissions('logistic_officer', ARRAY['inventory.access','inventory.view','inventory.update','inventory.request_resupply','pharmacy.manage_inventory','reports.operational']);
  PERFORM assign_permissions('rhb_officer', ARRAY['patient.view','visit.view','reports.access','reports.clinical','reports.financial','reports.operational','reports.export']);
END $$;

CREATE OR REPLACE FUNCTION get_role_permissions(role_name TEXT)
RETURNS TABLE(permission_name TEXT, permission_description TEXT, resource TEXT, resource_type TEXT)
LANGUAGE sql STABLE SECURITY DEFINER SET search_path = public
AS $$ SELECT p.name,p.description,p.resource,p.resource_type FROM public.permissions p JOIN public.role_permissions rp ON p.id=rp.permission_id JOIN public.roles r ON r.id=rp.role_id WHERE r.name=role_name AND r.is_active=true; $$;

CREATE OR REPLACE FUNCTION has_module_access(_user_id UUID, module_name TEXT)
RETURNS BOOLEAN LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path = public
AS $$ DECLARE v_has_access BOOLEAN; BEGIN SELECT EXISTS(SELECT 1 FROM public.user_roles ur JOIN public.role_permissions rp ON ur.role_id=rp.role_id JOIN public.permissions p ON rp.permission_id=p.id WHERE ur.user_id=_user_id AND ur.is_active=true AND(ur.expires_at IS NULL OR ur.expires_at>NOW())AND p.name=module_name||'.access')INTO v_has_access; RETURN v_has_access; END; $$;

CREATE OR REPLACE FUNCTION can_transition_journey(_user_id UUID, _from_stage TEXT, _to_stage TEXT)
RETURNS BOOLEAN LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path = public
AS $$ DECLARE v_can_advance BOOLEAN; BEGIN SELECT EXISTS(SELECT 1 FROM public.user_roles ur JOIN public.role_permissions rp ON ur.role_id=rp.role_id JOIN public.permissions p ON rp.permission_id=p.id WHERE ur.user_id=_user_id AND ur.is_active=true AND(ur.expires_at IS NULL OR ur.expires_at>NOW())AND p.name='visit.advance_stage')INTO v_can_advance; RETURN v_can_advance; END; $$;

GRANT EXECUTE ON FUNCTION get_role_permissions(TEXT) TO authenticated;
GRANT EXECUTE ON FUNCTION has_module_access(UUID,TEXT) TO authenticated;
GRANT EXECUTE ON FUNCTION can_transition_journey(UUID,TEXT,TEXT) TO authenticated;

DROP FUNCTION IF EXISTS assign_permissions(TEXT,TEXT[]);