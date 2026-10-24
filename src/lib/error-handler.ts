// The one place that turns any error into the response envelope.
// Unexpected errors are logged server side and never leak their message.

import type { FastifyError, FastifyReply, FastifyRequest } from "fastify";
import { HTTP_STATUS, ServiceError } from "./errors.js";
import { errorBody } from "./response.js";

export function errorHandler(error: FastifyError | Error, request: FastifyRequest, reply: FastifyReply) {
  if (error instanceof ServiceError) {
    return reply.status(HTTP_STATUS[error.code]).send(errorBody(error.code, error.message, error.fieldErrors));
  }

  const statusCode = (error as FastifyError).statusCode;

  // Fastify's own client errors (malformed JSON, oversized or wrongly typed body).
  if (statusCode === 400 || statusCode === 413 || statusCode === 415) {
    return reply.status(400).send(errorBody("VALIDATION", "Invalid request."));
  }
  if (statusCode === 429) {
    return reply.status(429).send(errorBody("RATE_LIMITED", "Too many requests. Try again later."));
  }

  request.log.error({ err: error }, "unexpected error");
  return reply.status(500).send(errorBody("INTERNAL", "Something went wrong."));
}

export function notFoundHandler(_request: FastifyRequest, reply: FastifyReply) {
  return reply.status(404).send(errorBody("NOT_FOUND", "Route not found."));
}
