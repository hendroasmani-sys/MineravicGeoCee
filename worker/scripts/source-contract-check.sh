#!/usr/bin/env bash
set -euo pipefail
f="worker/src/index.js"
ui="index.html"
fail=0
check() {
  local label="$1"; shift
  if "$@"; then printf 'PASS: %s\n' "$label"; else printf 'FAIL: %s\n' "$label"; fail=1; fi
}
check "payload validator is present" grep -q 'function validatePayload' "$f"
check "payload validation precedes provider call" bash -c '[[ "$(grep -n "validatePayload(body)" "$1" | cut -d: -f1)" -lt "$(grep -n "api.anthropic.com/v1/messages" "$1" | cut -d: -f1)" ]]' _ "$f"
check "origin reflection removed" bash -c '! grep -q "Access-Control-Allow-Origin.*requestOrigin" "$1"' _ "$f"
check "provider raw error details are not returned" bash -c '! grep -q "detail: errText" "$1"' _ "$f"
check "model output schema validator exists" grep -q 'function validateModelOutput' "$f"
check "missing geology instruction exists" grep -q 'potensi geologi belum dapat dinilai secara memadai' "$f"
check "unknown WIUP does not default to free" grep -q 'BELUM DIKETAHUI — data tidak cukup' "$f"
check "frontend qualifies WIUP status" grep -q 'status hukum belum terverifikasi' "$ui"
check "frontend does not assert scoring is fully accurate" bash -c '! grep -q "semua data scoring di atas sudah akurat dari database ESDM" "$1"' _ "$ui"
if [ "$fail" -eq 0 ]; then echo "ALL SOURCE CONTRACT CHECKS PASSED"; else exit 1; fi
