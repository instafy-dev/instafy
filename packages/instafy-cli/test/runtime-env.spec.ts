import { describe, expect, it } from "vitest";
import { buildRuntimeChildEnvironment } from "../src/runtime.js";

describe("runtime child environment", () => {
  it("keeps only scoped runtime credentials and removes launcher/user credentials", () => {
    const child = buildRuntimeChildEnvironment({
      PATH: "/bin",
      CONTROLLER_BASE_URL: "https://controller.example",
      RUNTIME_ACCESS_TOKEN: "runtime-machine-token",
      ORIGIN_ACCESS_TOKEN: "origin-token",
      ORIGIN_INTERNAL_TOKEN: "origin-internal-token",
      CONTROLLER_ACCESS_TOKEN: "interactive-controller-token",
      INSTAFY_ACCESS_TOKEN: "interactive-user-token",
      SUPABASE_ACCESS_TOKEN: "supabase-user-token",
      INSTAFY_SERVICE_TOKEN: "service-token",
      RUNTIME_TOKEN: "legacy-runtime-token",
      ORIGIN_TOKEN: "legacy-origin-token",
      WORKSPACE_ACCESS_TOKEN: "workspace-token",
      CONTROLLER_INTERNAL_TOKEN: "controller-internal-token",
      CONTROLLER_TOKEN: "legacy-service-token",
      CONTROLLER_BEARER: "legacy-controller-bearer",
      CONTROLLER_SERVICE_ROLE_KEY: "controller-service-role",
      SUPABASE_SERVICE_ROLE_KEY: "service-role",
      SUPABASE_SERVICE_KEY: "service-key",
      SERVICE_ROLE_KEY: "generic-service-role",
      PROXY_SIGNING_SECRET: "proxy-signing-secret",
      RUNTIME_SIGNING_PRIVATE_KEY: "runtime-signing-key",
      PROVIDER_AUTH_TOKEN: "provider-token",
      GIT_EDGE_CONTROLLER_TOKEN: "git-controller-token",
      TUNNEL_BROKER_TOKEN: "tunnel-token",
      SUPABASE_REFRESH_TOKEN: "refresh-a",
      INSTAFY_REFRESH_TOKEN: "refresh-b",
      CONTROLLER_REFRESH_TOKEN: "refresh-c",
      REFRESH_TOKEN: "refresh-d",
    });

    expect(child).toMatchObject({
      PATH: "/bin",
      CONTROLLER_BASE_URL: "https://controller.example",
      RUNTIME_ACCESS_TOKEN: "runtime-machine-token",
      ORIGIN_ACCESS_TOKEN: "origin-token",
      ORIGIN_INTERNAL_TOKEN: "origin-internal-token",
    });
    for (const key of [
      "CONTROLLER_ACCESS_TOKEN",
      "INSTAFY_ACCESS_TOKEN",
      "SUPABASE_ACCESS_TOKEN",
      "INSTAFY_SERVICE_TOKEN",
      "RUNTIME_TOKEN",
      "ORIGIN_TOKEN",
      "WORKSPACE_ACCESS_TOKEN",
      "CONTROLLER_INTERNAL_TOKEN",
      "CONTROLLER_TOKEN",
      "CONTROLLER_BEARER",
      "CONTROLLER_SERVICE_ROLE_KEY",
      "SUPABASE_SERVICE_ROLE_KEY",
      "SUPABASE_SERVICE_KEY",
      "SERVICE_ROLE_KEY",
      "PROXY_SIGNING_SECRET",
      "RUNTIME_SIGNING_PRIVATE_KEY",
      "PROVIDER_AUTH_TOKEN",
      "GIT_EDGE_CONTROLLER_TOKEN",
      "TUNNEL_BROKER_TOKEN",
      "SUPABASE_REFRESH_TOKEN",
      "INSTAFY_REFRESH_TOKEN",
      "CONTROLLER_REFRESH_TOKEN",
      "REFRESH_TOKEN",
    ]) {
      expect(child).not.toHaveProperty(key);
    }
  });
});
