// Scrubs secret-looking values out of text before it is logged. Defence in depth:
// nothing in this codebase should put a token in a message, but error messages
// from libraries (database, push service, JWT) are not under our control.

const PATTERNS: RegExp[] = [
  // Expo push tokens: ExponentPushToken[...] / ExpoPushToken[...]
  /Expo(?:nent)?PushToken\[[^\]\s]+\]/g,
  // JWTs (three base64url segments starting with the usual {"alg" header)
  /eyJ[A-Za-z0-9_-]{5,}\.[A-Za-z0-9_-]{5,}\.[A-Za-z0-9_-]*/g,
  // bcrypt password hashes ($2a$/$2b$/$2y$, cost, 53 characters)
  /\$2[aby]\$\d{2}\$[./A-Za-z0-9]{53}/g,
  // Authorization header values
  /Bearer\s+[A-Za-z0-9._~+/=-]{8,}/gi,
];

// Signed-URL secrets. A presigned link is a bearer credential for its lifetime: the signature, the credential scope and a
// session token are each removed wherever a URL ends up in text (an error message, a stack, a log line).
const SIGNED_URL_PATTERNS: RegExp[] = [/X-Amz-(?:Signature|Credential|Security-Token)=[^&\s"'<>`]*/gi];

// Object storage details a customer must never see, even inside an error message from the storage library.
const STORAGE_PATTERNS: RegExp[] = [
  // R2 hostnames (the account id is the first label)
  /[A-Za-z0-9.-]*\.r2\.cloudflarestorage\.com/gi,
  // our object keys: org/<id>/vehicles/... and org/<id>/uploads/...
  /org\/[A-Za-z0-9_-]+\/(?:vehicles|uploads)\/[A-Za-z0-9._\-/]*/g,
];

export function redactSecrets(text: string): string {
  let out = PATTERNS.reduce((acc, pattern) => acc.replace(pattern, "[redacted]"), text);
  out = SIGNED_URL_PATTERNS.reduce((acc, pattern) => acc.replace(pattern, "[redacted]"), out);
  out = STORAGE_PATTERNS.reduce((acc, pattern) => acc.replace(pattern, "[redacted]"), out);
  // The configured account id, wherever it appears (it can also show up on its own).
  const accountId = process.env["R2_ACCOUNT_ID"];
  if (accountId && accountId.length >= 8) out = out.split(accountId).join("[redacted]");
  return out;
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
