#!/bin/sh
# Secret scan shared by the pre-commit hook and the required CI job, so the two
# can never drift apart (`git commit --no-verify` skips the hook, not CI).
#
# Reads file paths, one per line, on stdin. Flags hardcoded secret-looking
# assignments in ts/tsx/js/mjs/yml files. A value is accepted only if it
# contains "example", "placeholder", "changeme", "your_" or "process.env".
# No folder or file allow-list: build fixtures at runtime or use obviously
# fake values instead.
#
# Usage:
#   git diff --cached --name-only --diff-filter=ACM | sh scripts/secret-scan.sh
#   git ls-files | sh scripts/secret-scan.sh

FOUND=0

while IFS= read -r FILE; do
  case "$FILE" in
    *.ts|*.tsx|*.js|*.mjs|*.yml) ;;
    *) continue ;;
  esac

  # Build output and migration SQL are not authored source.
  case "$FILE" in
    node_modules/*|prisma/migrations/*|dist/*|coverage/*) continue ;;
  esac

  # Deleted in this commit.
  [ -f "$FILE" ] || continue

  # -- guards filenames that start with a dash.
  if grep -Eo \
    "(password|secret|api_key|apikey|token|private_key)\s*[=:]\s*['\"][^'\"]{8,}['\"]" \
    -- "$FILE" | grep -ivE "example|placeholder|changeme|your_|process\.env"; then
    echo ""
    echo "  Potential hardcoded secret in: $FILE"
    echo "  Load it from process.env or src/config/env.ts instead."
    FOUND=1
  fi
done

if [ "$FOUND" -eq 1 ]; then
  echo ""
  echo "Secret scan failed. Fix the issues above and try again."
  exit 1
fi

exit 0
