/**
 * Read-only credential discovery for the SCNet (超算互联网) client.
 *
 * Sources, in priority order:
 *   1. explicit `apiKey` from plugin config
 *   2. `SCNET_API_KEY` environment variable
 *   3. every `type: "api_key"` entry found in `~/.sclaw/agent/scnet-credentials/*.json`
 *
 * STRICTLY READ-ONLY: nothing in this module ever writes to the scnet
 * client's files, the sclaw directory, or any host config.
 */

import { readdir, readFile } from "node:fs/promises";
import { homedir } from "node:os";
import { join } from "node:path";

export const SCNET_CREDENTIALS_DIR = join(homedir(), ".sclaw", "agent", "scnet-credentials");

/** Never render a full key: first 6 chars + "…" + last 4. */
export function maskKey(key) {
  if (typeof key !== "string" || key.length < 12) return "(hidden)";
  return `${key.slice(0, 6)}…${key.slice(-4)}`;
}

/** True when the value looks like a usable scnet key. */
function isUsableKey(key) {
  return typeof key === "string" && key.length > 0;
}

/**
 * Scan the sclaw credentials directory.
 * @returns {Promise<Array<{file: string, key: string}>>} every api_key entry found.
 */
export async function scanCredentialFiles(dir = SCNET_CREDENTIALS_DIR) {
  let names;
  try {
    names = await readdir(dir);
  } catch {
    return [];
  }
  const found = [];
  for (const name of names) {
    if (!name.toLowerCase().endsWith(".json")) continue;
    let parsed;
    try {
      parsed = JSON.parse(await readFile(join(dir, name), "utf8"));
    } catch {
      continue;
    }
    collectKeys(parsed, found, name);
  }
  return found;
}

/** Walk an unknown credential-document shape collecting `type === "api_key"` entries. */
function collectKeys(node, found, file) {
  if (Array.isArray(node)) {
    for (const entry of node) collectKeys(entry, found, file);
    return;
  }
  if (node === null || typeof node !== "object") return;
  if (node.type === "api_key" && isUsableKey(node.key)) {
    found.push({ file, key: node.key });
    return;
  }
  for (const value of Object.values(node)) {
    if (value !== null && typeof value === "object") collectKeys(value, found, file);
  }
}

/**
 * Resolve the credential set.
 * @param {{apiKey?: string, env?: Record<string, string|undefined>, dir?: string}} [options]
 * @returns {Promise<{source: "config"|"env"|"files"|"none", accounts: Array<{file: string, key: string}>}>}
 */
export async function discoverCredentials(options = {}) {
  const manual = typeof options.apiKey === "string" ? options.apiKey.trim() : "";
  if (manual !== "") {
    return { source: "config", accounts: [{ file: "(config)", key: manual }] };
  }
  const env = options.env ?? process.env;
  const fromEnv = typeof env.SCNET_API_KEY === "string" ? env.SCNET_API_KEY.trim() : "";
  if (fromEnv !== "") {
    return { source: "env", accounts: [{ file: "(env:SCNET_API_KEY)", key: fromEnv }] };
  }
  const accounts = await scanCredentialFiles(options.dir);
  if (accounts.length === 0) return { source: "none", accounts: [] };
  return { source: "files", accounts };
}

/** The key currently serving traffic: the first discovered one. */
export function primaryKey(discovered) {
  return discovered.accounts[0]?.key;
}
