#!/bin/bash
# =============================================================================
# Let's Encrypt Certificate Setup Script for Host Nginx
# =============================================================================
# This script installs certbot and obtains SSL certificates from Let's Encrypt
#
# Usage:
#   sudo ./setup-certbot.sh [email] [--staging]
#
# Examples:
#   sudo ./setup-certbot.sh admin@electrokavir.com
#   sudo ./setup-certbot.sh admin@electrokavir.com --staging  # For testing
#
# Prerequisites:
#   - Ubuntu/Debian server with nginx installed
#   - Domain (simorghai.electrokavir.com) must resolve to this server
#   - Port 80 must be accessible from the internet
#   - Firewall must allow /.well-known/acme-challenge/ requests
# =============================================================================

set -e

# Configuration
DOMAIN="simorghai.electrokavir.com"
WEBROOT="/var/www/certbot"
NGINX_CONF_DIR="/etc/nginx"
SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"

# Colors for output
RED='\033[0;31m'
GREEN='\033[0;32m'
YELLOW='\033[1;33m'
NC='\033[0m' # No Color

# Parse arguments
EMAIL="${1:-}"
STAGING=""
if [[ "$2" == "--staging" ]] || [[ "$1" == "--staging" ]]; then
    STAGING="--staging"
    if [[ "$1" == "--staging" ]]; then
        EMAIL="${2:-}"
    fi
fi

# Functions
log_info() {
    echo -e "${GREEN}[INFO]${NC} $1"
}

log_warn() {
    echo -e "${YELLOW}[WARN]${NC} $1"
}

log_error() {
    echo -e "${RED}[ERROR]${NC} $1"
}

check_root() {
    if [[ $EUID -ne 0 ]]; then
        log_error "This script must be run as root (use sudo)"
        exit 1
    fi
}

check_prerequisites() {
    log_info "Checking prerequisites..."

    # Check if nginx is installed
    if ! command -v nginx &> /dev/null; then
        log_error "Nginx is not installed. Please install nginx first:"
        echo "  sudo apt update && sudo apt install nginx"
        exit 1
    fi

    # Check if nginx is running
    if ! systemctl is-active --quiet nginx; then
        log_warn "Nginx is not running. Starting nginx..."
        systemctl start nginx
    fi

    # Check if port 80 is accessible
    log_info "Checking if port 80 is accessible..."
    if ! curl -s -o /dev/null -w "%{http_code}" "http://localhost" | grep -q "200\|301\|302\|403"; then
        log_warn "Could not verify nginx is responding on port 80"
    fi

    log_info "Prerequisites check completed"
}

install_certbot() {
    log_info "Installing certbot..."

    # Update package list
    apt update

    # Install certbot and nginx plugin
    apt install -y certbot python3-certbot-nginx

    log_info "Certbot installed successfully"
}

create_webroot() {
    log_info "Creating webroot directory for ACME challenges..."

    mkdir -p "$WEBROOT"
    chown -R www-data:www-data "$WEBROOT"
    chmod -R 755 "$WEBROOT"

    log_info "Webroot created at $WEBROOT"
}

configure_nginx_for_acme() {
    log_info "Configuring nginx for ACME challenge..."

    # Create a temporary configuration that allows ACME challenges
    cat > /etc/nginx/conf.d/certbot-acme.conf << 'EOF'
# Temporary ACME challenge configuration
# This will be removed after certificate is obtained
server {
    listen 80;
    server_name simorghai.electrokavir.com;

    location /.well-known/acme-challenge/ {
        root /var/www/certbot;
        allow all;
    }

    location / {
        return 444;
    }
}
EOF

    # Test nginx configuration
    if nginx -t; then
        systemctl reload nginx
        log_info "Nginx configured for ACME challenge"
    else
        log_error "Nginx configuration test failed"
        rm -f /etc/nginx/conf.d/certbot-acme.conf
        exit 1
    fi
}

obtain_certificate() {
    log_info "Obtaining SSL certificate from Let's Encrypt..."

    local email_arg=""
    if [[ -n "$EMAIL" ]]; then
        email_arg="--email $EMAIL"
    else
        email_arg="--register-unsafely-without-email"
        log_warn "No email provided. Certificate expiration warnings will not be sent."
    fi

    # Obtain certificate using webroot method
    certbot certonly \
        --webroot \
        --webroot-path="$WEBROOT" \
        --domain "$DOMAIN" \
        $email_arg \
        --agree-tos \
        --no-eff-email \
        --keep-until-expiring \
        --non-interactive \
        $STAGING

    if [[ $? -eq 0 ]]; then
        log_info "Certificate obtained successfully!"
    else
        log_error "Failed to obtain certificate"
        exit 1
    fi
}

