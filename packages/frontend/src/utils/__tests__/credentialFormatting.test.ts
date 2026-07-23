import { describe, expect, it } from "vitest";
import type { ControllerCredentialListItem } from "../../sdk/instafy";
import {
  formatCredentialKind,
  formatCredentialLastUsed,
  formatCredentialOptionLabel,
  formatCredentialRuntimeDetail,
  isLocalCodexCredential,
} from "../credentialFormatting";

function createCredential(
  overrides: Partial<ControllerCredentialListItem> = {},
): ControllerCredentialListItem {
  return {
    id: "credential-local-codex",
    kind: "codex_auth_json",
    label: "Local Codex auth.json",
    isDefault: true,
    metadata: { source: "codex_cli", provider: "openai" },
    lastUsedAt: "2026-06-08T11:45:40.000Z",
    revokedAt: null,
    createdAt: "2026-06-08T09:05:18.000Z",
    updatedAt: "2026-06-08T11:45:40.000Z",
    ...overrides,
  };
}

describe("credentialFormatting", () => {
  it("labels local Codex CLI credentials as machine-local", () => {
    const credential = createCredential();

    expect(isLocalCodexCredential(credential)).toBe(true);
    expect(formatCredentialKind(credential)).toBe("This machine");
    expect(formatCredentialOptionLabel(credential)).toBe("Local Codex auth.json · This machine");
  });

  it("formats last-used hints without exposing credential contents", () => {
    const credential = createCredential();
    const nowMs = Date.parse("2026-06-08T11:46:20.000Z");

    expect(formatCredentialLastUsed(credential, nowMs)).toBe("Last used just now");
    expect(formatCredentialRuntimeDetail(credential)).toContain("This machine");
  });
});
