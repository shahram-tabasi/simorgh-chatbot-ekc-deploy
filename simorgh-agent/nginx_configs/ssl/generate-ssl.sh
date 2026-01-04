#!/bin/bash
# =============================================================================
# SSL Certificate Generator for Simorgh Chatbot
# =============================================================================
# This script generates self-signed SSL certificates for local development
# and internal network use.
#
# Usage: ./generate-ssl.sh [domain]
#   domain: Optional domain name (default: localhost)
#
# For production, use Let's Encrypt or a real certificate authority.
# =============================================================================

set -e

DOMAIN="${1:-localhost}"
DAYS=365
SSL_DIR="$(dirname "$0")"

echo "=== Generating SSL Certificate for: $DOMAIN ==="

# Generate private key
openssl genrsa -out "$SSL_DIR/server.key" 2048

# Create certificate signing request config
cat > "$SSL_DIR/ssl.conf" << EOF
[req]
default_bits = 2048
prompt = no
default_md = sha256
distinguished_name = dn
x509_extensions = v3_req

[dn]
C = IR
ST = Tehran
L = Tehran
O = Simorgh AI
OU = Development
CN = $DOMAIN

[v3_req]
basicConstraints = CA:FALSE
keyUsage = nonRepudiation, digitalSignature, keyEncipherment
subjectAltName = @alt_names

[alt_names]
DNS.1 = $DOMAIN
DNS.2 = localhost
DNS.3 = *.local
IP.1 = 127.0.0.1
IP.2 = 192.168.1.68
IP.3 = 192.168.1.1
EOF

# Generate self-signed certificate
openssl req -new -x509 -nodes \
    -key "$SSL_DIR/server.key" \
    -out "$SSL_DIR/server.crt" \
    -days $DAYS \
    -config "$SSL_DIR/ssl.conf"

# Set permissions
chmod 600 "$SSL_DIR/server.key"
chmod 644 "$SSL_DIR/server.crt"

echo ""
echo "=== SSL Certificate Generated Successfully ==="
echo "Certificate: $SSL_DIR/server.crt"
echo "Private Key: $SSL_DIR/server.key"
echo "Valid for: $DAYS days"
echo ""
echo "Note: For browsers to trust this certificate, you may need to:"
echo "  1. Import server.crt into your browser's trusted certificates"
echo "  2. Or accept the security warning when accessing the site"
echo ""
