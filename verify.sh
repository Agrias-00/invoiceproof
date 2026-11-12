#!/bin/sh
set -eu
ROOT=$(CDPATH= cd -- "$(dirname -- "$0")" && pwd)
mkdir -p "$ROOT/verification"
(cd "$ROOT/offline-core" && node --test --test-reporter=tap core.test.ts) > "$ROOT/verification/core.tap" 2> "$ROOT/verification/core.stderr"
(cd "$ROOT/offline-ui" && node --test --test-reporter=tap model.test.cjs app.test.cjs) > "$ROOT/verification/original-ui.tap" 2> "$ROOT/verification/original-ui.stderr"
(cd "$ROOT/offline-ledger" && node --test --test-reporter=tap ledger.test.ts recovery.test.ts) > "$ROOT/verification/ledger-migration.tap" 2> "$ROOT/verification/ledger-migration.stderr"
(cd "$ROOT/local-app" && node --test --test-reporter=tap integration.test.ts contract.test.ts flow.test.ts proof.test.ts draft-lines.test.ts audit-lines.test.ts answer-checks.test.ts model-endpoint.test.ts sandbox.test.ts) > "$ROOT/verification/http-contract-recovery.tap" 2> "$ROOT/verification/http-contract-recovery.stderr"
for file in offline-ledger/ledger.ts offline-ledger/recovery.test.ts offline-ledger/migration-worker.ts local-app/server.ts local-app/start.ts local-app/paypal-contract.ts local-app/integration.test.ts local-app/contract.test.ts integrated-ui/client.js integrated-ui/app.js integrated-ui/flow.js integrated-ui/proof.js local-app/proof-store.ts local-app/audit-lines.ts local-app/answer-question.ts local-app/answer-checks.ts local-app/model-endpoint.ts local-app/paypal-sandbox.ts; do
  node --check "$ROOT/$file"
done
printf 'PASS: offline core, baseline UI, ledger/migration, loopback HTTP/DOM, contract/recovery, draft/review/proof flow suites. Check verification TAP counts. No real browser or provider API tested.\n'
