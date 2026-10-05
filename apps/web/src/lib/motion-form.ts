/**
 * Turns a template's JSON Schema (`MotionTemplateInfo.propsSchema`, produced with z.toJSONSchema)
 * into a flat list of form fields. Unknown/complex shapes become JSON fields.
 */
export type FieldKind = "text" | "textarea" | "number" | "boolean" | "select" | "color" | "json";

export interface FormField {
  key: string;
  label: string;
  kind: FieldKind;
  description?: string;
  options?: string[];
  min?: number;
  max?: number;
  step?: number;
  required: boolean;
}

interface JsonSchemaLike {
  type?: string | string[];
  properties?: Record<string, JsonSchemaLike>;
  required?: string[];
  enum?: unknown[];
  const?: unknown;
  anyOf?: JsonSchemaLike[];
  oneOf?: JsonSchemaLike[];
  format?: string;
  pattern?: string;
  title?: string;
  description?: string;
  minimum?: number;
  maximum?: number;
  exclusiveMinimum?: number;
  exclusiveMaximum?: number;
  multipleOf?: number;
  maxLength?: number;
}

function isObject(v: unknown): v is Record<string, unknown> {
  return typeof v === "object" && v !== null && !Array.isArray(v);
}

function humanize(key: string): string {
  const spaced = key.replace(/([a-z0-9])([A-Z])/g, "$1 $2").replace(/[_-]+/g, " ");
  return spaced.charAt(0).toUpperCase() + spaced.slice(1);
}

function looksLikeColor(key: string, schema: JsonSchemaLike, sample: unknown): boolean {
  if (schema.format === "color") return true;
  if (/colou?r|background|fill|stroke/i.test(key)) return true;
  return typeof sample === "string" && /^#[0-9a-f]{3,8}$/i.test(sample);
}

function unwrap(schema: JsonSchemaLike): JsonSchemaLike {
  const variants = schema.anyOf ?? schema.oneOf;
  if (!variants) return schema;
  // Optional values come out as anyOf [T, null]; keep T.
  const nonNull = variants.filter((v) => v.type !== "null");
  if (nonNull.length === 1)
    return { ...nonNull[0]!, description: schema.description ?? nonNull[0]!.description };
  // Union of literals -> enum.
  if (nonNull.every((v) => v.const !== undefined))
    return { type: "string", enum: nonNull.map((v) => v.const) };
  return schema;
}

function fieldFor(key: string, raw: JsonSchemaLike, required: boolean, sample: unknown): FormField {
  const schema = unwrap(raw);
  const base = {
    key,
    label: schema.title ?? humanize(key),
    required,
    ...(schema.description ? { description: schema.description } : {}),
  };
  const type = Array.isArray(schema.type) ? schema.type.find((t) => t !== "null") : schema.type;
  if (schema.enum && schema.enum.length > 0)
    return { ...base, kind: "select", options: schema.enum.map(String) };
  switch (type) {
    case "boolean":
      return { ...base, kind: "boolean" };
    case "number":
    case "integer": {
      const min = schema.minimum ?? schema.exclusiveMinimum;
      const max = schema.maximum ?? schema.exclusiveMaximum;
      return {
        ...base,
        kind: "number",
        ...(min !== undefined ? { min } : {}),
        ...(max !== undefined ? { max } : {}),
        step: schema.multipleOf ?? (type === "integer" ? 1 : 0.1),
      };
    }
    case "string":
      if (looksLikeColor(key, schema, sample)) return { ...base, kind: "color" };
      return {
        ...base,
        kind: (schema.maxLength ?? 0) > 120 || /text|body|caption/i.test(key) ? "textarea" : "text",
      };
    default:
      return { ...base, kind: "json" };
  }
}

function inferFromValue(key: string, value: unknown): FormField {
  const base = { key, label: humanize(key), required: false };
  if (typeof value === "boolean") return { ...base, kind: "boolean" };
  if (typeof value === "number")
    return { ...base, kind: "number", step: Number.isInteger(value) ? 1 : 0.1 };
  if (typeof value === "string") {
    if (looksLikeColor(key, {}, value)) return { ...base, kind: "color" };
    return { ...base, kind: value.length > 60 || /text/i.test(key) ? "textarea" : "text" };
  }
  return { ...base, kind: "json" };
}

/**
 * Props the api fills (packages/remotion INTERNAL_PROP = "x-internal", e.g. `track`,
 * `trackAnchor`, `trackOffset` from the clip's trackRef) are not form fields. Their values in
 * the clip's props are kept untouched.
 */
export function isInternalProp(schema: unknown): boolean {
  const s = schema as (JsonSchemaLike & { "x-internal"?: unknown }) | undefined;
  return (
    s?.["x-internal"] === true ||
    (s?.anyOf ?? s?.oneOf ?? []).some(
      (v) => (v as { "x-internal"?: unknown })["x-internal"] === true,
    )
  );
}

/** Fields from the JSON Schema when present, otherwise inferred from the default props. */
export function fieldsFromSchema(
  propsSchema: unknown,
  defaultProps: Record<string, unknown> = {},
): FormField[] {
  if (isObject(propsSchema) && isObject(propsSchema.properties)) {
    const schema = propsSchema as JsonSchemaLike;
    const required = new Set(schema.required ?? []);
    return Object.entries(schema.properties ?? {})
      .filter(([, s]) => !isInternalProp(s))
      .map(([key, s]) => fieldFor(key, s, required.has(key), defaultProps[key]));
  }
  return Object.entries(defaultProps).map(([key, value]) => inferFromValue(key, value));
}

/** Parse an input value back into the prop value for a field. */
export function coerceFieldValue(field: FormField, raw: string | boolean): unknown {
  switch (field.kind) {
    case "boolean":
      return Boolean(raw);
    case "number": {
      const n = Number(raw);
      return Number.isFinite(n) ? n : undefined;
    }
    case "json":
      try {
        return JSON.parse(String(raw));
      } catch {
        return undefined;
      }
    default:
      return String(raw);
  }
}
