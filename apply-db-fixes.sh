#!/bin/bash
# ============================================================
# Apply LinkHC Database Fixes via Supabase CLI
# Run this from your Mac terminal inside the link-be/ directory
# ============================================================

set -e

PROJECT_REF="qxihedrgltophafkuasa"

echo "🔗 Linking project..."
supabase link --project-ref "$PROJECT_REF"

echo ""
echo "📦 Pushing migrations to remote database..."
supabase db push

echo ""
echo "✅ All migrations applied!"
echo ""
echo "Migrations applied:"
echo "  20260305100000 — FIX 01: FK constraints hardened (CASCADE → RESTRICT)"
echo "  20260305110000 — FIX 02: Diagnoses table created"
echo "  20260305120000 — FIX 03: Patient allergies table created"
echo "  20260305130000 — FIX 04: Clinical sub-tables CASCADE → RESTRICT"
echo "  20260305140000 — FIX 05: Compound indexes added"
echo "  20260305150000 — FIX 06: RLS helper functions (N+1 fix)"
echo "  20260305160000 — FIX 07: Payment journal + reconciliation tables"
echo "  20260305170000 — FIX 08: Provider credentials table"
echo "  20260305180000 — FIX 09: Lab units, observations, notes, referrals"
echo ""
echo "Don't forget: also apply SEED_CONSULTATION_SERVICES.sql via Supabase Dashboard"
echo "→ https://supabase.com/dashboard/project/$PROJECT_REF/sql/new"
