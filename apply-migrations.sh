#!/bin/bash
# Migration Application Script
# This script applies the pending migrations to your Supabase database

echo "🔄 Applying Database Migrations..."
echo ""

# Check if .env file exists
if [ ! -f .env ]; then
  echo "❌ Error: .env file not found"
  echo "Please create a .env file with your Supabase credentials"
  exit 1
fi

# Source the .env file
set -a
source .env
set +a

# Check if required variables are set
if [ -z "$SUPABASE_URL" ] || [ -z "$SUPABASE_SERVICE_ROLE_KEY" ]; then
  echo "❌ Error: SUPABASE_URL or SUPABASE_SERVICE_ROLE_KEY not set in .env"
  exit 1
fi

# Extract database connection details from Supabase URL
# Supabase URL format: https://[project-ref].supabase.co
PROJECT_REF=$(echo $SUPABASE_URL | sed -E 's|https://([^.]+)\.supabase\.co|\1|')

echo "📊 Project: $PROJECT_REF"
echo ""

# Check if DATABASE_URL is set (for direct connection)
if [ -n "$DATABASE_URL" ]; then
  echo "✅ Using direct database connection..."
  
  # Apply migrations using psql
  for migration in supabase/migrations/20260102*.sql; do
    if [ -f "$migration" ]; then
      echo "📄 Applying: $(basename $migration)"
      psql "$DATABASE_URL" -f "$migration"
      
      if [ $? -eq 0 ]; then
        echo "✅ Successfully applied: $(basename $migration)"
      else
        echo "❌ Failed to apply: $(basename $migration)"
        exit 1
      fi
      echo ""
    fi
  done
else
  echo "⚠️  No DATABASE_URL found."
  echo ""
  echo "To apply migrations, you have two options:"
  echo ""
  echo "1. Using Supabase Dashboard:"
  echo "   - Go to: https://supabase.com/dashboard/project/$PROJECT_REF/sql/new"
  echo "   - Copy and paste the contents of each migration file"
  echo "   - Run the SQL"
  echo ""
  echo "2. Using psql (if you have database connection string):"
  echo "   - Add DATABASE_URL to your .env file"
  echo "   - Run this script again"
  echo ""
  echo "Migration files to apply (in order):"
  echo "   1. supabase/migrations/20260102000000_add_last_login_tracking.sql"
  echo "   2. supabase/migrations/20260102000001_fix_register_patient_payment_params.sql"
  exit 1
fi

echo "✨ All migrations applied successfully!"
