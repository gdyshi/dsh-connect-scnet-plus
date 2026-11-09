#!/usr/bin/env node
/**
 * Automation gate: the automation itself is tested ("workflow as code").
 *
 * DeepSeek Harness tests its own CI with scripts/ci-workflow.spec.ts; for this
 * repository the same idea is compressed into structural assertions:
 *
 * - ci.yml runs the one gate entry point on a Node 22/24 + Ubuntu/Windows
 *   matrix, with least-privilege permissions, a job timeout and
 *   cancel-in-progress concurrency;
 * - release.yml packs the tarball and creates the GitHub Release on v* tags;
 * - dependabot tracks both npm and the actions used above;
 * - AGENTS.md and both AUTOMATION docs stay in sync with the gate registry
 *   imported from scripts/gate.mjs — adding a gate without documenting it
 *   fails here, so the docs cannot drift from the pipeline.
 *
 * Usage: node scripts/verify-automation.mjs
 */

import { existsSync, readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

import { GATES } from "./gate.mjs";

const ROOT = dirname(dirname(fileURLToPath(import.meta.url)));
const errors = [];
const fail = (message) => errors.push(message);

function mustInclude(relativePath, label, pattern) {
  if (!existsSync(join(ROOT, relativePath))) {
    fail(`${relativePath}: missing`);
    return;
  }
  const text = readFileSync(join(ROOT, relativePath), "utf8");
  if (!pattern.test(text)) fail(`${relativePath}: ${label}`);
}

// --- CI workflow ------------------------------------------------------------
const ciPath = ".github/workflows/ci.yml";
const releasePath = ".github/workflows/release.yml";
mustInclude(ciPath, "must be named CI", /^name:\s*CI\s*$/m);
mustInclude(ciPath, "must trigger on push", /^on:\s*$/m);
mustInclude(ciPath, "must trigger on push", /^\s+push:\s*$/m);
mustInclude(ciPath, "must trigger on pull_request", /^\s+pull_request:\s*$/m);
mustInclude(ciPath, "must support workflow_dispatch", /^\s+workflow_dispatch:\s*$/m);
mustInclude(ciPath, "must declare least-privilege permissions", /^permissions:\s*$/m);
mustInclude(ciPath, "must keep contents: read", /^\s+contents:\s*read\s*$/m);
mustInclude(ciPath, "must cancel superseded runs", /^concurrency:\s*$/m);
mustInclude(ciPath, "must cancel superseded runs", /cancel-in-progress:\s*true/);
mustInclude(ciPath, "must bound job time", /timeout-minutes:\s*\d+/);
mustInclude(ciPath, "matrix must not stop siblings", /fail-fast:\s*false/);
mustInclude(ciPath, "must test Node 22 and 24", /node:\s*\[[^\]]*22[^\]]*\]/);
mustInclude(ciPath, "must test Node 22 and 24", /node:\s*\[[^\]]*24[^\]]*\]/);
mustInclude(ciPath, "must test Linux and Windows", /ubuntu-latest/);
mustInclude(ciPath, "must test Linux and Windows", /windows-latest/);
mustInclude(ciPath, "must use actions/checkout", /actions\/checkout@v\d+/);
mustInclude(ciPath, "must use actions/setup-node", /actions\/setup-node@v\d+/);
mustInclude(ciPath, "must upload the gate report", /actions\/upload-artifact@v\d+/);
mustInclude(ciPath, "must upload the report even on failure", /if:\s*always\(\)/);
mustInclude(ciPath, "must run the gate entry point", /npm run gate/);
mustInclude(ciPath, "must write the machine-readable report", /--report\s+gate-report\.json/);

if (existsSync(join(ROOT, ciPath)) && readFileSync(join(ROOT, ciPath), "utf8").includes("pull_request_target")) {
  fail(`${ciPath}: pull_request_target runs untrusted PR code with a write token; use pull_request`);
}

// --- job structure ----------------------------------------------------------
const escapeRegExp = (text) => text.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");

/**
 * Split a workflow into `{ name, text }` job blocks using indentation only.
 * No YAML dependency: every repository job is a two-space-indented key under
 * `jobs:`, and that is all this gate needs to assert per-job invariants.
 */
function jobBlocks(relativePath) {
  const lines = readFileSync(join(ROOT, relativePath), "utf8").split(/\r?\n/);
  const start = lines.findIndex((line) => /^jobs:\s*$/.test(line));
  if (start < 0) return [];
  const jobs = [];
  let current;
  for (let index = start + 1; index < lines.length; index += 1) {
    const line = lines[index];
    if (line.trim() !== "" && !line.startsWith(" ")) break;
    const header = /^ {2}([A-Za-z0-9_-]+):\s*$/.exec(line);
    if (header !== null) {
      if (current !== undefined) jobs.push(current);
      current = { name: header[1], text: "" };
    } else if (current !== undefined) {
      current.text += line + "\n";
    }
  }
  if (current !== undefined) jobs.push(current);
  return jobs;
}

for (const workflow of [ciPath, releasePath]) {
  const jobs = jobBlocks(workflow);
  if (jobs.length === 0) fail(`${workflow}: no jobs found under jobs:`);
  for (const job of jobs) {
    if (!/timeout-minutes:\s*\d+/.test(job.text)) fail(`${workflow}: job "${job.name}" has no timeout-minutes`);
  }
}