cleanup_temp_config() {
    log_info "Cleaning up temporary ACME configuration..."
    rm -f /etc/nginx/conf.d/certbot-acme.conf
}

install_ssl_config() {
    log_info "Installing SSL-enabled nginx configuration..."

    # Backup current configuration
    if [[ -f "$NGINX_CONF_DIR/sites-enabled/default" ]]; then
        cp "$NGINX_CONF_DIR/sites-enabled/default" "$NGINX_CONF_DIR/sites-enabled/default.backup.$(date +%Y%m%d%H%M%S)"
    fi

    # Copy the SSL configuration
    if [[ -f "$SCRIPT_DIR/default-ssl.conf" ]]; then
        cp "$SCRIPT_DIR/default-ssl.conf" "$NGINX_CONF_DIR/sites-available/default-ssl"

        # Remove old symlink and create new one
        rm -f "$NGINX_CONF_DIR/sites-enabled/default"
        ln -sf "$NGINX_CONF_DIR/sites-available/default-ssl" "$NGINX_CONF_DIR/sites-enabled/default"

        log_info "SSL configuration installed"
    else
        log_warn "default-ssl.conf not found in $SCRIPT_DIR"
        log_warn "Please manually copy the SSL configuration to nginx"
    fi
}

setup_auto_renewal() {
    log_info "Setting up automatic certificate renewal..."

    # Certbot automatically installs a systemd timer or cron job
    # Verify it's set up
    if systemctl list-timers | grep -q certbot; then
        log_info "Certbot renewal timer is active"
    else
        # Create a cron job for renewal
        echo "0 0,12 * * * root certbot renew --quiet --post-hook 'systemctl reload nginx'" > /etc/cron.d/certbot-renewal
        log_info "Created cron job for certificate renewal"
    fi
}

test_configuration() {
    log_info "Testing nginx configuration..."

    if nginx -t; then
        log_info "Configuration test passed"
        systemctl reload nginx
        log_info "Nginx reloaded with new configuration"
    else
        log_error "Configuration test failed!"
        log_error "Please check the nginx configuration manually"
        exit 1
    fi
}

verify_ssl() {
    log_info "Verifying SSL certificate..."

    sleep 2

    if curl -sI "https://$DOMAIN" 2>/dev/null | head -1 | grep -q "200\|301\|302"; then
        log_info "SSL is working! Site is accessible via HTTPS"
    else
        log_warn "Could not verify HTTPS access. This might be due to DNS or firewall settings."
        log_info "You can manually verify by visiting: https://$DOMAIN"
    fi
}

print_summary() {
    echo ""
    echo "============================================================================="
    echo -e "${GREEN}SSL Certificate Setup Complete!${NC}"
    echo "============================================================================="
    echo ""
    echo "Certificate files:"
    echo "  - Certificate: /etc/letsencrypt/live/$DOMAIN/fullchain.pem"
    echo "  - Private Key: /etc/letsencrypt/live/$DOMAIN/privkey.pem"
    echo "  - Chain:       /etc/letsencrypt/live/$DOMAIN/chain.pem"
    echo ""
    echo "Your site should now be accessible via HTTPS:"
    echo "  https://$DOMAIN"
    echo ""
    echo "Certificate will auto-renew before expiration."
    echo ""
    if [[ -n "$STAGING" ]]; then
        echo -e "${YELLOW}NOTE: You used --staging flag. This is a TEST certificate.${NC}"
        echo "Run without --staging to get a production certificate."
    fi
    echo "============================================================================="
}

# =============================================================================
# Main Script
# =============================================================================

main() {
    echo "============================================================================="
    echo "Let's Encrypt SSL Certificate Setup"
    echo "Domain: $DOMAIN"
    echo "============================================================================="
    echo ""

    check_root
    check_prerequisites
    install_certbot
    create_webroot
    configure_nginx_for_acme
    obtain_certificate
    cleanup_temp_config
    install_ssl_config
    setup_auto_renewal
    test_configuration
    verify_ssl
    print_summary
}

main "$@"
