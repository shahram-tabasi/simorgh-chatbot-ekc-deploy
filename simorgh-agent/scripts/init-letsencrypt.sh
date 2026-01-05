#!/bin/bash
# =============================================================================
# Let's Encrypt SSL Certificate Initialization Script
# =============================================================================
# This script obtains initial SSL certificates from Let's Encrypt
#
# Prerequisites:
# 1. Domain (simorghai.electrokavir.com) must point to this server
# 2. Port 80 must be accessible from the internet for HTTP-01 challenge
# 3. Docker and docker-compose must be installed
#
# Usage: ./init-letsencrypt.sh [email] [--staging]
#   email: Your email for Let's Encrypt notifications
#   --staging: Use staging server for testing (recommended first)
# =============================================================================

set -e

# Configuration
DOMAIN="simorghai.electrokavir.com"
EMAIL="${1:-admin@electrokavir.com}"
STAGING="${2:-}"
RSA_KEY_SIZE=4096
DATA_PATH="./certbot"

# Colors for output
RED='\033[0;31m'
GREEN='\033[0;32m'
YELLOW='\033[1;33m'
NC='\033[0m' # No Color

echo -e "${GREEN}=== Let's Encrypt SSL Certificate Initialization ===${NC}"
echo "Domain: $DOMAIN"
echo "Email: $EMAIL"
echo ""

# Check if running as root or with sudo
if [[ $EUID -ne 0 ]]; then
    echo -e "${YELLOW}Warning: Not running as root. Some operations may fail.${NC}"
fi

# Check if certificate already exists
if docker compose exec -T certbot certbot certificates 2>/dev/null | grep -q "$DOMAIN"; then
    echo -e "${YELLOW}Certificate for $DOMAIN already exists.${NC}"
    read -p "Do you want to renew it? (y/N) " -n 1 -r
    echo
    if [[ ! $REPLY =~ ^[Yy]$ ]]; then
        echo "Exiting."
        exit 0
    fi
fi

# Create temporary nginx config for initial certificate request
echo -e "${GREEN}Step 1: Creating temporary nginx config for ACME challenge...${NC}"
cat > ./nginx_configs/conf.d/temp-acme.conf << 'EOF'
server {
    listen 80;
    server_name simorghai.electrokavir.com;

    location /.well-known/acme-challenge/ {
        root /var/www/certbot;
        allow all;
    }

    location / {
        return 200 "Waiting for certificate...";
        add_header Content-Type text/plain;
    }
}
EOF

# Temporarily disable SSL server blocks
echo -e "${GREEN}Step 2: Temporarily disabling SSL configuration...${NC}"
if [ -f ./nginx_configs/conf.d/default.conf ]; then
    mv ./nginx_configs/conf.d/default.conf ./nginx_configs/conf.d/default.conf.bak
fi

# Restart nginx with temporary config
echo -e "${GREEN}Step 3: Starting nginx with ACME challenge config...${NC}"
docker compose up -d nginx

# Wait for nginx to be ready
sleep 5

# Request certificate
echo -e "${GREEN}Step 4: Requesting certificate from Let's Encrypt...${NC}"

STAGING_ARG=""
if [[ "$STAGING" == "--staging" ]]; then
    echo -e "${YELLOW}Using staging server (for testing)${NC}"
    STAGING_ARG="--staging"
fi

docker compose run --rm certbot certonly \
    --webroot \
    --webroot-path=/var/www/certbot \
    --email "$EMAIL" \
    --agree-tos \
    --no-eff-email \
    --force-renewal \
    $STAGING_ARG \
    -d "$DOMAIN"

# Check if certificate was obtained successfully
if [ $? -eq 0 ]; then
    echo -e "${GREEN}✓ Certificate obtained successfully!${NC}"
else
    echo -e "${RED}✗ Failed to obtain certificate.${NC}"
    echo "Please check:"
    echo "  1. Domain $DOMAIN resolves to this server's public IP"
    echo "  2. Port 80 is accessible from the internet"
    echo "  3. Firewall allows incoming HTTP traffic"

    # Restore original config
    if [ -f ./nginx_configs/conf.d/default.conf.bak ]; then
        mv ./nginx_configs/conf.d/default.conf.bak ./nginx_configs/conf.d/default.conf
    fi
    rm -f ./nginx_configs/conf.d/temp-acme.conf
    exit 1
fi

# Restore original nginx config
echo -e "${GREEN}Step 5: Restoring production nginx configuration...${NC}"
rm -f ./nginx_configs/conf.d/temp-acme.conf
if [ -f ./nginx_configs/conf.d/default.conf.bak ]; then
    mv ./nginx_configs/conf.d/default.conf.bak ./nginx_configs/conf.d/default.conf
fi

# Restart nginx with SSL
echo -e "${GREEN}Step 6: Restarting nginx with SSL enabled...${NC}"
docker compose restart nginx

echo ""
echo -e "${GREEN}=== SSL Certificate Setup Complete! ===${NC}"
echo ""
echo "Your site is now available at:"
echo "  - https://$DOMAIN"
echo ""
echo "Certificate will auto-renew via the certbot container."
echo ""
echo -e "${YELLOW}Note: If you used --staging, run again without it for production certificate.${NC}"
