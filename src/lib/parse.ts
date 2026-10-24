// zod parsing for routes. A failed parse becomes a VALIDATION ServiceError with
// per-field messages, which the central error handler turns into a 400.

import type { z } from "zod";
import { ServiceError } from "./errors.js";
import { flattenFieldErrors } from "../validation/shared.js";

export function parseInput<S extends z.ZodType>(
  schema: S,
  input: unknown,
  message = "Invalid query parameters."
): z.output<S> {
  const parsed = schema.safeParse(input);
  if (!parsed.success) {
    throw new ServiceError("VALIDATION", message, flattenFieldErrors(parsed.error));
  }
  return parsed.data;
}
