#!/usr/bin/env node

import { getSpeechBackendDependencyStatus, runSpeechBackendBootstrap } from "./speech-backend-bootstrap.mjs";

function printUsage() {
  console.log(`Usage:
  node ./scripts/speech-bootstrap-cli.mjs check
  node ./scripts/speech-bootstrap-cli.mjs install-transcription [--dry-run]`);
}

function formatAction(action) {
  const suffix = action.detail ? ` (${action.detail})` : "";
  return `- ${action.label}: ${action.command}${suffix}`;
}

function printStatus(status) {
  console.log(
    JSON.stringify(
      {
        supported: status.supported,
        platform: status.platform,
        transcription: status.transcription,
        synthesis: status.synthesis,
        localService: status.localService,
        actions: status.actions,
        nextSteps: status.nextSteps,
      },
      null,
      2,
    ),
  );
}

async function main() {
  const command = process.argv[2] ?? "check";
  const dryRun = process.argv.includes("--dry-run");

  if (command === "check") {
    printStatus(await getSpeechBackendDependencyStatus());
    return;
  }

  if (command === "install-transcription") {
    const result = await runSpeechBackendBootstrap({
      action: "install_transcription",
      dryRun,
    });
    if (!result.ok) {
      console.error(result.error || "Speech bootstrap failed.");
      if (result.status) {
        console.error(JSON.stringify(result.status, null, 2));
      }
      process.exitCode = 1;
      return;
    }
    console.log(`Speech bootstrap action: ${result.action}`);
    if (result.commandsRun?.length) {
      console.log("Commands:");
      for (const item of result.commandsRun) {
        console.log(`- ${item}`);
      }
    }
    if (result.status?.actions?.length) {
      console.log("Remaining actions:");
      for (const action of result.status.actions) {
        console.log(formatAction(action));
      }
    }
    if (result.status) {
      printStatus(result.status);
    }
    return;
  }

  printUsage();
  process.exitCode = 1;
}

void main();
