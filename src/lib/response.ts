// Response envelope helpers. Success: { data }. Error: { error: { code, message, fieldErrors? } }.

export interface ErrorBody {
  error: { code: string; message: string; fieldErrors?: Record<string, string>; reason?: string };
}

export function success<T>(data: T): { data: T } {
  return { data };
}

export function errorBody(code: string, message: string, fieldErrors?: Record<string, string>, reason?: string): ErrorBody {
  // `reason` exists on a 409 only: no other error carries one.
  return { error: { code, message, ...(fieldErrors ? { fieldErrors } : {}), ...(code === "CONFLICT" && reason ? { reason } : {}) } };
}
