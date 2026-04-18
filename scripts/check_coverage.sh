#!/usr/bin/env bash
set -euo pipefail

rm -rf .coverage
trap 'rm -rf .coverage' EXIT

deno test --allow-all --coverage=.coverage

report=$(NO_COLOR=1 deno coverage .coverage)
echo "$report"

echo "$report" | grep "All files" | grep -qE '100\.0.*100\.0.*100\.0' || {
    echo "FAIL: coverage below 100%"
    exit 1
}
