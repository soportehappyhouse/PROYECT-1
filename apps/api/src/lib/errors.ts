import {
  formatErrorEs,
  PACK_REQUIRED,
  SPRINT4_ERRORS,
  type ApiError,
  type PackRequiredBody,
  type Sprint4ErrorCode,
} from "@studio/shared";
import type { FastifyReply } from "fastify";

export class HttpError extends Error {
  constructor(
    readonly statusCode: number,
    readonly code: string,
    message: string,
    readonly details?: unknown,
  ) {
    super(message);
    this.name = "HttpError";
  }
}

export function errorBody(code: string, message: string, details?: unknown): ApiError {
  return { error: { code, message, ...(details === undefined ? {} : { details }) } };
}

/**
 * Sprint 4 error (docs/trabajo/sprint4-contratos.md «Códigos de error nuevos»): HTTP status and
 * Spanish message of SPRINT4_ERRORS with `vars` filled in, e.g.
 * `throw sprint4Error("CONSENT_REQUIRED", {nombre, alcance: "cara", motivo}, details)`.
 */
export function sprint4Error(
  code: Sprint4ErrorCode,
  vars: Readonly<Record<string, string | number>> = {},
  details?: unknown,
): HttpError {
  return new HttpError(SPRINT4_ERRORS[code].status, code, formatErrorEs(code, vars), details);
}

/** Uniform 501 for endpoints still owned by another module. */
export function notImplemented(reply: FastifyReply, owner: string): FastifyReply {
  return reply
    .code(501)
    .send(errorBody("NOT_IMPLEMENTED", `Endpoint pending implementation (${owner})`));
}

/**
 * A feature needs a model pack that is not installed (Sprint 1 contract). Routes answer
 * 409 `PackRequiredBody` ({error:"PACK_REQUIRED", packId, name_es, size_bytes}); a job that hits it
 * fails with the same body as `result` (`jobResult`).
 */
export class PackRequiredError extends Error {
  readonly statusCode = 409;
  readonly code = PACK_REQUIRED;
  constructor(
    readonly packId: string,
    readonly nameEs: string,
    readonly sizeBytes: number,
  ) {
    super(
      `Falta el paquete de IA «${nameEs}» (${(sizeBytes / 1e9).toFixed(2).replace(".", ",")} GB). ` +
        "Descárgalo para usar esta función.",
    );
    this.name = "PackRequiredError";
  }

  get body(): PackRequiredBody {
    return {
      error: PACK_REQUIRED,
      packId: this.packId,
      name_es: this.nameEs,
      size_bytes: this.sizeBytes,
      message: this.message,
    };
  }

  /** Stored as the failed job's `result` by the JobQueue. */
  get jobResult(): PackRequiredBody {
    return this.body;
  }
}
