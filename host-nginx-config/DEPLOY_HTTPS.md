# Host Nginx HTTPS Configuration with Let's Encrypt

This guide explains how to enable HTTPS on the host nginx using Let's Encrypt certificates.

## Architecture Overview

```
┌─────────────────────────────────────────────────────────────────────┐
│                         EXTERNAL TRAFFIC                            │
└─────────────────────────────┬───────────────────────────────────────┘
                              │
                              ▼
┌─────────────────────────────────────────────────────────────────────┐
│                    HOST NGINX (Port 80 + 443)                       │
│  ┌─────────────────┐    ┌─────────────────────────────────────────┐ │
│  │   Port 80       │    │              Port 443 (SSL)             │ │
│  │   HTTP          │    │  - Let's Encrypt Certificate            │ │
│  │                 │    │  - TLS 1.2/1.3                          │ │
│  │  ┌───────────┐  │    │  - HTTP/2                               │ │
│  │  │ ACME      │  │    │  - HSTS Header                          │ │
│  │  │ Challenge │  │    └─────────────────────────────────────────┘ │
│  │  └───────────┘  │                       │                        │
│  │       │         │                       │                        │
│  │  Redirect 301 ──┼───────────────────────┘                        │
│  └─────────────────┘                                                │
│                              │                                      │
│                              ▼                                      │
│  Routes:                                                            │
│    /chatbot/*  ───────────► Docker nginx:85 (HTTP internal)         │
│    /eplanix/*  ───────────► 192.168.1.63/64 (HTTP internal)         │
└─────────────────────────────────────────────────────────────────────┘
                              │
                              ▼
┌─────────────────────────────────────────────────────────────────────┐
│                    DOCKER NGINX (Port 85)                           │
│                                                                     │
│    /api/stt/*   ───────────► stt-service:8001                       │
│    /api/*       ───────────► backend:8890                           │
│    /            ───────────► frontend:80                            │
└─────────────────────────────────────────────────────────────────────┘
```

## Prerequisites

1. **Domain Resolution**: `simorghai.electrokavir.com` must resolve to your server's public IP
2. **Port Access**: Ports 80 and 443 must be accessible from the internet
3. **Firewall**: Must allow `/.well-known/acme-challenge/` requests through
4. **Nginx**: Host nginx must be installed and running
5. **Docker Services**: Docker nginx should be running on port 85

## Quick Setup

### Option A: Automated Setup (Recommended)

```bash
# Copy files to server
scp host-nginx-config/* user@server:/tmp/

# SSH to server and run setup
ssh user@server
cd /tmp
sudo ./setup-certbot.sh admin@electrokavir.com

# For testing with staging certificates first:
sudo ./setup-certbot.sh admin@electrokavir.com --staging
```

### Option B: Manual Setup

#### Step 1: Install Certbot

```bash
sudo apt update
sudo apt install -y certbot python3-certbot-nginx
```

#### Step 2: Create ACME Challenge Directory

```bash
sudo mkdir -p /var/www/certbot
sudo chown -R www-data:www-data /var/www/certbot
```

#### Step 3: Configure Nginx for ACME Challenge

Add this to your current nginx config temporarily:

```nginx
server {
    listen 80;
    server_name simorghai.electrokavir.com;

    location /.well-known/acme-challenge/ {
        root /var/www/certbot;
        allow all;
    }
}
```

Then reload nginx:
```bash
sudo nginx -t && sudo systemctl reload nginx
```

#### Step 4: Obtain Certificate

```bash
sudo certbot certonly \
    --webroot \
    --webroot-path=/var/www/certbot \
    --domain simorghai.electrokavir.com \
    --email admin@electrokavir.com \
    --agree-tos \
    --no-eff-email
```

#### Step 5: Install SSL Configuration

