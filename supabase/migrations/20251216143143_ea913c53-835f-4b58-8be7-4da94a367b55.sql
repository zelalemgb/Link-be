
-- Create the default tenant that facilities table expects
INSERT INTO public.tenants (id, name)
VALUES ('00000000-0000-0000-0000-000000000001'::uuid, 'Pending Registration')
ON CONFLICT (id) DO NOTHING;