const verdict = jobBlocks(ciPath).find((job) => job.name === "all-checks-passed");
if (verdict === undefined) {
  fail(`${ciPath}: missing the stable verdict job "all-checks-passed"`);
} else {
  if (!/^\s+name:\s*all checks passed\s*$/m.test(verdict.text)) fail(`${ciPath}: verdict job must be named "all checks passed"`);
  if (!/^\s+needs:\s*\[gates\]\s*$/m.test(verdict.text)) fail(`${ciPath}: verdict job must need [gates]`);
  if (!/if:\s*\$\{\{\s*always\(\)\s*\}\}/.test(verdict.text)) {
    fail(`${ciPath}: verdict job must use if: always() (a skipped required check is reported as success)`);
  }
}

// --- release workflow -------------------------------------------------------
mustInclude(releasePath, "must be named Release", /^name:\s*Release\s*$/m);
mustInclude(releasePath, "must trigger on v* tags", /tags:\s*\[?\s*["']v\*["']/);
mustInclude(releasePath, "must be allowed to write a release", /^permissions:\s*$/m);
mustInclude(releasePath, "must be allowed to write a release", /^\s+contents:\s*write\s*$/m);
mustInclude(releasePath, "must run the gates before publishing", /npm run gate/);
mustInclude(releasePath, "must verify the tag matches the package version", /tag .*package version|GITHUB_REF_NAME/);
mustInclude(releasePath, "must build the tarball", /npm pack/);
mustInclude(releasePath, "must create the GitHub Release", /gh release create/);

// --- dependabot -------------------------------------------------------------
mustInclude(".github/dependabot.yml", "must declare configuration version 2", /^version:\s*["']?2["']?\s*$/m);
mustInclude(".github/dependabot.yml", "must track npm dependencies", /package-ecosystem:\s*["']?npm["']?/);
mustInclude(".github/dependabot.yml", "must track GitHub Actions", /package-ecosystem:\s*["']?github-actions["']?/);

// --- agent contract ---------------------------------------------------------
mustInclude("AGENTS.md", "must document the single gate command", /npm run gate/);
mustInclude("AGENTS.md", "must point at the gate runner", /scripts\/gate\.mjs/);
mustInclude("AGENTS.md", "must forbid committing the gate report", /gate-report\.json/);

// --- package scripts --------------------------------------------------------
const packageJson = JSON.parse(readFileSync(join(ROOT, "package.json"), "utf8"));
const scripts = packageJson.scripts ?? {};
const expectedScripts = {
  gate: "node scripts/gate.mjs",
  "gate:fast": "node scripts/gate.mjs --lane fast",
  "gate:list": "node scripts/gate.mjs --list",
  "verify:docs": "node scripts/verify-docs.mjs",
  "verify:package": "node scripts/verify-package.mjs",
  "verify:manifest": "node scripts/verify-manifest.mjs",
  "verify:automation": "node scripts/verify-automation.mjs"
};
for (const [name, command] of Object.entries(expectedScripts)) {
  if (scripts[name] !== command) fail(`package.json: scripts.${name} must be "${command}" (got ${scripts[name]})`);
}
if (scripts.check !== "node scripts/gate.mjs") fail("package.json: scripts.check must alias the gate entry point");

// --- docs must describe every registered gate ------------------------------
for (const docPath of ["docs/AUTOMATION.md", "docs/AUTOMATION.zh.md"]) {
  if (!existsSync(join(ROOT, docPath))) {
    fail(`${docPath}: missing`);
    continue;
  }
  const text = readFileSync(join(ROOT, docPath), "utf8");
  for (const gate of GATES) {
    // The table row is the contract: name, script and lane must all match the
    // registry, so a renamed script or a moved gate cannot stay documented.
    const row = new RegExp(
      `^\\|\\s*${escapeRegExp(gate.name)}\\s*\\|\\s*\`${escapeRegExp(gate.script)}\`\\s*\\|[^\\n]*\\|\\s*${escapeRegExp(gate.lane)}\\s*\\|\\s*$`,
      "m"
    );
    if (!row.test(text)) fail(`${docPath}: gate row for "${gate.name}" must list ${gate.script} and lane ${gate.lane}`);
  }
  const rows = text.match(/^\|\s*[a-z][a-z0-9-]*\s*\|\s*`scripts\//gm) ?? [];
  if (rows.length !== GATES.length) fail(`${docPath}: ${rows.length} gate rows, registry has ${GATES.length}`);
  for (const flag of ["--list", "--only", "--lane fast", "--report"]) {
    if (!text.includes(flag)) fail(`${docPath}: does not document ${flag}`);
  }
}
for (const gate of GATES) {
  if (!existsSync(join(ROOT, gate.script))) fail(`gate registry: ${gate.name} points at missing ${gate.script}`);
}

if (errors.length > 0) {
  for (const error of errors) console.error("FAIL", error);
  console.error(`\n${errors.length} automation error(s)`);
  process.exit(1);
}
console.log(`PASS automation: CI + release + dependabot wired, ${GATES.length} gates documented and registered`);
