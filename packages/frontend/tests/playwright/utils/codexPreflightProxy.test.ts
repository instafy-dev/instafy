import { describe, expect, it, vi } from "vitest";
import {
  buildCodexPreflightProxyRunArgs,
  cleanupCodexPreflightProxy,
  configureCodexPreflightProxyEnvironment,
  type CodexPreflightDockerResult,
} from "./codexPreflightProxy.js";

const options = {
  projectName: "instafy-codex-preflight-test",
  composePath: "/repo/docker/docker-compose.runtime.yml",
  containerName: "instafy-codex-preflight-test-proxy",
};

const success = (stdout = ""): CodexPreflightDockerResult => ({
  status: 0,
  stdout,
});

const missingContainer = (): CodexPreflightDockerResult => ({
  status: 1,
  stderr: `Error: No such container: ${options.containerName}`,
});

describe("buildCodexPreflightProxyRunArgs", () => {
  it("publishes the copied-auth proxy only on IPv4 loopback", () => {
    const args = buildCodexPreflightProxyRunArgs({
      ...options,
      hostPort: 8799,
      build: false,
    });

    expect(args).toEqual([
      "compose",
      "-p",
      options.projectName,
      "-f",
      options.composePath,
      "run",
      "--detach",
      "--no-deps",
      "--name",
      options.containerName,
      "--publish",
      "127.0.0.1:8799:8789",
      "proxy",
    ]);
    expect(args).not.toContain("--service-ports");
  });

  it("keeps image rebuilding scoped to the one-off proxy run", () => {
    const args = buildCodexPreflightProxyRunArgs({
      ...options,
      hostPort: 8799,
      build: true,
    });

    expect(args.slice(-2)).toEqual(["--build", "proxy"]);
  });

  it.each([0, 65_536, Number.NaN, 8799.5])(
    "rejects invalid host port %s",
    (hostPort) => {
      expect(() =>
        buildCodexPreflightProxyRunArgs({
          ...options,
          hostPort,
          build: false,
        }),
      ).toThrow("Invalid Codex preflight proxy port");
    },
  );
});

describe("configureCodexPreflightProxyEnvironment", () => {
  it("mounts copied auth without allowing an API key to shadow it, then restores env", () => {
    const environment: Record<string, string | undefined> = {
      PROXY_PORT: "8789",
      CONTROLLER_INTERNAL_TOKEN: "controller-token",
      PROXY_CODEX_VOLUME: "/original/auth",
      OPENAI_API_KEY: "paid-key",
      UNRELATED: "preserved",
    };

    const restore = configureCodexPreflightProxyEnvironment(environment, {
      hostPort: 8799,
      authDirectory: "/temporary/auth",
    });

    expect(environment).toEqual({
      PROXY_PORT: "8799",
      PROXY_CODEX_VOLUME: "/temporary/auth",
      UNRELATED: "preserved",
    });

    restore();
    restore();
    expect(environment).toEqual({
      PROXY_PORT: "8789",
      CONTROLLER_INTERNAL_TOKEN: "controller-token",
      PROXY_CODEX_VOLUME: "/original/auth",
      OPENAI_API_KEY: "paid-key",
      UNRELATED: "preserved",
    });
  });

  it("retains API-key auth when no copied auth directory is available", () => {
    const environment: Record<string, string | undefined> = {
      OPENAI_API_KEY: "paid-key",
    };
    const restore = configureCodexPreflightProxyEnvironment(environment, {
      hostPort: 8799,
      authDirectory: null,
    });

    expect(environment).toEqual({
      OPENAI_API_KEY: "paid-key",
      PROXY_PORT: "8799",
    });

    restore();
    expect(environment).toEqual({ OPENAI_API_KEY: "paid-key" });
  });
});

describe("cleanupCodexPreflightProxy", () => {
  it("accepts cleanup only after the named proxy is confirmed absent", () => {
    const runDocker = vi
      .fn()
      .mockReturnValueOnce(success())
      .mockReturnValueOnce(missingContainer());

    expect(() => cleanupCodexPreflightProxy(options, runDocker)).not.toThrow();
    expect(runDocker.mock.calls).toEqual([
      [[
        "compose",
        "-p",
        options.projectName,
        "-f",
        options.composePath,
        "down",
        "--remove-orphans",
      ]],
      [["container", "inspect", options.containerName]],
    ]);
  });

  it("force-removes a survivor and then fails closed", () => {
    const runDocker = vi
      .fn()
      .mockReturnValueOnce(success())
      .mockReturnValueOnce(success("container-json"))
      .mockReturnValueOnce(success())
      .mockReturnValueOnce(missingContainer());

    expect(() => cleanupCodexPreflightProxy(options, runDocker)).toThrow(
      /proxy cleanup required recovery.*no longer present.*failing closed/i,
    );
    expect(runDocker).toHaveBeenNthCalledWith(3, [
      "container",
      "rm",
      "--force",
      options.containerName,
    ]);
  });

  it("makes a Compose cleanup failure fatal after force-removing the proxy", () => {
    const runDocker = vi
      .fn()
      .mockReturnValueOnce({ status: 1, stderr: "daemon cleanup error" })
      .mockReturnValueOnce(success("container-json"))
      .mockReturnValueOnce(success())
      .mockReturnValueOnce(missingContainer());

    expect(() => cleanupCodexPreflightProxy(options, runDocker)).toThrow(
      /failing closed.*compose down failed/i,
    );
  });

  it("reports a security-fatal error when forced removal cannot be verified", () => {
    const runDocker = vi
      .fn()
      .mockReturnValueOnce({ status: 1, stderr: "daemon cleanup error" })
      .mockReturnValueOnce(success("container-json"))
      .mockReturnValueOnce({ status: 1, stderr: "remove failed" })
      .mockReturnValueOnce(success("container-json"));

    expect(() => cleanupCodexPreflightProxy(options, runDocker)).toThrow(
      /SECURITY: Unable to confirm removal.*may still expose copied Codex auth/i,
    );
  });
});
