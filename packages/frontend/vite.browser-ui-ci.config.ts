import react from "@vitejs/plugin-react";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { defineConfig } from "vite";

const frontendRoot = fileURLToPath(new URL(".", import.meta.url));
const workspaceDependencyRoot = path.resolve(frontendRoot, "..", "..", "node_modules");

/**
 * Minimal Vite transform server for the required browser-component CI lane.
 *
 * Unlike the normal development configuration, this does not load `.env`
 * files, resolve a provider feature manifest, or expose the usual `VITE_`
 * process environment. The selected specs provide their own in-browser
 * fixtures and use this server only to transform the production components
 * and styles they mount.
 */
export default defineConfig({
  envFile: false,
  envPrefix: "INSTAFY_BROWSER_UI_CI_PUBLIC_",
  plugins: [react()],
  optimizeDeps: {
    // Avoid crawling the full application entrypoint and its auth/provider
    // graph. The component helper still receives stable optimized URLs for
    // the two dependencies used by each synthetic fixture.
    entries: [],
    include: ["react", "react-dom/client"],
    noDiscovery: true,
  },
  server: {
    fs: {
      // Do not grant the fixture server Vite's usual whole-workspace read
      // scope. Production component sources live here; pnpm's real dependency
      // files live under the workspace-level node_modules directory.
      allow: [frontendRoot, workspaceDependencyRoot],
      deny: [".env", ".env.*", "*.{crt,pem}", "**/.git/**"],
      strict: true,
    },
    host: "127.0.0.1",
    // The health-check request serves the repository index, but this lane
    // never executes it. Do not let Vite eagerly transform that application's
    // auth/provider import graph in the background.
    preTransformRequests: false,
    strictPort: true,
  },
});
