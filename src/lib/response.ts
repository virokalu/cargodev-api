// Response envelope helpers. Success: { data }. Error: { error: { code, message, fieldErrors? } }.

export interface ErrorBody {
  error: { code: string; message: string; fieldErrors?: Record<string, string> };
}

export function success<T>(data: T): { data: T } {
  return { data };
}

export function errorBody(code: string, message: string, fieldErrors?: Record<string, string>): ErrorBody {
  return { error: { code, message, ...(fieldErrors ? { fieldErrors } : {}) } };
}
