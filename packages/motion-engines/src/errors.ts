export class MotionEngineError extends Error {
  constructor(
    message: string,
    readonly engineId: string,
  ) {
    super(message);
    this.name = "MotionEngineError";
  }
}

export class MotionEngineNotImplementedError extends MotionEngineError {
  constructor(engineId: string, what = "render") {
    super(`Motion engine "${engineId}" does not implement ${what} yet`, engineId);
    this.name = "MotionEngineNotImplementedError";
  }
}

export class UnknownMotionEngineError extends MotionEngineError {
  constructor(engineId: string) {
    super(`Unknown motion engine "${engineId}"`, engineId);
    this.name = "UnknownMotionEngineError";
  }
}
