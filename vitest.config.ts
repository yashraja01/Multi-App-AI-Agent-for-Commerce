import { fileURLToPath } from "node:url";
import { defineConfig } from "vitest/config";

export default defineConfig({
  resolve: {
    alias: {
      // `server-only` throws when imported outside a React Server Component.
      // The web app's lib modules carry it as a guard against being bundled
      // for the browser; under vitest they are plain Node modules, so the
      // marker resolves to its own empty build instead.
      "server-only": fileURLToPath(new URL("./node_modules/server-only/empty.js", import.meta.url)),
    },
  },
  test: {
    include: ["packages/**/*.test.ts", "apps/**/*.test.ts", "scripts/**/*.test.ts"],
    environment: "node",
    // The Gate property tests run thousands of cases, each verifying a real
    // Ed25519 signature. That is deliberate -- the gate is the thing that must
    // not be wrong -- and it needs more than the 5s default.
    testTimeout: 60_000,
    globals: false,
    reporters: ["default"],
  },
});
