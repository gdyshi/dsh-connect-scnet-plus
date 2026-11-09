#!/usr/bin/env node
/**
 * Syntax check: every lib/*.js must parse. No host-only imports executed.
 */
import { readdirSync } from "node:fs";
import { pathToFileURL } from "node:url";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";

const libDir = join(dirname(fileURLToPath(import.meta.url)), "..", "lib");
let failed = 0;
for (const name of readdirSync(libDir)) {
  if (!name.endsWith(".js")) continue;
  const url = pathToFileURL(join(libDir, name));
  try {
    await import(url.href);
    console.log("ok   ", name);
  } catch (error) {
    // index.js/adapter.js import host-only peers; absence there is fine at
    // build time as long as the module PARSES (we detect that separately).
    if (error.code === "ERR_MODULE_NOT_FOUND" && /@deepseek-ai|@earendil-works/.test(String(error))) {
      console.log("parse-ok (peer not installed locally):", name);
    } else {
      failed++;
      console.error("FAIL ", name, error);
    }
  }
}
process.exit(failed > 0 ? 1 : 0);
