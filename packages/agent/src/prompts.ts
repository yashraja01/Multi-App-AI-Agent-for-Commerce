import { readFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { sha256Hex } from "@mercury/core";
import type { Vertical } from "@mercury/core";

/**
 * Prompt loading.
 *
 * Prompts live in `prompts/` as markdown, not as string literals in TypeScript,
 * for two reasons. They are the per-vertical half of the "two verticals, one
 * gate" claim (D9) and belong next to the seed data, and a prompt in a file can
 * be hashed and pinned -- `promptHash()` is what goes into the ledger, so
 * an auditor can tell which prompt produced which offer without us storing the
 * prompt body in the audit trail.
 *
 * The assembled system prompt is deliberately frozen: core rules, then persona,
 * with nothing volatile in it. Everything that changes per turn (the envelope,
 * the buyer's message, the gate's verdicts) goes into `messages` after the cache
 * breakpoint, so the cached prefix survives the whole negotiation.
 */

const HERE = dirname(fileURLToPath(import.meta.url));

/** Walk up from this module to the repo root, wherever it is built from. */
function promptsDir(): string {
  let dir = HERE;
  for (let i = 0; i < 6; i += 1) {
    const candidate = join(dir, "prompts", "system.core.md");
    try {
      readFileSync(candidate, "utf8");
      return join(dir, "prompts");
    } catch {
      dir = resolve(dir, "..");
    }
  }
  throw new PromptError(`could not locate prompts/ above ${HERE}`);
}

const cache = new Map<string, string>();

export function loadPrompt(file: string): string {
  const cached = cache.get(file);
  if (cached !== undefined) return cached;
  let text: string;
  try {
    text = readFileSync(join(promptsDir(), file), "utf8");
  } catch (e) {
    throw new PromptError(`cannot read prompt ${file}: ${(e as Error).message}`);
  }
  cache.set(file, text);
  return text;
}

export const PERSONA_FILES: Record<Vertical, string> = {
  quick_commerce: "persona.quick-commerce.md",
  b2b_procurement: "persona.b2b.md",
};

/** The persona for a vertical. This and the seed catalogue are the only per-vertical inputs. */
export function personaFor(vertical: Vertical): string {
  return loadPrompt(PERSONA_FILES[vertical]);
}

export function buyerPersona(): string {
  return loadPrompt("persona.buyer.md");
}

/**
 * The frozen system prompt: shared rules first, persona second.
 *
 * Order matters. The shared half is byte-identical across both verticals, so a
 * deployment serving both still gets a cache hit on the longer, stable prefix.
 */
export function systemPrompt(persona: string): string {
  return `${loadPrompt("system.core.md")}\n\n---\n\n${persona}`;
}

/** Stable identity for a prompt body, for the `llm.input_hash` field in the ledger. */
export function promptHash(text: string): string {
  return sha256Hex(text);
}

export class PromptError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "PromptError";
  }
}
