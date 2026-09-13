import { fileURLToPath } from "node:url";
import { dirname, resolve } from "node:path";
import type { NextConfig } from "next";

const here = dirname(fileURLToPath(import.meta.url));

const config: NextConfig = {
  // The store and the ledger use Node's built-in SQLite, which must not be
  // bundled. Every route that touches them declares `runtime = "nodejs"`.
  serverExternalPackages: ["node:sqlite"],
  // The repo root, not whatever ancestor directory happens to hold a lockfile.
  outputFileTracingRoot: resolve(here, "..", ".."),
};

export default config;
