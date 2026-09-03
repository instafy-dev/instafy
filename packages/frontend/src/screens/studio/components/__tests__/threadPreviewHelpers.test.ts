import { describe, expect, it } from "vitest";
import { stripShellWrapperFromCommand } from "../threadPreviewHelpers";

describe("stripShellWrapperFromCommand", () => {
  const command = "whoami; git -C ~/work/core rev-parse --short HEAD";

  it("strips an absolute-path bash login wrapper", () => {
    expect(stripShellWrapperFromCommand(`/bin/bash -lc ${command}`)).toBe(command);
  });

  it("strips a bare bash login wrapper", () => {
    expect(stripShellWrapperFromCommand(`bash -lc ${command}`)).toBe(command);
  });

  it("strips an sh -c wrapper", () => {
    expect(stripShellWrapperFromCommand(`sh -c ${command}`)).toBe(command);
  });

  it("strips a zsh login wrapper", () => {
    expect(stripShellWrapperFromCommand(`zsh -lc ${command}`)).toBe(command);
  });

  it("unwraps the quoted-argument form", () => {
    expect(stripShellWrapperFromCommand(`bash -lc '${command}'`)).toBe(command);
    expect(stripShellWrapperFromCommand(`/bin/bash -lc "${command}"`)).toBe(command);
  });

  it("unwraps nested wrappers", () => {
    expect(stripShellWrapperFromCommand(`/bin/bash -lc bash -lc '${command}'`)).toBe(command);
  });

  it("leaves a command without a wrapper untouched", () => {
    expect(stripShellWrapperFromCommand(command)).toBe(command);
    expect(stripShellWrapperFromCommand("pnpm --filter @instafy/frontend test:unit")).toBe(
      "pnpm --filter @instafy/frontend test:unit",
    );
  });

  it("does not strip shells that appear mid-command or without a -c flag", () => {
    expect(stripShellWrapperFromCommand("echo hi | bash -lc cat")).toBe("echo hi | bash -lc cat");
    expect(stripShellWrapperFromCommand("bash ./scripts/run.sh")).toBe("bash ./scripts/run.sh");
  });

  it("keeps a wrapper with an empty body as-is", () => {
    expect(stripShellWrapperFromCommand("bash -lc ''")).toBe("bash -lc ''");
  });
});
