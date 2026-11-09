#!/usr/bin/env node
/**
 * dsh-connect-scnet-plus doctor CLI — prints the diagnostic document as JSON.
 * Standalone: imports no host-only peers.
 */
import { runDoctor } from "./doctor.js";

const report = await runDoctor();
console.log(JSON.stringify(report, null, 2));
process.exit(report.ok ? 0 : 1);
