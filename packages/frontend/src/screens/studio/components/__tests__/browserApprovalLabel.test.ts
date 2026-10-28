import { describe, expect, it } from "vitest";
import { splitBrowserApprovalLabel } from "../browserApprovalLabel";

describe("splitBrowserApprovalLabel", () => {
  it("takes the runtime's category off the control's name and says what it adds", () => {
    // The live test of 2026-10-27 read "Change something: unnamed button in the top right".
    expect(splitBrowserApprovalLabel("Change something: unnamed button in the top right"))
      .toEqual({ label: "unnamed button in the top right", note: null });
    expect(splitBrowserApprovalLabel("Delete, cancel or sign out: Delete account"))
      .toEqual({ label: "Delete account", note: "It may delete, cancel or sign out of something." });
    expect(splitBrowserApprovalLabel("Purchase or payment: Buy now"))
      .toEqual({ label: "Buy now", note: "It may buy something or start a payment." });
    expect(splitBrowserApprovalLabel("Download or export")).toEqual({ label: "", note: "It may download or export data." });
  });

  it("leaves a name alone that only looks like a category", () => {
    for (const label of ["Pesquisa", "Note: Save", "change something: Save", "Change something:Save", "Octo's tab 1: Pesquisa"]) {
      expect(splitBrowserApprovalLabel(label)).toEqual({ label, note: null });
    }
  });
});
