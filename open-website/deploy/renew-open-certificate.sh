#!/bin/sh
set -eu
# Certbot invokes this only after a successful certificate renewal.
if [ "${RENEWED_LINEAGE:-}" = "/etc/letsencrypt/live/open.reai.com" ]; then
    /usr/sbin/nginx -t
    /bin/systemctl reload nginx
fi
