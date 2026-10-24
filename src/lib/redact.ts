// Scrubs secret-looking values out of text before it is logged. Defence in depth:
// nothing in this codebase should put a token in a message, but error messages
// from libraries (database, push service, JWT) are not under our control.

const PATTERNS: RegExp[] = [
  // Expo push tokens: ExponentPushToken[...] / ExpoPushToken[...]
  /Expo(?:nent)?PushToken\[[^\]\s]+\]/g,
  // JWTs (three base64url segments starting with the usual {"alg" header)
  /eyJ[A-Za-z0-9_-]{5,}\.[A-Za-z0-9_-]{5,}\.[A-Za-z0-9_-]*/g,
  // Authorization header values
  /Bearer\s+[A-Za-z0-9._~+/=-]{8,}/gi,
];

export function redactSecrets(text: string): string {
  return PATTERNS.reduce((out, pattern) => out.replace(pattern, "[redacted]"), text);
}

/** A log-safe view of an unknown thrown value: name, redacted message, redacted stack. */
export function safeError(error: unknown): { name: string; message: string; stack?: string } {
  if (error instanceof Error) {
    return {
      name: error.name,
      message: redactSecrets(error.message),
      ...(error.stack ? { stack: redactSecrets(error.stack) } : {}),
    };
  }
  return { name: "NonError", message: redactSecrets(String(error)) };
}
