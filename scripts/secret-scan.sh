#!/bin/sh
# Secret scan shared by the pre-commit hook and the required CI job, so the two
# can never drift apart (`git commit --no-verify` skips the hook, not CI).
#
# Reads file paths, one per line, on stdin. Two checks:
#
#  1. Hardcoded secret-looking assignments in ts/tsx/js/mjs/yml files. A value is accepted only
#     if it contains "example", "placeholder", "changeme", "your_" or "process.env".
#  2. Database connection strings WITH credentials (postgres://user:password@host) in any text
#     file (source, docs, yml, json, sh, .env.example). Accepted only if the password is an obvious
#     placeholder: it contains "example", "changeme", "placeholder" or "your_", is the word
#     "password", is wrapped in <...>, or is a variable (${...} / $VAR).
#
# No folder or file allow-list: build fixtures at runtime or use obviously fake values instead.
#
# Usage (tracked AND untracked-but-not-ignored files, so a new file is checked before `git add`):
#   git ls-files -co --exclude-standard | sh scripts/secret-scan.sh
#   git diff --cached --name-only --diff-filter=ACM | sh scripts/secret-scan.sh

FOUND=0

while IFS= read -r FILE; do
  # Build output, dependencies, lock files and migration SQL are not authored source.
  case "$FILE" in
    node_modules/*|prisma/migrations/*|dist/*|coverage/*|package-lock.json) continue ;;
  esac

  # Deleted in this commit.
  [ -f "$FILE" ] || continue

  case "$FILE" in
    *.ts|*.tsx|*.js|*.mjs|*.yml)
      # -- guards filenames that start with a dash.
      if grep -Eo \
        "(password|secret|api_key|apikey|token|private_key)\s*[=:]\s*['\"][^'\"]{8,}['\"]" \
        -- "$FILE" | grep -ivE "example|placeholder|changeme|your_|process\.env"; then
        echo ""
        echo "  Potential hardcoded secret in: $FILE"
        echo "  Load it from process.env or src/config/env.ts instead."
        FOUND=1
      fi
      ;;
  esac

  case "$FILE" in
    *.ts|*.tsx|*.js|*.mjs|*.yml|*.yaml|*.json|*.md|*.sh|*.txt|*.env|*.example|.env|.env.*)
      # user:password@host with a non-placeholder password. awk splits each match into user, password, host.
      HITS=$(grep -Eo "postgres(ql)?://[^:/@[:space:]'\"\`]+:[^@[:space:]'\"\`]+@[^[:space:]'\"\`/?]+" -- "$FILE" | awk '
        {
          rest = $0; sub(/^postgres(ql)?:\/\//, "", rest)
          at = match(rest, /@[^@]*$/); cred = substr(rest, 1, at - 1)
          colon = index(cred, ":"); pass = substr(cred, colon + 1)
          lower = tolower(pass)
          if (lower ~ /example|changeme|placeholder|your_/) next
          if (lower == "password") next
          if (pass ~ /^<.*>$/) next
          if (pass ~ /[$]/) next
          print $0
        }')
      if [ -n "$HITS" ]; then
        echo "$HITS" | sed 's#//[^:]*:[^@]*@#//***:***@#'
        echo ""
        echo "  Connection string with credentials in: $FILE"
        echo "  Use a placeholder such as postgresql://user:password@host:5432/dbname, or a value containing \"example\"."
        FOUND=1
      fi
      ;;
  esac
done

if [ "$FOUND" -eq 1 ]; then
  echo ""
  echo "Secret scan failed. Fix the issues above and try again."
  exit 1
fi

exit 0
