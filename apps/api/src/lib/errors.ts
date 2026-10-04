import type { ApiError } from "@studio/shared";
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

/** Uniform 501 for endpoints still owned by another module. */
export function notImplemented(reply: FastifyReply, owner: string): FastifyReply {
  return reply
    .code(501)
    .send(errorBody("NOT_IMPLEMENTED", `Endpoint pending implementation (${owner})`));
}
