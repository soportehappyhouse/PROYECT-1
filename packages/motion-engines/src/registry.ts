import type { MotionEngineId, MotionSpec, MotionTemplateInfo } from "@studio/shared";
import { MotionEngineError, UnknownMotionEngineError } from "./errors.js";
import type {
  MotionEngine,
  MotionEngineStatus,
  MotionRenderContext,
  MotionRenderResult,
} from "./types.js";

/** Holds the enabled motion engines and dispatches renders. */
export class MotionEngineRegistry {
  readonly #engines = new Map<MotionEngineId, MotionEngine>();

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
        `No engine supports template "${spec.template}" with format "${spec.format}"`,
        "none",
      );
    return engine;
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

  async render(spec: MotionSpec, ctx: MotionRenderContext): Promise<MotionRenderResult> {
    const engine = this.resolve(spec);
    const validation = engine.validate(spec);
    if (!validation.ok) throw new MotionEngineError(validation.errors.join("; "), engine.id);
    return engine.render(spec, ctx);
  }

  async dispose(): Promise<void> {
    await Promise.all(this.list().map((e) => e.dispose?.()));
  }
}
