#!/usr/bin/env node
/**
 * Single gate entry point for this repository.
 *
 * Why one entry point: local runs and CI runs must execute exactly the same
 * checks, in the same order, with the same meaning of "green". If CI had its
 * own list, the two would drift and a local `check` would stop predicting CI.
 * This is the pattern DeepSeek Harness uses (`scripts/run-gates.ts`): one
 * registry, lanes, per-gate budgets, machine-readable report.
 *
 * Adding a gate means editing GATES below (and adding it to
 * docs/AUTOMATION*.md). `verify-automation.mjs` fails when the two drift.
 *
 * Usage:
 *   node scripts/gate.mjs                 # every gate
 *   node scripts/gate.mjs --lane fast     # fast/local lane only
 *   node scripts/gate.mjs --only docs     # one gate (comma separated)
 *   node scripts/gate.mjs --list          # show the registry
 *   node scripts/gate.mjs --report out.json
 *   node scripts/gate.mjs --bail          # stop at the first failure
 *
 * Exit codes: 0 all green, 1 at least one gate failed/timed out, 2 usage error.
 *
 * Invariants every gate keeps:
 * - no network access (except loopback mock servers the test itself starts);
 * - never reads real scnet credentials or ~/.sclaw; tests use temp dirs;
 * - runs on a bare checkout: no `npm install`, no host peer packages needed;
 * - prints its own PASS/FAIL lines and exits non-zero on failure.
 */

import { spawn } from "node:child_process";
import { mkdirSync, writeFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

const ROOT = dirname(dirname(fileURLToPath(import.meta.url)));

/**
 * The gate registry. `lane: "fast"` is what a developer runs before every
 * commit; `slow` gates add packaging/workflow checks and are always part of
 * CI. Keep the total fast lane under a minute.
 */
export const GATES = [
  {
    name: "syntax",
    lane: "fast",
    script: "scripts/check-syntax.mjs",
    timeoutMs: 60_000,
    about: "lib/*.js 均可解析（宿主 peer 未安装时按 parse-ok 处理）"
  },
  {
    name: "unit",
    lane: "fast",
    script: "scripts/selftest.mjs",
    timeoutMs: 120_000,
    about: "凭据发现 / 模型目录 / 选择语义 / loopback shim（26 项）"
  },
  {
    name: "replay",
    lane: "fast",
    script: "scripts/replay-semantics.test.mjs",
    timeoutMs: 30_000,
    about: "跨 provider 历史重放语义（thinking 丢弃、同路由保留）"
  },
  {
    name: "rescue",
    lane: "fast",
    script: "scripts/context-rescue.test.mjs",
    timeoutMs: 60_000,
    about: "上下文溢出救援：折叠预算、收缩、去重、旁路（纯内存）"
  },
  {
    name: "pi-ai",
    lane: "fast",
    script: "scripts/pi-ai-runtime.test.mjs",
    timeoutMs: 30_000,
    about: "pi-ai 世代判定与 transcript 折叠/展开（0.82 与 1.x 两代形状）"
  },
  {
    name: "docs",
    lane: "fast",
    script: "scripts/verify-docs.mjs",
    timeoutMs: 60_000,
    about: "Markdown 链接 / 锚点 / 双语配对 / 文档预算"
  },
  {
    name: "manifest",
    lane: "fast",
    script: "scripts/verify-manifest.mjs",
    timeoutMs: 30_000,
    about: "cordis.patch.yml、locale 双语键、package 元数据一致性"
  },
  {
    name: "pack",
    lane: "slow",
    script: "scripts/verify-package.mjs",
    timeoutMs: 120_000,
    about: "npm pack 文件清单 / 导出目标 / 依赖与版本约束"
  },
  {
    name: "automation",
    lane: "slow",
    script: "scripts/verify-automation.mjs",
    timeoutMs: 60_000,
    about: "CI、发布、dependabot 结构自测；文档与门禁注册表同步"
  }
];

function usage(error) {
  if (error) console.error(`error: ${error}\n`);
  console.error("usage: node scripts/gate.mjs [--lane fast|slow|all] [--only a,b] [--list] [--report <file>] [--bail]");
  process.exit(2);
}

function parseArgs(argv) {
  const options = { lane: "all", only: [], list: false, report: undefined, bail: false };
  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index];
    if (arg === "--list") options.list = true;
    else if (arg === "--bail") options.bail = true;
    else if (arg === "--lane") {
      const value = argv[++index];
      if (value === undefined || !["fast", "slow", "all"].includes(value)) usage(`--lane expects fast|slow|all, got ${value ?? "(nothing)"}`);
      options.lane = value;
    } else if (arg === "--only") {
      const value = argv[++index];
      if (value === undefined) usage("--only expects a comma separated gate list");
      options.only.push(...value.split(",").map((name) => name.trim()).filter(Boolean));
    } else if (arg === "--report") {
      const value = argv[++index];
      if (value === undefined) usage("--report expects a file path");
      options.report = value;
    } else if (arg === "--help" || arg === "-h") usage();
    else usage(`unknown argument: ${arg}`);
  }
  return options;
}

