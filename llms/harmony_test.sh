#!/usr/bin/env bash
# Spin up the side-by-side Harmony tool-calling vLLM server on .61, probe
# it with a realistic CoT-shaped request, print a verdict.
#
# Run on .61 from the llms/ directory:
#   chmod +x harmony_test.sh
#   ./harmony_test.sh

set -euo pipefail
cd "$(dirname "$0")"

YML=docker-compose.harmony-test.yml
PAYLOAD=harmony_test_payload.json

echo "=== 1. Bringing up vLLM Harmony server on port 9001 (parallel to ai_service) ==="
docker compose -f "$YML" up -d

echo
echo "=== 2. Waiting for /health to return 200 (model load is ~2-4 min) ==="
for i in $(seq 1 120); do
    if curl -fsS http://127.0.0.1:9001/health >/dev/null 2>&1; then
        echo "  ready after ${i}*5s"
        break
    fi
    sleep 5
    [ "$i" = 120 ] && { echo "  TIMEOUT — check logs: docker logs ai_service_harmony"; exit 1; }
done

echo
echo "=== 3. Probing with the CoT-shaped tool-call payload ==="
RESPONSE=$(curl -fsS -X POST http://127.0.0.1:9001/v1/chat/completions \
    -H 'Content-Type: application/json' \
    -d @"$PAYLOAD")
echo "$RESPONSE" | python3 -m json.tool

echo
echo "=== 4. Verdict ==="
TOOL_CALLS=$(echo "$RESPONSE" | python3 -c '
import json, sys
d = json.load(sys.stdin)
tc = d["choices"][0]["message"].get("tool_calls") or []
if tc:
    print(f"PASS: model emitted {len(tc)} tool_call(s)")
    for c in tc:
        print(f"  - {c['function']['name']}({c['function']['arguments']})")
else:
    content = d["choices"][0]["message"].get("content") or ""
    print("FAIL: no tool_calls — model wrote a direct text response instead.")
    print(f"  finish_reason: {d['choices'][0].get('finish_reason')}")
    print(f"  content (first 300 chars): {content[:300]}")
')
echo "$TOOL_CALLS"

echo
echo "If the verdict was PASS, gpt-oss + Harmony works — we can wire the"
echo "agent to use this endpoint instead of guided_json."
echo
echo "If FAIL, the model still produced a direct response despite Harmony's"
echo "native tool-call channel being enabled — that's strong evidence gpt-oss"
echo "isn't the right planner regardless of the integration."
echo
echo "Tear down with:  docker compose -f $YML down"
