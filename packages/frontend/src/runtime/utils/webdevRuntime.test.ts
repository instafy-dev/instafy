import { afterEach, describe, expect, it, vi } from "vitest";
import {
  extractRuntimeAgentImage,
  getDefaultRuntimeEnv,
  getDefaultRuntimeMetadata,
  getWebdevRuntimeEnv,
  runtimeImageLooksDefault,
  runtimeImageLooksWebdev,
  shouldUseLocalWebdevRuntime,
} from "./webdevRuntime";

describe("webdevRuntime helpers", () => {
  afterEach(() => {
    vi.unstubAllEnvs();
  });

  it("extracts runtime image from direct metadata key", () => {
    expect(
      extractRuntimeAgentImage({
        runtimeAgentImage: "ghcr.io/instafy-dev/instafy-runtime-agent:webdev",
      }),
    ).toBe("ghcr.io/instafy-dev/instafy-runtime-agent:webdev");
  });

  it("extracts runtime image from metadata env map", () => {
    expect(
      extractRuntimeAgentImage({
        env: {
          RUNTIME_AGENT_IMAGE: "runtime-agent:local",
        },
      }),
    ).toBe("runtime-agent:local");
  });

  it("detects webdev image references", () => {
    expect(runtimeImageLooksWebdev("runtime-agent:webdev")).toBe(true);
    expect(
      runtimeImageLooksWebdev("ghcr.io/instafy-dev/instafy-runtime-agent:webdev"),
    ).toBe(true);
    expect(runtimeImageLooksWebdev("ghcr.io/instafy-dev/instafy-runtime-agent:latest")).toBe(
      false,
    );
  });

  it("detects default image references", () => {
    expect(runtimeImageLooksDefault("runtime-agent:webdev")).toBe(true);
    expect(
      runtimeImageLooksDefault("ghcr.io/instafy-dev/instafy-runtime-agent:webdev"),
    ).toBe(false);
    expect(runtimeImageLooksDefault("runtime-agent:local")).toBe(true);
    expect(
      runtimeImageLooksDefault("ghcr.io/instafy-dev/instafy-runtime-agent:latest"),
    ).toBe(true);
    expect(runtimeImageLooksDefault("ghcr.io/acme/custom:1")).toBe(false);
  });

  it("includes browser-session env for webdev runtime defaults", () => {
    const env = getWebdevRuntimeEnv();
    expect(env.INSTAFY_ENABLE_BROWSER_SESSION).toBe("1");
    expect(env.INSTAFY_VNC_PORT).toBe("5900");
    expect(env.INSTAFY_VNC_GEOMETRY).toBe("1280x720");
    expect(env.RUNTIME_AGENT_IMAGE).toBeUndefined();
    expect(env.RUNTIME_CAPABILITIES).toBeUndefined();
    expect(env.RUNTIME_AGENT_BUILD_TARGET).toBeUndefined();
  });

  it("keeps default hosted runtime env non-browser by default", () => {
    const env = getDefaultRuntimeEnv("localhost");
    expect(env.INSTAFY_ENABLE_BROWSER_SESSION).toBeUndefined();
    expect(env.INSTAFY_VNC_PORT).toBeUndefined();
    expect(env.INSTAFY_VNC_GEOMETRY).toBeUndefined();
  });

  it("omits image overrides for default hosted production runtimes", () => {
    expect(getDefaultRuntimeEnv("app.instafy.dev")).toEqual({});
    expect(getDefaultRuntimeMetadata("studio", "app.instafy.dev")).toEqual({
      source: "studio",
      runtimeImagePreset: "default",
    });
  });

  it("keeps local dev default runtime image overrides local-only", () => {
    expect(getDefaultRuntimeMetadata("studio", "localhost")).toEqual({
      source: "studio",
      runtimeImagePreset: "default",
      runtimeAgentImage: "runtime-agent:webdev",
      env: {
        RUNTIME_AGENT_IMAGE: "runtime-agent:webdev",
        RUNTIME_AGENT_BUILD_TARGET: "runtime-webdev",
      },
    });
  });

  it("does not use local runtime images for production previews served from localhost", () => {
    expect(shouldUseLocalWebdevRuntime("127.0.0.1", "http:", true)).toBe(false);
    expect(getDefaultRuntimeEnv("127.0.0.1", "http:", true)).toEqual({});
    expect(getDefaultRuntimeMetadata("studio", "127.0.0.1", "http:", true)).toEqual({
      source: "studio",
      runtimeImagePreset: "default",
    });
  });

  it("does not use local runtime images for production-mode dev servers", () => {
    vi.stubEnv("MODE", "production");

    expect(shouldUseLocalWebdevRuntime("127.0.0.1", "http:")).toBe(false);
    expect(getDefaultRuntimeEnv("127.0.0.1", "http:")).toEqual({});
    expect(getDefaultRuntimeMetadata("studio", "127.0.0.1", "http:")).toEqual({
      source: "studio",
      runtimeImagePreset: "default",
    });
  });

  it("does not use local runtime images for capacitor native localhost", () => {
    expect(shouldUseLocalWebdevRuntime("localhost", "capacitor:")).toBe(false);
    expect(getDefaultRuntimeEnv("localhost", "capacitor:")).toEqual({});
  });
});