```bash
# Backup current config
sudo cp /etc/nginx/sites-enabled/default /etc/nginx/sites-enabled/default.backup

# Copy SSL config
sudo cp default-ssl.conf /etc/nginx/sites-available/default-ssl
sudo ln -sf /etc/nginx/sites-available/default-ssl /etc/nginx/sites-enabled/default

# Test and reload
sudo nginx -t && sudo systemctl reload nginx
```

#### Step 6: Setup Auto-Renewal

```bash
# Copy renewal hook
sudo cp certbot-renew-hook.sh /etc/letsencrypt/renewal-hooks/deploy/
sudo chmod +x /etc/letsencrypt/renewal-hooks/deploy/certbot-renew-hook.sh

# Test renewal (dry run)
sudo certbot renew --dry-run
```

## Files Overview

| File | Description |
|------|-------------|
| `default.conf` | Current HTTP-only configuration |
| `default-ssl.conf` | HTTPS-enabled configuration with Let's Encrypt |
| `setup-certbot.sh` | Automated setup script |
| `certbot-renew-hook.sh` | Post-renewal hook to reload nginx |

## Verification

After setup, verify HTTPS is working:

```bash
# Check certificate
sudo certbot certificates

# Test HTTPS
curl -I https://simorghai.electrokavir.com

# Check nginx status
sudo systemctl status nginx

# Check certificate expiration
echo | openssl s_client -servername simorghai.electrokavir.com -connect simorghai.electrokavir.com:443 2>/dev/null | openssl x509 -noout -dates
```

## Troubleshooting

### Certificate Issuance Fails

1. **DNS not resolving**: Verify DNS with `nslookup simorghai.electrokavir.com`
2. **Port 80 blocked**: Check firewall rules and ensure port 80 is open
3. **ACME challenge fails**: Verify `/.well-known/acme-challenge/` is accessible

```bash
# Test ACME challenge path
echo "test" | sudo tee /var/www/certbot/.well-known/acme-challenge/test
curl -v http://simorghai.electrokavir.com/.well-known/acme-challenge/test
```

### Nginx Won't Start

```bash
# Check configuration syntax
sudo nginx -t

# Check error logs
sudo tail -f /var/log/nginx/error.log

# Check if port is in use
sudo netstat -tlnp | grep -E ":80|:443"
```

### Certificate Renewal Issues

```bash
# Check renewal status
sudo certbot renew --dry-run

# Check certbot logs
sudo tail -f /var/log/letsencrypt/letsencrypt.log

# Manual renewal
sudo certbot renew --force-renewal
```

## Security Considerations

1. **HSTS**: The configuration includes HSTS header. Once enabled, browsers will only use HTTPS for 2 years.
2. **TLS Versions**: Only TLS 1.2 and 1.3 are enabled (modern security)
3. **Ciphers**: Strong cipher suites are configured
4. **OCSP Stapling**: Enabled for faster certificate validation

## Rollback

If you need to revert to HTTP-only:

```bash
# Restore backup
sudo cp /etc/nginx/sites-enabled/default.backup /etc/nginx/sites-enabled/default
sudo nginx -t && sudo systemctl reload nginx
```

## Environment Variables for Application

After enabling HTTPS, update your `.env` file:

```bash
# Change these in simorgh-agent/.env
SECURE_COOKIES=true
FRONTEND_URL=https://simorghai.electrokavir.com/chatbot
GOOGLE_REDIRECT_URI=https://simorghai.electrokavir.com/chatbot/auth/google/callback
```

## Certificate Locations

After successful setup, certificates are stored at:

```
/etc/letsencrypt/live/simorghai.electrokavir.com/
├── fullchain.pem  # Certificate + intermediate
├── privkey.pem    # Private key
├── cert.pem       # Certificate only
└── chain.pem      # Intermediate certificate
```

## Auto-Renewal

Certbot automatically sets up a systemd timer for renewal. Certificates are checked twice daily and renewed when less than 30 days remain.

```bash
# Check timer status
sudo systemctl list-timers | grep certbot

# View renewal configuration
sudo cat /etc/letsencrypt/renewal/simorghai.electrokavir.com.conf
```
