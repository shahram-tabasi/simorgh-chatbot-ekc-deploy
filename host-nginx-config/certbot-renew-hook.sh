#!/bin/bash
# =============================================================================
# Certbot Renewal Hook Script
# =============================================================================
# This script is called after certbot successfully renews certificates
# It reloads nginx to pick up the new certificates
#
# Installation:
#   sudo cp certbot-renew-hook.sh /etc/letsencrypt/renewal-hooks/deploy/
#   sudo chmod +x /etc/letsencrypt/renewal-hooks/deploy/certbot-renew-hook.sh
# =============================================================================

set -e

LOGFILE="/var/log/certbot-renewal.log"

log() {
    echo "[$(date '+%Y-%m-%d %H:%M:%S')] $1" >> "$LOGFILE"
}

log "Certificate renewed for domain: ${RENEWED_DOMAINS:-unknown}"
log "Certificate lineage: ${RENEWED_LINEAGE:-unknown}"

# Reload nginx to pick up new certificate
if systemctl reload nginx; then
    log "Nginx reloaded successfully"
else
    log "ERROR: Failed to reload nginx"
    exit 1
fi

# Optional: Send notification (uncomment and configure as needed)
# echo "SSL certificate renewed for ${RENEWED_DOMAINS}" | mail -s "SSL Renewal" admin@electrokavir.com

log "Renewal hook completed successfully"
