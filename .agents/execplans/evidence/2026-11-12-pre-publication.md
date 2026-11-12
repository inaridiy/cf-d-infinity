# Pre-publication audit (2026-11-12)

Read-only audit by a subagent, on `finishing` 254dc46 and `main` fc5a273. Nothing was written to the repository.

- The GitHub repository is already public (`visibility: public`), apparently since its creation on 2026-11-10.
- Secrets: none in the history of all refs, including 47 unreachable local commits. Token values are placeholders
  (`test`, `admin-test`, `demo`, `dev-only-token`, ...). No `.env`, `.dev.vars`, key or `.npmrc` file was ever tracked.
- Identifying information: no Cloudflare account IDs, no owner `workers.dev` subdomain, no absolute paths of the owner's
  machine, no email addresses in file contents other than `@example.test`/`@example.com`. Commit metadata carries the
  owner's author address (owner's call; changing it for new commits is possible, removing it needs a history rewrite).
- Large files: 788 blobs, 19.2 MiB uncompressed; the largest is `src/sql-wasm.wasm` (644 KiB, byte-identical to sql.js 1.13.0).
- License: MIT in the root and both packages; `NOTICE` carries the sql.js license. The runtime dependency
  `sql-parser-cst` is GPL-2.0-or-later, so a Worker built from the package is a GPL combined work. This is disclosed in
  NOTICE and the READMEs, but the MIT label alone can mislead (owner's decision).
- npm: `cf-d-infinity` and `create-cf-d-infinity` are unpublished and unclaimed (E404). The READMEs told readers to
  run `npx create-cf-d-infinity@alpha init`; those lines were removed until the first release, because whoever registers
  the name first would run code on readers' machines.
- `.agents/`: no secrets or identifiers. It quotes the owner's words verbatim in several places (owner's call).

Commands used (re-runnable):

    git log --all -p --text --no-color --format='COMMIT %H' -- . ':!*.wasm' ':!*package-lock.json' | awk '/^COMMIT /{c=substr($2,1,9)} /^\+/{print c": "$0}' > added.txt
    grep -iE '(npm_[A-Za-z0-9]{30,}|ghp_|github_pat_|AKIA[0-9A-Z]{16}|BEGIN [A-Z ]*PRIVATE KEY|sk-[A-Za-z0-9]{20,}|_authToken|(token|secret|password|api_?key)[A-Z_]*\s*[:=]\s*["'\'']?[A-Za-z0-9_+/=-]{16,})' added.txt
    grep -iE 'account[_ -]?id|CLOUDFLARE_ACCOUNT|[a-z0-9-]+\.[a-z0-9-]+\.workers\.dev|/home/[a-z]|gmail' added.txt
    git rev-list --objects --all | git cat-file --batch-check='%(objecttype) %(objectname) %(objectsize) %(rest)' | awk '$1=="blob"' | sort -k3 -nr | head
    npm view cf-d-infinity; npm view create-cf-d-infinity
