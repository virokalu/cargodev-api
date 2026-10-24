// Typed service errors. Every service throws this instead of a raw Error or a
// string; the central error handler maps it to the response envelope. Services
// know nothing about HTTP, so the status map lives here for the handler only.

export type ServiceErrorCode =
  | "NOT_FOUND"
  | "FORBIDDEN"
  | "VALIDATION"
  | "CONFLICT"
  | "INTERNAL";

// No UNAUTHENTICATED code on purpose: services only run for an already
// authenticated actor, so only the auth hook can answer 401.
export const HTTP_STATUS: Record<ServiceErrorCode, number> = {
  VALIDATION: 400,
  FORBIDDEN: 403,
  NOT_FOUND: 404,
  CONFLICT: 409,
  INTERNAL: 500,
};

export class ServiceError extends Error {
  constructor(
    public code: ServiceErrorCode,
    message: string,
    public fieldErrors?: Record<string, string>
  ) {
    super(message);
    this.name = "ServiceError";
  }
}
