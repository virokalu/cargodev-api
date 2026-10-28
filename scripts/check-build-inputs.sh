#!/bin/sh
# Every file the Docker build copies must be in the COMMIT, not just on your disk. A host that builds from git (Render, CI) sees only
# the commit: a Dockerfile, tsconfig.build.json or prisma folder that exists locally but was never committed fails there with
# "failed to read dockerfile" or "COPY failed: file not found".
#
# READ-ONLY: it only runs `git ls-tree` and `git show`. It changes nothing.
#
#   sh scripts/check-build-inputs.sh            checks the commit at HEAD
#   sh scripts/check-build-inputs.sh <commit>   checks that commit (for example the one a host says it built)
#
# It reads the Dockerfile and .dockerignore AS COMMITTED at that commit, and fails (exit 1) listing:
#   - a Dockerfile that is not at the repo root with exactly that name,
#   - every COPY/ADD source (outside multi-stage `--from=` copies) that has no file in the commit,
#   - every COPY/ADD source whose files are ALL left out of the build context by the committed .dockerignore.
# Exit 2 means the commit could not be read.
#
# One awk program does all the matching, so it starts a handful of processes (fast, also on Windows). .dockerignore rules follow
# Docker: patterns are relative to the context root, `*` does not cross a "/", `**` does, the LAST matching pattern wins, and
# `!pattern` puts a file back.

ref="${1:-HEAD}"

tree=$(git ls-tree -r --name-only "$ref" 2>/dev/null) || {
  echo "check-build-inputs: cannot read commit '$ref' (is this a git repository?)" >&2
  exit 2
}

# The committed Dockerfile and .dockerignore ("" when absent; the awk program reports a missing Dockerfile).
dockerfile=$(git show "$ref:Dockerfile" 2>/dev/null || true)
ignore=$(git show "$ref:.dockerignore" 2>/dev/null || true)

result=$(
  {
    printf '%s\n' "$tree" | sed 's/^/T:/'
    printf '%s\n' "$dockerfile" | sed 's/^/D:/'
    printf '%s\n' "$ignore" | sed 's/^/I:/'
  } | awk -v ref="$ref" '
    function esc(p,   i, c, out) {
      out = ""
      for (i = 1; i <= length(p); i++) {
        c = substr(p, i, 1)
        out = out (index(".+(){}|^$\\[]", c) ? "\\" c : c)
      }
      return out
    }
    # a .dockerignore pattern -> regex: * stays inside a folder, ** crosses folders, a match also covers everything below
    function ignore_rx(p) {
      sub(/^\//, "", p); sub(/\/$/, "", p)
      p = esc(p)
      gsub(/\*\*\//, "@@A@@", p); gsub(/\*\*/, "@@B@@", p); gsub(/\*/, "[^/]*", p); gsub(/\?/, "[^/]", p)
      gsub(/@@A@@/, "(.*/)?", p); gsub(/@@B@@/, ".*", p)
      return "^" p "(/.*)?$"
    }
    # a COPY source -> regex: the file itself, or anything below it as a folder
    function source_rx(p) {
      p = esc(p)
      gsub(/\*/, "[^/]*", p); gsub(/\?/, "[^/]", p)
      return "^" p "(/.*)?$"
    }
    function is_ignored(file,   j, ign) {
      ign = 0
      for (j = 1; j <= nign; j++) if (file ~ irx[j]) ign = !ineg[j]
      return ign
    }
    BEGIN { nt = 0; nd = 0; nign = 0; problems = 0 }
    /^T:/ { f = substr($0, 3); if (f != "") { tree[++nt] = f; if (f == "Dockerfile") has_df = 1; else if (tolower(f) ~ /dockerfile/ && nsimilar < 3) similar = similar (similar == "" ? "" : " ") f } next }
    /^D:/ { dline[++nd] = substr($0, 3); next }
    /^I:/ {
      l = substr($0, 3); sub(/^[ \t]+/, "", l); sub(/[ \t]+$/, "", l)
      if (l == "" || l ~ /^#/) next
      neg = 0; if (l ~ /^!/) { neg = 1; l = substr(l, 2) }
      nign++; irx[nign] = ignore_rx(l); ineg[nign] = neg
      next
    }
    END {
      if (!has_df) {
        printf "  - Dockerfile: not in commit %s at the repo root%s\n", ref, (similar != "" ? " (something similar is at: " similar ")" : "")
        print "FAILED"; exit
      }
      count = 0
      for (d = 1; d <= nd; d++) {
        line = dline[d]
        if (line !~ /^[ \t]*(COPY|ADD)[ \t]/ || line ~ /--from=/) continue
        n = split(line, a, /[ \t]+/)
        k = 0
        for (i = 2; i <= n; i++) { if (a[i] == "" || a[i] ~ /^--/) continue; arg[++k] = a[i] }
        for (i = 1; i < k; i++) {          # the last argument is the destination
          s = arg[i]
          if (s == "." || s == "./" || s == "*") continue
          sub(/^\.\//, "", s); sub(/\/$/, "", s)
          count++
          rx = source_rx(s); total = 0; dropped = 0
          for (t = 1; t <= nt; t++) if (tree[t] ~ rx) { total++; if (is_ignored(tree[t])) dropped++ }
          if (total == 0) { printf "  - %s: no file with this name, or under this folder, in commit %s\n", s, ref; problems++ }
          else if (dropped == total) { printf "  - %s: every file in it is excluded by .dockerignore, so COPY would find nothing\n", s; problems++ }
        }
      }
      print (problems ? "FAILED" : "COUNT " count)
    }'
)

last=$(printf '%s\n' "$result" | tail -n 1)
case "$last" in
  COUNT\ *)
    echo "check-build-inputs: OK, every one of the ${last#COUNT } COPY/ADD sources is in commit $ref and not excluded by .dockerignore"
    ;;
  *)
    printf 'check-build-inputs: FAIL for %s\nThe Docker build needs these, and the commit does not provide them:\n%s\n' "$ref" "$(printf '%s\n' "$result" | sed '$d')" >&2
    exit 1
    ;;
esac
