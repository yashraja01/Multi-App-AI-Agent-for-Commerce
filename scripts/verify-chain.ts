#!/usr/bin/env tsx
/**
 * Independently verify the ledger chain.
 *
 *   npm run verify                 # verifies ./mercury.db
 *   npm run verify -- other.db     # verifies another file
 *
 * This is the auditability proof. Open the database in any SQLite client, edit
 * a single character of any row, re-run, and this reports the exact sequence
 * number where the record stopped agreeing with itself.
 *
 * Exit codes: 0 = intact, 1 = tampered, 2 = no ledger found.
 */
import { existsSync } from "node:fs";
import { Ledger } from "@mercury/ledger";

const ESC = String.fromCharCode(27);
const useColor = process.stdout.isTTY === true && process.env["NO_COLOR"] === undefined;
const c = (code: string) => (useColor ? `${ESC}[${code}m` : "");

const RESET = c("0");
const RED = c("31");
const GREEN = c("32");
const DIM = c("2");
const BOLD = c("1");

function main(): number {
  const dbPath = process.argv[2] ?? process.env["MERCURY_DB"] ?? "./mercury.db";

  if (!existsSync(dbPath)) {
    console.error(`${RED}No ledger at ${dbPath}${RESET}`);
    console.error(
      `${DIM}Run "npm run seed" first, or pass a path: npm run verify -- path/to.db${RESET}`,
    );
    return 2;
  }

  const ledger = Ledger.open(dbPath);
  try {
    const started = performance.now();
    const result = ledger.verify();
    const ms = (performance.now() - started).toFixed(1);

    console.log(`${BOLD}Ledger chain verification${RESET} ${DIM}(${dbPath})${RESET}`);

    if (result.ok) {
      console.log(
        `${GREEN}  OK${RESET}  ${result.count} entries, chain intact ${DIM}(${ms}ms)${RESET}`,
      );
      if (result.count > 0) {
        console.log(`${DIM}  tip  ${ledger.tipHash()}${RESET}`);
      }
      return 0;
    }

    console.log(`${RED}  BROKEN${RESET}  at seq ${BOLD}${result.broken_at}${RESET} of ${result.count}`);
    console.log(`  reason  ${RED}${result.reason}${RESET}`);
    console.log(`  detail  ${result.detail}`);
    console.log(
      `${DIM}  Entries 1..${result.broken_at - 1} still verify. ` +
        `Everything from ${result.broken_at} on is untrusted.${RESET}`,
    );
    return 1;
  } finally {
    ledger.close();
  }
}

process.exit(main());
