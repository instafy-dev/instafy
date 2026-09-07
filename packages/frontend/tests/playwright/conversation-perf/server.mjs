import { build, preview } from "vite";
import { fileURLToPath } from "node:url";

const configFile = fileURLToPath(new URL("../../../vite.conversation-perf.config.ts", import.meta.url));
await build({ configFile });
const server = await preview({ configFile });
server.printUrls();
for (const signal of ["SIGINT", "SIGTERM"]) {
  process.once(signal, () => {
    server.httpServer.close(() => process.exit(0));
    server.httpServer.closeAllConnections();
  });
}
