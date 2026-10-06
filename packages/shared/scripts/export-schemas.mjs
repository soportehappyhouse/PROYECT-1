// Writes the JSON Schemas whose single source is @studio/shared for the workers and the repo:
// EditPlan (src/agent.ts) and StylePreset (src/style.ts, Sprint 3b: Ollama `format` of /style/infer).
// Run with `pnpm --filter @studio/shared export-schemas` (builds dist first).
import { mkdirSync, writeFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { editPlanJsonSchema } from "../dist/agent.js";
import { stylePresetJsonSchema } from "../dist/style.js";

const here = dirname(fileURLToPath(import.meta.url));
const root = resolve(here, "../../..");

let prettier;
try {
  prettier = await import("prettier");
} catch {
  // prettier not installed (e.g. a production install): keep the plain JSON.
}

const exports = [
  {
    file: "editplan.schema.json",
    title: "EditPlan",
    schema: editPlanJsonSchema(),
    targets: ["apps/workers/studio_workers/agent", "packages/shared/schemas"],
  },
  {
    file: "stylepreset.schema.json",
    title: "StylePreset",
    schema: stylePresetJsonSchema(),
    targets: ["apps/workers/studio_workers/style", "packages/shared/schemas"],
  },
];

for (const { file, title, schema, targets } of exports) {
  const full = { ...schema, $id: `https://studio.local/schemas/${file}`, title };
  let text = `${JSON.stringify(full, null, 2)}\n`;
  // Same layout as `pnpm format` (root prettier) so format:check stays green after an export.
  if (prettier) text = await prettier.format(text, { parser: "json" });
  for (const dir of targets) {
    const target = resolve(root, dir, file);
    mkdirSync(dirname(target), { recursive: true });
    writeFileSync(target, text, "utf8");
    console.log(`${file} -> ${target}`);
  }
}
