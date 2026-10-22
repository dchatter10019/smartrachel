#!/usr/bin/env bash
# Offline tests for the Voiceflow functions + prompt (change set 2026-10-21).
# LIVE=0 ./run-tests.sh skips the live-catalog BuildPackage tests (read-only searches on api.getbevvi.com).
cd "$(dirname "$0")" && fail=0
for t in test/parse-request.test.mjs test/search-products.test.mjs test/build-package.test.mjs test/prompt.test.mjs; do
  node "$t" || fail=1; echo
done
[ $fail -eq 0 ] && echo "VOICEFLOW TESTS OK" || echo "VOICEFLOW TESTS FAILED"
exit $fail
