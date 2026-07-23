import http from "node:http";

function readArg(flagName, fallback = "") {
  const exactIndex = process.argv.indexOf(flagName);
  if (exactIndex >= 0) {
    return process.argv[exactIndex + 1] ?? fallback;
  }
  const inline = process.argv.find((value) => value.startsWith(`${flagName}=`));
  return inline ? inline.slice(flagName.length + 1) : fallback;
}

const host = readArg("--host", "127.0.0.1");
const port = Number(readArg("--port", "0"));
const service = readArg("--service", "fixture-service");
const startupDelayMs = Number(readArg("--startup-delay-ms", "0"));

const server = http.createServer((request, response) => {
  if (request.url === "/health") {
    response.writeHead(200, {
      "content-type": "application/json; charset=utf-8",
      "cache-control": "no-store",
    });
    response.end(
      JSON.stringify({
        ok: true,
        service,
        pid: process.pid,
      }),
    );
    return;
  }

  response.writeHead(404, {
    "content-type": "application/json; charset=utf-8",
  });
  response.end(JSON.stringify({ ok: false }));
});

function shutdown() {
  server.close(() => {
    process.exit(0);
  });
}

process.on("SIGTERM", shutdown);
process.on("SIGINT", shutdown);

setTimeout(() => {
  server.listen(port, host, () => {
    console.log(`${service} listening on ${host}:${port}`);
  });
}, startupDelayMs);
