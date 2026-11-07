import { Prisma } from "@prisma/client";

/**
 * True when a database write failed because a unique key already holds the value: Prisma's P2002, or the raw Postgres code 23505
 * (on the error itself or on its cause, as a driver adapter reports it). Services turn it into a 409 with a field error.
 */
export function isUniqueViolation(error: unknown): boolean {
  if (error instanceof Prisma.PrismaClientKnownRequestError) return error.code === "P2002";
  if (typeof error !== "object" || error === null) return false;
  const code = (error as { code?: unknown }).code;
  const causeCode = (error as { cause?: { code?: unknown } }).cause?.code;
  return code === "23505" || causeCode === "23505";
}
