# Security

D∞ (`cf-d-infinity`) is experimental software. It has not been audited, and it should not hold data you cannot
afford to lose or to have disclosed.

## Reporting a vulnerability

Please report privately through GitHub: open the repository's **Security** tab and choose **Report a vulnerability**.
Do not open a public issue for something that lets a caller read or change data they should not reach.

There is no response-time commitment and no bounty. Fixes go into the next alpha release; older alpha versions are not
patched.

## What counts

In scope: bypassing the token checks of the HTTP endpoint (`DINF_API_TOKEN`, `DINF_ADMIN_TOKEN`), forging a Hrana
baton, reaching `/admin/*` with a data token, SQL that escapes into the internal tables (names starting with `__`) or
corrupts another table's rows, and anything that breaks the isolation guarantees stated in the README.

Out of scope: a holder of `DINF_API_TOKEN` or of the Service Binding can run any SQL; that is the access model, not a
flaw. The benchmark build (`wrangler.bench.jsonc`) includes fault injection on purpose and must not be deployed with
real data.

## Dependencies

The Worker bundle includes `sql-parser-cst` and sql.js (SQLite compiled to WebAssembly). Vulnerabilities in those
projects should be reported to them; tell us too if this project needs to pin or patch.
