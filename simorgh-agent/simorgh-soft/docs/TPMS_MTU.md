# When TPMS reads hang for exactly 60 seconds

## The symptom

Every `/api/tpms/*` call answers 500 after exactly `TPMS_QUERY_TIMEOUT_MS`
(60s by default), with the same message in the container log:

```
❌ Error in /api/tpms/projects: Query inactivity timeout
```

Always the full timeout, never less, and never a partial result. Meanwhile
`/api/health` reports `mysql: "connected"` and the Eplanix .NET app, reading
the same database, works perfectly.

## What it is not

Three explanations fit the symptom and all three are wrong. Ruling them out
matters, because each points at a different team:

- **Not a slow view.** `View_Project_Main` is `select … from PROJECT_MAIN` —
  no joins, no subselects, 1756 rows. `COUNT(*)` over it is 3ms.
- **Not the `ORDER BY`.** The C# shape has no sort at all and hangs the same.
- **Not an IP block, and not `max_allowed_packet`.** On one connection the
  handshake, `SELECT 1`, `COUNT(*)` and `LIMIT 1` all succeed in single-digit
  milliseconds. A block refuses the connection; `max_allowed_packet` returns
  an error rather than silence.

The giveaway is on the server: while the client waits, `SHOW PROCESSLIST`
shows our thread at state `-`. An idle thread has already written its answer
out. The rows are not slow to produce — they are failing to arrive.

## What it is

A path-MTU black hole between the container and the TPMS host. The only
variable is the size of the reply:

| reply size | result |
| ---------- | ------ |
| 1300 bytes | ok, 1ms |
| 1400 bytes | never arrives |

`eth0` in the container is MTU 1500, so it advertises MSS 1460 in its SYN and
the server sends full-size segments. Something in the path cannot carry them
and drops them, and the ICMP `fragmentation needed` that would tell TCP to
send smaller segments is dropped too — so the server retransmits the same
oversized segment until mysql2 gives up. Small answers fit in one undersized
segment and get through; 1756 rows do not.

Eplanix does not hit this because it runs on a Windows machine on the flat
LAN. The container reaches TPMS across the Docker bridge — a different path.

## Confirming it

`simorgh-backend/tpmsDoctor.cjs` measures it. It needs no rebuild:

```bash
cd simorgh-agent
docker compose cp simorgh-soft/simorgh-backend/tpmsDoctor.cjs \
  simorgh-soft:/tmp/tpmsDoctor.cjs
docker compose exec simorgh-soft node /tmp/tpmsDoctor.cjs
```

It asks the server for one row of a size it chooses (`SELECT REPEAT('x', n)`),
bisects the point where the answer stops arriving, converts that to a path
MTU, and tests whether large packets fail in one direction or both.

## Fixing it

**Immediately, with no downtime** — clamp the MSS the container advertises,
so the server never sends a segment the path cannot carry. Scoped to the TPMS
host so nothing else is touched:

```bash
sudo iptables -t mangle -I FORWARD -p tcp --syn \
  -d 192.168.1.148 --dport 3306 -j TCPMSS --set-mss 1360
```

MSS 1360 puts the IP packet at 1400, comfortably inside the measured path.
Only new connections are affected, so restart `simorgh-soft` (or just re-run
the doctor, which dials its own) to see the change. To undo, swap `-I` for
`-D`. This rule does not survive a reboot on its own.

**Durably, in this stack** — lower the MTU on `app_net` so every container on
it advertises a smaller MSS:

```yaml
networks:
  app_net:
    name: simorgh_app_net
    driver: bridge
    driver_opts:
      com.docker.network.driver.mtu: "1400"
```

Driver options are fixed when a network is created, so this needs
`docker compose down && docker compose up -d`, not a restart. Note that
`app_net` is declared in ~55 compose fragments; they merge into one network,
but the change is easy to make inconsistently, so grep before editing.

**Properly** — the fault is in the path, not in Docker. Whoever owns the link
between the container network and `192.168.1.x` should stop dropping ICMP
type 3 code 4, or clamp MSS to PMTU on the device in between. Until then,
every host on `app_net` that reads a large result from that subnet is exposed
to this, `svc-eplan-sql` against `192.168.1.39` included.
