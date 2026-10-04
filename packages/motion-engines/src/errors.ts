export class MotionEngineError extends Error {
  /** Stable machine-readable code (api maps it into ApiError.code / Job.error). */
  readonly code: string = "MOTION_ENGINE_ERROR";
  constructor(
    message: string,
    readonly engineId: string,
  ) {
    super(message);
    this.name = "MotionEngineError";
  }
}

export class MotionEngineNotImplementedError extends MotionEngineError {
  override readonly code = "NOT_IMPLEMENTED";
  constructor(engineId: string, what = "render") {
    super(`Motion engine "${engineId}" does not implement ${what} yet`, engineId);
    this.name = "MotionEngineNotImplementedError";
  }
}

export class UnknownMotionEngineError extends MotionEngineError {
  override readonly code = "UNKNOWN_ENGINE";
  constructor(engineId: string) {
    super(`Unknown motion engine "${engineId}"`, engineId);
    this.name = "UnknownMotionEngineError";
  }
}

/** Spec rejected before rendering (bad props, unsupported format/fps...). */
export class MotionValidationError extends MotionEngineError {
  override readonly code = "VALIDATION_ERROR";
  constructor(
    readonly errors: string[],
    engineId: string,
  ) {
    super(errors.join("; "), engineId);
    this.name = "MotionValidationError";
  }
}
