#!/usr/bin/env node
import { readFileSync } from "node:fs";
import { Conflict, apply, plan, report } from "./src/init.js";

const { version } = JSON.parse(readFileSync(new URL("./package.json", import.meta.url), "utf8"));
const HELP = `create-cf-d-infinity ${version}

Usage: create-cf-d-infinity [init] [options]

In a directory with a wrangler.jsonc, init adds cf-d-infinity to that Worker: three Durable Object
bindings, their migration, a Service Binding to the DinfDatabase entrypoint, DINF_SHARD_COUNT and a
one-minute Cron Trigger for the autoscaler. Comments in the file are kept. It also writes the module
that re-exports the classes and adds the dependency to package.json.

In a directory without a wrangler config, init creates a database-only Worker that other Workers bind to.

Nothing is written if any step would conflict with what is already there. A second run changes nothing.

Options:
  --binding <NAME>   name of the Service Binding (default DINF_DB)
  --shards <N>       number of shards to start with (default 8)
  --no-autoscale     do not add the Cron Trigger
  --name <NAME>      Worker name for a new database Worker (default: the directory name)
  --dry-run          print the plan and write nothing
  -h, --help         show this help
  -v, --version      show the version
`;

function main(argv) {
  const options = { version };
  let dryRun = false;
  const args = argv[0] === "init" ? argv.slice(1) : argv;
  for (let i = 0; i < args.length; i++) {
    const a = args[i];
    const value = () => {
      const v = args[++i];
      if (v === undefined) throw new Conflict(`${a} needs a value`);
      return v;
    };
    if (a === "-h" || a === "--help") return console.log(HELP);
    if (a === "-v" || a === "--version") return console.log(version);
    if (a === "--binding") options.binding = value();
    else if (a === "--shards") options.shards = Number(value());
    else if (a === "--name") options.name = value();
    else if (a === "--no-autoscale") options.autoscale = false;
    else if (a === "--dry-run") dryRun = true;
    // 公開前の版を試すための指定 (例: file:../cf-d-infinity-0.1.0.tgz)。
    else if (a === "--package-spec") options.packageSpec = value();
    else throw new Conflict(`unknown argument ${a}; see --help`);
  }
  const cwd = process.cwd();
  const result = plan(cwd, options);
  if (!dryRun) apply(result);
  console.log(report(result, cwd) + (dryRun ? "\n\n(dry run: nothing was written)" : ""));
}

try {
  main(process.argv.slice(2));
} catch (e) {
  if (!(e instanceof Conflict)) throw e;
  console.error(`create-cf-d-infinity: ${e.message}\nNothing was written.`);
  process.exitCode = 1;
}
