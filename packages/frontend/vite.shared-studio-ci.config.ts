import react from "@vitejs/plugin-react";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { defineConfig } from "vite";

const frontendRoot = fileURLToPath(new URL(".", import.meta.url));
const publicConfig = JSON.parse(process.env.INSTAFY_STUDIO_E2E_PUBLIC_CONFIG ?? "null") as {
  supabaseURL: string;
  anonKey: string;
  controllerURL: string;
} | null;
if (!publicConfig || Object.keys(publicConfig).sort().join(",") !== "anonKey,controllerURL,supabaseURL") {
  throw new Error("Run the isolated Shared Studio fixture to supply its public configuration.");
}
for (const value of [publicConfig.supabaseURL, publicConfig.controllerURL]) {
  const url = new URL(value);
  if (url.protocol !== "http:" || url.hostname !== "127.0.0.1" || !url.port ||
      url.username || url.password || url.search || url.hash || url.pathname !== "/") {
    throw new Error("Shared Studio CI accepts explicit literal-loopback origins only.");
  }
}
const claims = JSON.parse(Buffer.from(publicConfig.anonKey.split(".")[1] ?? "", "base64url").toString());
if (claims.role !== "anon" || claims.iss !== "supabase-demo" || claims.ref) {
  throw new Error("Shared Studio CI requires a disposable local anon key.");
}

// Serve the actual application entrypoint, not a component fixture. Keep the
// ordinary development config's auth-seeding, dotenv and private composition
// entirely outside this lane. Only these public values reach the renderer.
export default defineConfig({
  envDir: false,
  envPrefix: "INSTAFY_STUDIO_CI_UNUSED_",
  cacheDir: path.join(frontendRoot, "node_modules", ".vite-shared-studio-ci"),
  plugins: [react()],
  resolve: {
    alias: [{
      find: "virtual:instafy/frontend-feature-manifest",
      replacement: path.join(frontendRoot, "src/features/publicFrontendFeatureManifest.ts"),
    }],
    dedupe: ["react", "react-dom", "react-router-dom", "@instafy/sdk", "@instafy/provider-contract", "@capacitor/core"],
  },
  define: {
    "import.meta.env.VITE_SUPABASE_URL": JSON.stringify(publicConfig.supabaseURL),
    "import.meta.env.VITE_SUPABASE_ANON_KEY": JSON.stringify(publicConfig.anonKey),
    "import.meta.env.VITE_CONTROLLER_URL": JSON.stringify(publicConfig.controllerURL),
    "import.meta.env.VITE_INSTAFY_SHARED_BROWSER_CDP_SCREENCAST": JSON.stringify("1"),
    "import.meta.env.VITE_INSTAFY_SHARED_BROWSER_WEBRTC": JSON.stringify("0"),
    "import.meta.env.INSTAFY_DEV_CODEX_SEED_ENABLED": "false",
    __INSTAFY_BUILD_INFO__: JSON.stringify({ app: "instafy-frontend", packageVersion: "0.0.0-fixture" }),
  },
  server: {
    host: "127.0.0.1",
    strictPort: true,
    fs: {
      allow: [frontendRoot, path.resolve(frontendRoot, "../../node_modules"),
        path.resolve(frontendRoot, "../sdk"), path.resolve(frontendRoot, "../provider-contract"),
        path.resolve(frontendRoot, "../provider-client"), path.resolve(frontendRoot, "../ota-contracts")],
      deny: [".env", ".env.*", "*.{crt,pem}", "**/.git/**"],
      strict: true,
    },
  },
});
