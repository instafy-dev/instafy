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
  // Keep this required lane's optimizer state separate from normal development
  // and build caches. A fresh hosted checkout therefore proves the complete
  // explicit dependency list instead of inheriting a developer Vite scan.
  cacheDir: path.join(frontendRoot, "node_modules", ".vite-browser-ui-ci"),
  envFile: false,
  envPrefix: "INSTAFY_BROWSER_UI_CI_PUBLIC_",
  plugins: [react()],
  optimizeDeps: {
    // Avoid crawling the full application entrypoint and its auth/provider
    // graph. The component helper still receives stable optimized URLs for
    // the dependencies used by each synthetic fixture. Button-based browser
    // chrome also reaches use-sync-external-store's CommonJS shim through
    // react-aria-components, so optimize that package boundary as a unit.
    entries: [],
    include: ["react", "react-dom/client", "react-aria-components"],
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
