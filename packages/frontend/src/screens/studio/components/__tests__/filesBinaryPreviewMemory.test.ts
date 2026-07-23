import { afterEach, describe, expect, it } from "vitest";
import type { ControllerWorkspaceEntry } from "../../../../sdk/instafy";
import {
  buildBinaryPreviewScopeKey,
  clearRememberedBinaryPreviewRequests,
  readBinaryPreviewRequest,
  rememberBinaryPreviewRequest,
} from "../filesBinaryPreviewMemory";

const entry: ControllerWorkspaceEntry = {
  name: "preview.svg",
  path: "assets/preview.svg",
  kind: "file",
  size: 42,
  modified: "2026-07-15T00:00:00.000Z",
  mimeType: "image/svg+xml",
};

describe("files binary preview memory", () => {
  afterEach(() => clearRememberedBinaryPreviewRequests());

  it("requires both the authenticated owner and project to build a scope", () => {
    expect(buildBinaryPreviewScopeKey(null, "project-1")).toBeNull();
    expect(buildBinaryPreviewScopeKey("user-1", null)).toBeNull();
    expect(buildBinaryPreviewScopeKey("user-1", "project-1")).not.toBeNull();
  });

  it("isolates requests by user and project", () => {
    const firstUserScope = buildBinaryPreviewScopeKey("user-1", "project-1");
    const secondUserScope = buildBinaryPreviewScopeKey("user-2", "project-1");
    rememberBinaryPreviewRequest(firstUserScope, "image", entry);

    expect(readBinaryPreviewRequest(firstUserScope)).toEqual({ mode: "image", entry });
    expect(readBinaryPreviewRequest(secondUserScope)).toBeNull();
  });

  it("retains only safe entry metadata and never a raw preview URL", () => {
    const scope = buildBinaryPreviewScopeKey("user-1", "project-1");
    rememberBinaryPreviewRequest(scope, "unsupported", {
      ...entry,
      rawUrl: "https://example.test/private-token",
      imageUrl: "https://example.test/private-image",
    } as ControllerWorkspaceEntry);

    const remembered = readBinaryPreviewRequest(scope);
    expect(remembered).toEqual({ mode: "unsupported", entry });
    expect(remembered?.entry).not.toHaveProperty("rawUrl");
    expect(remembered?.entry).not.toHaveProperty("imageUrl");
  });
});
