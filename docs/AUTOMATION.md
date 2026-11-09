# Automation and quality gates

The automation in this repository borrows the engineering practices of
[DeepSeek Harness](https://github.com/deepseek-ai/deepseek-harness): a single gate
entry point (`scripts/run-gates.ts`), workflows that are themselves tested
(`scripts/ci-workflow.spec.ts`), docs-as-code checks (`verify-md-links`,
`verify-doc-budgets`), and separate permission/concurrency models for CI and
release. It is scaled down to a single-package, pure-ESM, build-less repository.

There is one rule: **local runs and CI runs use the same entry point and the same
gate registry.**

## One command

```sh
npm run gate                        # every gate (CI runs this)
npm run gate -- --lane fast         # pre-commit lane: no pack / automation
npm run gate -- --list              # print the gate registry
npm run gate -- --only docs,manifest # run selected gates (debugging)
npm run gate -- --report gate-report.json  # also write a machine-readable report (CI artifact)
npm run gate -- --bail              # stop at the first failure (CI saves minutes; local reports all by default)
```

Exit codes: `0` all green, `1` failure or timeout, `2` usage error.

## Gate registry

| Gate | Script | What it checks | Lane |
|---|---|---|---|
| syntax | `scripts/check-syntax.mjs` | every `lib/*.js` and `scripts/*.mjs` with `node --check` (parse only, never executes), plus static validation that relative imports point at real files | fast |
| unit | `scripts/selftest.mjs` | credential discovery, catalog and selection semantics, loopback shim behaviour (26 assertions) | fast |
| replay | `scripts/replay-semantics.test.mjs` | cross-provider history replay: own `dsh-foreign` identity repair, foreign thinking dropped, same-route kept, deformed shapes hardened | fast |
| rescue | `scripts/context-rescue.test.mjs` | context-overflow rescue: fold budget, tail shrinking, per-session de-duplication, bypass conditions, error event forwarded unchanged | fast |
| docs | `scripts/verify-docs.mjs` | relative links and `#anchors`, code-fence balance, English/Chinese heading parity, README and detail-doc budgets | fast |
| manifest | `scripts/verify-manifest.mjs` | `package.json` / `cordis.patch.yml` / `locale/*.json` agreement (id, name, meta.detail, locale key sets) | fast |
| pack | `scripts/verify-package.mjs` | `exports`/`files` point at real files, dependencies pinned, real `npm pack` file list matches the version | slow |
| automation | `scripts/verify-automation.mjs` | structural self-test of CI / release / dependabot; gate table in the docs matches the `GATES` registry | slow |

When you add or rename a gate, both this document and `docs/AUTOMATION.zh.md` must
change too, or the `automation` gate fails.

Invariants every gate keeps:

- **zero dependencies**: Node builtins only; runs on a bare checkout, no `npm install` needed;
- **hermetic**: no network, no `~/.sclaw`, no machine-specific paths; credentials and directories are constructed in temp dirs;
- **diagnosable**: each script prints `PASS`/`FAIL` lines and signals through its exit code; `gate.mjs` reports status and duration.

## Design principles (borrowed from DSH)

1. **One entry point.** `gate` is the only public gate entry (`gate:fast` / `gate:list` are thin aliases); CI calls the same name. A local green therefore predicts a CI green.
2. **Fast and slow lanes.** `--lane fast` is the seconds-level pre-commit check; slow checks (`pack`, `automation`) stay in the full lane and CI. Hooks only do what fails fast — slow hooks get bypassed.
3. **The workflow is tested.** Workflows are the only code nobody compiles, so `verify-automation` asserts triggers, matrix, permissions, concurrency, timeouts, and that the docs still match the registry.
4. **Failures are reported completely.** All gates run before the summary by default; killed or timed-out gates are failures, never passes (DSH explicitly handles "a killed Windows process is indistinguishable from a failed one").
5. **Determinism.** `package-lock.json` is committed and CI installs with `npm ci --ignore-scripts`; tests never read real credentials or use the network.
6. **Least privilege.** CI declares `permissions: contents: read`; only the release workflow gets `contents: write`.
7. **One stable required check.** Branch protection references `all checks passed`, not matrix leg names that change with the matrix.
8. **Timeouts and concurrency.** Every job has `timeout-minutes`; validation runs cancel superseded runs, release runs never cancel.
9. **Docs are code.** Links, anchors, pairing and budgets are machine-checked; documentation rot is gradual and only mechanical checks stop it.
10. **Release is its own lane.** A `v*` tag triggers `release.yml`, which re-runs the gates, packs the tarball and creates the GitHub Release.

## CI and release

`.github/workflows/ci.yml` (the only validation workflow):

- triggers: `push` to `main`, `pull_request`, `workflow_dispatch`;
- matrix: Node `22.19.0` (the engines floor) and `24.x` × Ubuntu and Windows, `fail-fast: false`;
- steps: `actions/checkout@v4` (`persist-credentials: false`) → `actions/setup-node@v4` (npm cache) → `npm ci` → `npm run gate -- --report gate-report.json` → upload the report artifact (`if: always()`);
- verdict job `all checks passed`: fails when any leg failed, was cancelled or was skipped, so branch protection can require a single stable name.

`.github/workflows/release.yml`: triggered by `v*` tags, `contents: write`, concurrency
never cancelled; it re-runs the gates, checks the tag matches the `package.json` version,
runs `npm pack` and `gh release create` with the tarball.

`.github/dependabot.yml`: weekly npm and GitHub Actions updates, reviewed through the same PR gates.

## Adding a gate

1. Write a zero-dependency script (`scripts/verify-*.mjs` or `*.test.mjs`): print `PASS`/`FAIL`, exit `1` on failure, keep runtime bounded.
2. Register it in `GATES` in `scripts/gate.mjs`: `name`, `lane`, `script`, `timeoutMs`, `about`.
3. Add a row to the table in `docs/AUTOMATION.zh.md` and this document.
4. Verify locally: `npm run gate -- --only <name>` and then `npm run gate`.
5. After pushing, check that CI's `all checks passed` is green; add the new artifact to `ci.yml` if needed.

If a gate needs an external tool or the network, keep it out of the `fast` lane and out of
CI by default — first make it reproducible on a bare checkout.

## Troubleshooting

- **A gate fails**: reproduce with `npm run gate -- --only <name>`; use `--report gate-report.json` to inspect `gates[].status` and durations.
- **`npm run gate` passes but CI fails**: suspect platform differences (path separators, `USERPROFILE`); the commands are identical, so the difference is Node version or OS.
- **docs gate reports `missing anchor`**: anchors come from heading slugs; update the link whenever a heading changes.
- **pack gate reports a missing file**: the tarball is defined by the `files` whitelist; a new runtime file must be added there and to the `required` list.
- **Release workflow did not run**: it only triggers on `v*` tags; ordinary pushes only run CI.

## Deliberately not adopted

These DSH mechanisms target a pnpm monorepo / TypeScript / paid multi-platform runners and
are intentionally absent here: pnpm workspaces and `workspace:*`, `tsc -b` project
references, per-file 100% coverage, coverage sharding and duration-history caches, i18n
sidecars (`.i18n.yaml`), self-hosted runner failover, Wine packaging, and
`pull_request_target` triggers.
