#!/usr/bin/env bash
# Pre-commit safety check for the Worker. Run from worker/: bash scripts/check.sh
set -u
f="src/index.js"; fail=0
if grep -q "sk-ant-" "$f"; then echo "FAIL: hardcoded sk-ant- key found in $f"; fail=1; else echo "OK  : no sk-ant- in $f"; fi
if grep -q "PLACEHOLDER - replace" "$f"; then echo "FAIL: $f is still the placeholder"; fail=1; fi
if grep -q "env.CLAUDE_API_KEY" "$f"; then echo "OK  : reads env.CLAUDE_API_KEY"; else echo "FAIL: env.CLAUDE_API_KEY not used"; fail=1; fi
if grep -q "env.ANTHROPIC_API_KEY" "$f"; then echo "FAIL: old env.ANTHROPIC_API_KEY still referenced"; fail=1; fi
if [ -f ".dev.vars" ] && git ls-files --error-unmatch .dev.vars >/dev/null 2>&1; then echo "FAIL: .dev.vars is tracked by git"; fail=1; else echo "OK  : .dev.vars not tracked"; fi
if command -v node >/dev/null; then
  if node --check "$f" 2>/dev/null || node --input-type=module --check < "$f" 2>/dev/null; then echo "OK  : syntax"; else echo "FAIL: syntax error in $f"; fail=1; fi
fi
[ $fail -eq 0 ] && echo "ALL CHECKS PASSED" || { echo "FIX THE ABOVE BEFORE COMMIT"; exit 1; }
