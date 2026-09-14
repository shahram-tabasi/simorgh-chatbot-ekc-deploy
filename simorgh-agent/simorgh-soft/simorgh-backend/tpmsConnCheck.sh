#!/usr/bin/env bash
# Is the TPMS database reachable from the container, and is it connected now?
#
# Run from simorgh-agent/ (where docker compose is):
#   ./simorgh-soft/simorgh-backend/tpmsConnCheck.sh
#
# Everything is checked from INSIDE the container, because that is the path
# that matters. Testing from the host proves nothing about this problem: the
# MSS clamp lives in the FORWARD chain, which only sees traffic being routed
# through the host — traffic the host itself originates goes through OUTPUT
# and is never clamped. So a working `mysql` or `nc` on the host tells you
# nothing about whether the container's path is fixed.
set -uo pipefail

SVC=${SVC:-simorgh-soft}
HOST=${MYSQL_HOST:-192.168.1.148}
PORT=${MYSQL_PORT:-3306}

# /proc/net/tcp writes addresses as little-endian hex, so 192.168.1.148 is
# 9401A8C0 and 3306 is 0CEA. Matching the hex directly avoids having to decode
# every row back into dotted quad.
KEY=$(printf '%02X%02X%02X%02X:%04X' \
  "$(echo "$HOST" | cut -d. -f4)" "$(echo "$HOST" | cut -d. -f3)" \
  "$(echo "$HOST" | cut -d. -f2)" "$(echo "$HOST" | cut -d. -f1)" "$PORT")

echo
echo "=== TPMS connectivity — ${HOST}:${PORT}, as seen from ${SVC} ==="
echo

echo "[1] can the container open a new connection?"
docker compose exec -T "$SVC" node -e "
const t = Date.now(), s = require('net').connect($PORT, '$HOST');
s.setTimeout(5000);
s.on('connect', () => { console.log('    OPEN      handshake in ' + (Date.now()-t) + 'ms'); s.end(); });
s.on('timeout', () => { console.log('    TIMEOUT   after ' + (Date.now()-t) + 'ms — packets silently dropped (firewall/route)'); s.destroy(); });
s.on('error',   e => console.log('    FAIL      ' + e.code + ' after ' + (Date.now()-t) + 'ms'));
" 2>&1 | grep -v '^$'

echo
echo "[2] sockets to it right now (the app's pool)"
docker compose exec -T "$SVC" cat /proc/net/tcp 2>/dev/null | awk -v key="$KEY" '
  BEGIN { s["01"]="ESTABLISHED"; s["02"]="SYN_SENT";  s["03"]="SYN_RECV";
          s["04"]="FIN_WAIT1";   s["05"]="FIN_WAIT2"; s["06"]="TIME_WAIT";
          s["07"]="CLOSE";       s["08"]="CLOSE_WAIT";s["09"]="LAST_ACK";
          s["0A"]="LISTEN";      s["0B"]="CLOSING";   n=0 }
  NR>1 && toupper($3)==key {
      n++; st=s[toupper($4)]; if (st=="") st=$4;
      split($5, q, ":");
      # A growing rx_queue with nothing draining is data arriving that the app
      # is not reading; a stuck tx_queue is data we cannot get out.
      printf "    %-12s tx_queue=%s rx_queue=%s\n", st, q[1], q[2] }
  END { if (n==0) print "    none — the pool has no connection open at the moment";
        else printf "    %d socket(s) total\n", n }'

echo
echo "[3] is the MSS clamp in place and matching?"
if sudo -n true 2>/dev/null; then
  sudo iptables -t mangle -L FORWARD -n -v 2>/dev/null \
    | awk -v h="$HOST" 'NR<=2 || ($0 ~ /TCPMSS/ && $0 ~ h) { print "    " $0 }'
  echo "    (pkts column counts SYNs actually clamped — 0 means the rule is not"
  echo "     on the path this traffic takes)"
else
  echo "    skipped — needs sudo. Run:"
  echo "      sudo iptables -t mangle -L FORWARD -n -v | grep -E 'TCPMSS|pkts'"
fi

echo
echo "[4] does a large reply survive? (the actual fault)"
docker compose exec -T "$SVC" node -e "
const mysql = require('/app/node_modules/mysql2/promise');
(async () => {
  const c = await mysql.createConnection({
    host: '$HOST', port: $PORT,
    user: process.env.MYSQL_USER || 'technical',
    password: process.env.MYSQL_PASSWORD || 'HoJETA',
    database: process.env.MYSQL_DATABASE || 'TPMS',
    connectTimeout: 10000,
  });
  for (const n of [1300, 1400, 8192, 65536]) {
    const t = Date.now();
    try {
      await c.query({ sql: 'SELECT REPEAT(\"x\", ' + n + ') AS p', timeout: 6000 });
      console.log('    ' + String(n).padStart(6) + ' bytes  ok   ' + (Date.now()-t) + 'ms');
    } catch (e) {
      console.log('    ' + String(n).padStart(6) + ' bytes  FAIL ' + (Date.now()-t) + 'ms  ' + (e.code||e.message));
      await c.destroy(); return;
    }
  }
  await c.end();
  console.log('    → large replies arrive: the clamp is working.');
})().catch(e => console.log('    could not test: ' + (e.code || e.message)));
" 2>&1 | grep -v '^$'
echo
