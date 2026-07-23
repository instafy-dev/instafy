import util from "node:util";

type DesktopLogLevel = "info" | "warn" | "error";

let loggingInitialized = false;
let stdoutBroken = false;
let stderrBroken = false;

function isBrokenPipeError(error: unknown): error is NodeJS.ErrnoException {
  return error instanceof Error && (error as NodeJS.ErrnoException).code === "EPIPE";
}

function markBrokenStream(stream: "stdout" | "stderr") {
  if (stream === "stdout") {
    stdoutBroken = true;
    return;
  }
  stderrBroken = true;
}

function safeWrite(stream: NodeJS.WriteStream, value: string, streamName: "stdout" | "stderr") {
  try {
    stream.write(value);
  } catch (error) {
    if (isBrokenPipeError(error)) {
      markBrokenStream(streamName);
      return;
    }
    throw error;
  }
}

function handleStreamError(streamName: "stdout" | "stderr", error: Error) {
  if (isBrokenPipeError(error)) {
    markBrokenStream(streamName);
    return;
  }
  throw error;
}

export function installDesktopLogging() {
  if (loggingInitialized) {
    return;
  }
  loggingInitialized = true;

  process.stdout.on("error", (error) => handleStreamError("stdout", error));
  process.stderr.on("error", (error) => handleStreamError("stderr", error));
}

export function desktopLog(level: DesktopLogLevel, ...args: unknown[]) {
  installDesktopLogging();
  const line = `${util.format(...args)}\n`;
  if (level === "warn" || level === "error") {
    if (stderrBroken) {
      return;
    }
    safeWrite(process.stderr, line, "stderr");
    return;
  }

  if (stdoutBroken) {
    return;
  }
  safeWrite(process.stdout, line, "stdout");
}
