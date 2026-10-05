// Writes the EditPlan JSON Schema (single source: src/agent.ts) for the workers and the repo.
// Run with `pnpm --filter @studio/shared export-schemas` (builds dist first).
import { mkdirSync, writeFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { editPlanJsonSchema } from "../dist/agent.js";

const here = dirname(fileURLToPath(import.meta.url));
const root = resolve(here, "../../..");
const schema = {
  ...editPlanJsonSchema(),
  $id: "https://studio.local/schemas/editplan.schema.json",
  title: "EditPlan",
};
let text = `${JSON.stringify(schema, null, 2)}\n`;
// Same layout as `pnpm format` (root prettier) so format:check stays green after an export.
try {
  const prettier = await import("prettier");
  text = await prettier.format(text, { parser: "json" });
} catch {
  // prettier not installed (e.g. a production install): keep the plain JSON.
}
const targets = [
  resolve(root, "apps/workers/studio_workers/agent/editplan.schema.json"),
  resolve(root, "packages/shared/schemas/editplan.schema.json"),
];
for (const target of targets) {
  mkdirSync(dirname(target), { recursive: true });
  writeFileSync(target, text, "utf8");
  console.log(`editplan.schema.json -> ${target}`);
}
