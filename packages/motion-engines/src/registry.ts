import type { MotionEngineId, MotionSpec, MotionTemplateInfo } from "@studio/shared";
import { MotionEngineError, MotionValidationError, UnknownMotionEngineError } from "./errors.js";
import type {
  MotionEngine,
  MotionEngineCapabilities,
  MotionEngineStatus,
  MotionRenderContext,
  MotionRenderResult,
  MotionValidation,
} from "./types.js";

/** Checks template/format/fps/duration against an engine's capability flags (Spanish errors). */
export function checkCapabilities(
  spec: MotionSpec,
  caps: MotionEngineCapabilities,
  engineId: string,
): MotionValidation {
  const errors: string[] = [];
  if (!caps.templates.includes(spec.template))
    errors.push(`El motor ${engineId} no tiene la plantilla "${spec.template}"`);
  if (!caps.formats.includes(spec.format))
    errors.push(`El motor ${engineId} no admite el formato ${spec.format}`);
  if (spec.fps > caps.maxFps) errors.push(`fps máximo para ${engineId}: ${caps.maxFps}`);
  if (spec.durationSec > caps.maxDurationSec)
    errors.push(`Duración máxima para ${engineId}: ${caps.maxDurationSec} s`);
  return errors.length ? { ok: false, errors } : { ok: true };
}

/** Holds the enabled motion engines and dispatches renders. */
export class MotionEngineRegistry {
  readonly #engines = new Map<MotionEngineId, MotionEngine>();

  /** Adds an engine, or replaces the one with the same id (keeping its position). */
  register(engine: MotionEngine): this {
    this.#engines.set(engine.id, engine);
    return this;
  }

  has(id: MotionEngineId): boolean {
    return this.#engines.has(id);
  }

  get(id: MotionEngineId): MotionEngine {
    const engine = this.#engines.get(id);
    if (!engine) throw new UnknownMotionEngineError(id);
    return engine;
  }

  list(): MotionEngine[] {
    return [...this.#engines.values()];
  }

  /** spec.engine if set; otherwise the first engine whose capabilities cover template + format. */
  resolve(spec: MotionSpec): MotionEngine {
    if (spec.engine) return this.get(spec.engine);
    const engine = this.list().find((e) => {
      const caps = e.capabilities();
      return caps.templates.includes(spec.template) && caps.formats.includes(spec.format);
    });
    if (!engine)
      throw new MotionEngineError(
        `Ningún motor admite la plantilla "${spec.template}" con el formato "${spec.format}"`,
        "none",
      );
    return engine;
  }

  /** Full pre-flight check used by POST /api/motion/render before enqueueing. Never throws. */
  validate(spec: MotionSpec): MotionValidation & { engine?: MotionEngineId } {
    let engine: MotionEngine;
    try {
      engine = this.resolve(spec);
    } catch (err) {
      return { ok: false, errors: [(err as Error).message] };
    }
    const caps = checkCapabilities(spec, engine.capabilities(), engine.id);
    if (!caps.ok) return { ...caps, engine: engine.id };
    return { ...engine.validate(spec), engine: engine.id };
  }

  async status(): Promise<MotionEngineStatus[]> {
    return Promise.all(
      this.list().map(async (engine) => ({
        id: engine.id,
        displayName: engine.displayName,
        capabilities: engine.capabilities(),
        ...(await engine
          .checkAvailable()
          .catch((err: unknown) => ({ ok: false, reason: String(err) }))),
      })),
    );
  }

  async listTemplates(): Promise<MotionTemplateInfo[]> {
    const all = await Promise.all(this.list().map((engine) => engine.listTemplates()));
    return all.flat();
  }

  /** resolve -> validate (capabilities + props) -> render. Throws MotionValidationError. */
  async render(spec: MotionSpec, ctx: MotionRenderContext): Promise<MotionRenderResult> {
    const engine = this.resolve(spec);
    const validation = this.validate(spec);
    if (!validation.ok) throw new MotionValidationError(validation.errors, engine.id);
    return engine.render(spec, ctx);
  }

  async dispose(): Promise<void> {
    await Promise.all(this.list().map((e) => e.dispose?.()));
  }
}