function selectGates(options) {
  if (options.only.length > 0) {
    const known = new Set(GATES.map((gate) => gate.name));
    const unknown = options.only.filter((name) => !known.has(name));
    if (unknown.length > 0) usage(`unknown gate(s): ${unknown.join(", ")}; see --list`);
    return GATES.filter((gate) => options.only.includes(gate.name));
  }
  if (options.lane === "all") return GATES;
  return GATES.filter((gate) => gate.lane === options.lane);
}

function listGates() {
  const width = Math.max(...GATES.map((gate) => gate.name.length));
  console.log("gate       lane  budget  script");
  console.log("-".repeat(72));
  for (const gate of GATES) {
    console.log(`${gate.name.padEnd(width)}  ${gate.lane.padEnd(4)}  ${String(gate.timeoutMs / 1000 + "s").padEnd(6)}  ${gate.script}`);
  }
}

/** Run one gate as a child process; inherit stdio so its PASS/FAIL lines stream. */
function runGate(gate) {
  return new Promise((resolvePromise) => {
    const startedAt = Date.now();
    const child = spawn(process.execPath, [gate.script], {
      cwd: ROOT,
      stdio: "inherit",
      timeout: gate.timeoutMs,
      env: {
        ...process.env,
        // Gates must not consult an interactive terminal or a developer's TTY.
        CI: process.env.CI ?? "1",
        DSH_GATE: gate.name
      }
    });
    child.on("error", (error) => {
      resolvePromise({ name: gate.name, lane: gate.lane, about: gate.about, status: "fail", code: null, signal: null, ms: Date.now() - startedAt, error: String(error) });
    });
    child.on("exit", (code, signal) => {
      const ms = Date.now() - startedAt;
      let status = "pass";
      if (signal !== null) status = signal === "SIGTERM" ? "timeout" : "fail";
      else if (code !== 0) status = "fail";
      resolvePromise({ name: gate.name, lane: gate.lane, about: gate.about, status, code, signal, ms });
    });
  });
}

function printSummary(results, totalMs) {
  console.log("\n=== gate summary ===");
  const nameWidth = Math.max(6, ...results.map((result) => result.name.length));
  for (const result of results) {
    const budget = result.status === "timeout" ? ` (budget ${GATES.find((gate) => gate.name === result.name)?.timeoutMs / 1000}s)` : "";
    console.log(`${result.status.toUpperCase().padEnd(8)} ${result.name.padEnd(nameWidth)} ${String(result.ms + "ms").padStart(8)}${budget}`);
  }
  const passed = results.filter((result) => result.status === "pass").length;
  const failed = results.filter((result) => result.status !== "pass").length;
  console.log(`\n${passed} passed, ${failed} failed, total ${totalMs}ms (node ${process.version}, ${process.platform})`);
}

function writeReport(path, results, totalMs) {
  const report = {
    schema: 1,
    tool: "scripts/gate.mjs",
    node: process.version,
    platform: process.platform,
    startedAt: new Date(Date.now() - totalMs).toISOString(),
    finishedAt: new Date().toISOString(),
    totalMs,
    passed: results.filter((result) => result.status === "pass").length,
    failed: results.filter((result) => result.status !== "pass").length,
    gates: results
  };
  const absolute = resolve(ROOT, path);
  mkdirSync(dirname(absolute), { recursive: true });
  writeFileSync(absolute, JSON.stringify(report, null, 2) + "\n");
  console.log(`report: ${absolute}`);
}

async function main() {
  const options = parseArgs(process.argv.slice(2));
  if (options.list) {
    listGates();
    return 0;
  }
  const gates = selectGates(options);
  if (gates.length === 0) usage(`no gates selected for lane=${options.lane}`);
  console.log(`running ${gates.length} gate(s) from ${ROOT}\n`);
  const startedAt = Date.now();
  const results = [];
  for (const gate of gates) {
    console.log(`\n--- gate: ${gate.name} (${gate.script}, budget ${gate.timeoutMs / 1000}s) ---`);
    const result = await runGate(gate);
    results.push(result);
    if (result.status !== "pass" && options.bail) break;
  }
  const totalMs = Date.now() - startedAt;
  printSummary(results, totalMs);
  if (options.report !== undefined) writeReport(options.report, results, totalMs);
  return results.every((result) => result.status === "pass") ? 0 : 1;
}

// Only run when executed directly; verify-automation.mjs imports GATES.
if (process.argv[1] !== undefined && pathToFileURL(resolve(process.argv[1])).href === import.meta.url) {
  main().then((code) => {
    process.exitCode = code;
  }, (error) => {
    console.error(error);
    process.exitCode = 1;
  });
}
