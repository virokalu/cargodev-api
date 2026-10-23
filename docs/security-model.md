# Security model

Principle: security must not depend on the code being secret. Everything except keys can be public.

Each defence below must have a test. If you add a defence, add its row here.

| Threat | Example | Defence | Test that proves it |
|---|---|---|---|
| Cross-tenant access (IDOR) | Org A token requests an org B vehicle id | `orgId` from verified token on every query; other-org resource returns 404 | Two-org seed; org A token on org B ids expects 404 |
| Broken access control | VIEWER calls a mutation | Per-route role allow-list in the auth hook | 403 test per disallowed role per route |
| Missing authentication | Request with no/invalid token | Auth hook returns 401 | 401 test per route |
| Credential stuffing / brute force | Repeated login attempts | 5 failures lock the account 15 minutes; per-IP rate limit | Login lockout test |
| Token theft | Stolen access token | 20-minute access token; rotating, hashed refresh tokens; revoke on deactivation or password change | Refresh rotation + revoked token tests |
| Secret leakage | Token in logs or error body | Authorization header redacted; unexpected errors return generic `INTERNAL` | "Does not leak error message" test |
| Injection | Malicious input in a field | zod validation on all input; Prisma parameterised queries | Validation tests (400 + fieldErrors) |
| Overly broad CORS | Any website calls the API | Origin allow-list, never `*` | CORS test with unlisted origin |
| Production data damage | Migration run on shared DB | Separate dev DB; no `migrate` in this repo | Process rule + PR checklist |
| Vulnerable dependencies | Known CVE in a package | Dependabot, `npm audit` in CI, install scripts blocked by default | CI audit step |

## Accepted risks

Record any accepted `npm audit` finding here with the reason and a review date. Do not document known **unfixed** exploitable vulnerabilities in this public file; track those privately.
