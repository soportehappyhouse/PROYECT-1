import { UI_ENGLISH_DENYLIST } from "@studio/shared";
import { describe, expect, it } from "vitest";
import { ENUM_LABELS, OPTION_LABELS_ES } from "../src/schemas/common.js";
import { REMOTION_TEMPLATES } from "../src/templates.js";

type Js = Record<string, unknown> & { properties?: Record<string, Js>; anyOf?: Js[] };

const deny = UI_ENGLISH_DENYLIST.map(
  (t) => new RegExp(`(^|[^\\p{L}])${t.replace(/[/\\^$*+?.()|[\]{}]/g, "\\$&")}($|[^\\p{L}])`, "iu"),
);
const english = (s: string) => deny.find((r) => r.test(s));

function visibleTexts(schema: Js): string[] {
  const out: string[] = [];
  for (const prop of Object.values(schema.properties ?? {})) {
    const s = (prop.anyOf?.find((v) => v.type !== "null") ?? prop) as Js;
    if (prop["x-internal"] === true || s["x-internal"] === true) continue;
    for (const v of [prop.title, s.title]) if (typeof v === "string") out.push(v);
    const labels = (prop[ENUM_LABELS] ?? s[ENUM_LABELS]) as Record<string, string> | undefined;
    if (Array.isArray(s.enum)) {
      // Every enum value has a Spanish label (the raw id is never shown).
      expect(labels, `labels for ${String(s.title)}`).toBeDefined();
      for (const v of s.enum as string[]) {
        expect(labels![v], `${String(s.title)}: ${v}`).toBeDefined();
        out.push(labels![v]!);
      }
    }
  }
  return out;
}

describe("Motion templates in Spanish (H12, B11)", () => {
  it.each(REMOTION_TEMPLATES.map((t) => [t.id, t] as const))(
    "%s: names, descriptions, field titles and options outside UI_ENGLISH_DENYLIST",
    (_id, t) => {
      const texts = [t.name, t.description ?? "", ...visibleTexts(t.propsSchema as Js)];
      for (const s of texts) expect(english(s), s).toBeUndefined();
    },
  );

  it("the label dictionary itself is Spanish", () => {
    for (const label of Object.values(OPTION_LABELS_ES))
      expect(english(label), label).toBeUndefined();
    expect(OPTION_LABELS_ES["bottom-left"]).toBe("Abajo a la izquierda");
    expect(OPTION_LABELS_ES.bar).toBe("Barra");
    expect(OPTION_LABELS_ES.slide).toBe("Deslizar");
  });
});
