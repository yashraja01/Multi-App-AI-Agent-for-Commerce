import { readFileSync, writeFileSync } from "node:fs";
import type { SeededPrincipal } from "./mandates.js";

/**
 * The buyer's wallet.
 *
 * Seeding mints a fresh delegated keypair per mandate, so anything that
 * re-seeds -- the CLI script *or* Mission Control's Reset button -- invalidates
 * every key a buyer was holding. Both paths write this file for exactly that
 * reason: a wallet that silently stops matching the mandates is a confusing
 * failure, and the fix is to keep the two in one place rather than to remember.
 *
 * These are private keys. They are a buyer's, not the merchant's; Mercury
 * verifies against the public half named inside the signed mandate and never
 * needs the private one. The file is git-ignored.
 */

export const DEFAULT_WALLET_PATH = "./buyer-wallet.json";

export interface WalletEntry {
  mandate_id: string;
  agent_id: string;
  agent_public_key: string;
  agent_private_key: string;
}

export interface Wallet {
  note: string;
  agents: WalletEntry[];
}

export function walletOf(principals: readonly SeededPrincipal[]): Wallet {
  return {
    note: "Demo buyer keys. A real buyer agent holds these; Mercury never does.",
    agents: principals.map((p) => ({
      mandate_id: p.mandate.mandate.mandate_id,
      agent_id: p.mandate.mandate.agent_id,
      agent_public_key: p.agent_public_key,
      agent_private_key: p.agent_private_key,
    })),
  };
}

export function writeWallet(
  principals: readonly SeededPrincipal[],
  path: string = DEFAULT_WALLET_PATH,
): void {
  writeFileSync(path, `${JSON.stringify(walletOf(principals), null, 2)}\n`, "utf8");
}

export function readWallet(path: string = DEFAULT_WALLET_PATH): WalletEntry[] {
  try {
    const raw = JSON.parse(readFileSync(path, "utf8")) as Partial<Wallet>;
    return raw.agents ?? [];
  } catch {
    return [];
  }
}
