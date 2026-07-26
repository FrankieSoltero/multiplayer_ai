#!/usr/bin/env node
// v1 runs from a checkout (spec §5): tsx compiles src/cli.ts on the fly.
import { register } from "tsx/esm/api";
register();
const { main } = await import("../src/cli.ts");
const code = await main(process.argv.slice(2));
if (code !== null) process.exit(code);
