import { afterEach, describe, expect, it, vi } from "vitest";
import {
  getDefaultRuntimeEnv,
  getDefaultRuntimeMetadata,
  getWebdevRuntimeEnv,
  shouldUseLocalWebdevRuntime,
} from "./webdevRuntime";

describe("webdevRuntime helpers", () => {
  afterEach(() => {
    vi.unstubAllEnvs();
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
