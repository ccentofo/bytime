#!/bin/bash
set -euo pipefail

# Usage: ./scripts/provision-customer.sh <company-slug> <admin-email> <admin-name>
COMPANY_SLUG="${1:?Usage: provision-customer.sh <company-slug> <admin-email> <admin-name>}"
ADMIN_EMAIL="${2:?Missing admin email}"
ADMIN_NAME="${3:?Missing admin name}"

echo "=== ByTime Customer Provisioning ==="
echo "Company: $COMPANY_SLUG"
echo "Admin: $ADMIN_NAME <$ADMIN_EMAIL>"
echo ""

# Generate secrets
AUTH_SECRET=$(openssl rand -base64 32)
ENCRYPTION_KEY=$(openssl rand -hex 32)
ADMIN_PASSWORD=$(openssl rand -base64 12)

echo "1. Creating Neon database..."
# Option A: Neon CLI (if installed)
# neon projects create --name "bytime-$COMPANY_SLUG" --output json > /tmp/neon-project.json
# DATABASE_URL=$(cat /tmp/neon-project.json | jq -r '.connection_uri')

# Option B: Manual — prompt user
echo "   → Create a Neon project named 'bytime-$COMPANY_SLUG' at https://neon.tech"
echo "   → Enter the connection string:"
read -p "DATABASE_URL: " DATABASE_URL

echo ""
echo "2. Pushing database schema..."
DATABASE_URL="$DATABASE_URL" npx drizzle-kit push

echo ""
echo "3. Creating admin user and seeding defaults..."
DATABASE_URL="$DATABASE_URL" npx tsx scripts/provision-customer-db.ts \
  "$ADMIN_EMAIL" "$ADMIN_NAME" "$ADMIN_PASSWORD"

echo ""
echo "4. Generating .env file..."
cat > ".env.$COMPANY_SLUG" << EOF
# ByTime — $COMPANY_SLUG
DATABASE_URL=$DATABASE_URL
AUTH_SECRET=$AUTH_SECRET
ENCRYPTION_KEY=$ENCRYPTION_KEY
NEXT_PUBLIC_APP_URL=https://bytime-$COMPANY_SLUG.vercel.app

# Email (optional)
# RESEND_API_KEY=
# EMAIL_FROM=noreply@$COMPANY_SLUG.bytime.app

# Integrations (optional)
# QBO_CLIENT_ID=
# QBO_CLIENT_SECRET=
# GUSTO_CLIENT_ID=
# GUSTO_CLIENT_SECRET=
EOF

echo ""
echo "=== Provisioning Complete ==="
echo ""
echo "Customer: $COMPANY_SLUG"
echo "Database: $DATABASE_URL"
echo "Admin Email: $ADMIN_EMAIL"
echo "Admin Password: $ADMIN_PASSWORD"
echo "Auth Secret: $AUTH_SECRET"
echo "Encryption Key: $ENCRYPTION_KEY"
echo "Env file: .env.$COMPANY_SLUG"
echo ""
echo "⚠️  SAVE THE ADMIN PASSWORD — it cannot be recovered."
echo ""
echo "Next steps:"
echo "  1. Deploy to Vercel: vercel --env-file .env.$COMPANY_SLUG"
echo "  2. Or Docker: cp .env.$COMPANY_SLUG .env && docker compose -f docker-compose.prod.yml up -d"
echo "  3. Set custom domain in Vercel/Caddy"
