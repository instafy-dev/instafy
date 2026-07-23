#!/usr/bin/env node
import { runCli } from "../dist/cli.js";

try {
  await runCli(process.argv);
} catch (err) {
  console.error(err);
  process.exit(1);
}
