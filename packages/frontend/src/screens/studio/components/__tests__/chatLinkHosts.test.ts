import { describe, expect, it } from "vitest";
import {
  describeKnownLinkHost,
  labelAlreadyNamesHost,
  readLinkHost,
  KNOWN_LINK_HOSTS,
} from "../chatLinkHosts";

// The list decides which links in the chat may wear a product's mark instead
// of its address. Chat text arrives near-verbatim from a model that reads
// SKILL.md files fetched from arbitrary repositories, so being on this list is
// a claim a reviewer made in that file and nothing a pack can assert.

describe("chat link hosts", () => {
  it("matches a host and its subdomains, and nothing that merely ends the same way", () => {
    expect(describeKnownLinkHost("https://notion.so/x")?.name).toBe("Notion");
    expect(describeKnownLinkHost("https://www.notion.so/x")?.name).toBe("Notion");
    expect(describeKnownLinkHost("https://app.notion.so/developers")?.name).toBe("Notion");
    // The two shapes a look-alike takes.
    expect(describeKnownLinkHost("https://notion.so.evil.test/verify")).toBeNull();
    expect(describeKnownLinkHost("https://evilnotion.so/verify")).toBeNull();
  });

  it("refuses anything that is not an http or https address", () => {
    expect(readLinkHost("javascript:alert(1)")).toBeNull();
    expect(readLinkHost("data:text/html;base64,PHNjcmlwdD4=")).toBeNull();
    expect(readLinkHost("file:///etc/passwd")).toBeNull();
    expect(readLinkHost("not a url at all")).toBeNull();
  });

  it("does not repeat a host the label already names", () => {
    expect(labelAlreadyNamesHost("Open example.com", "example.com")).toBe(true);
    expect(labelAlreadyNamesHost("Open the docs", "example.com")).toBe(false);
  });

  it("carries a mark and a name for every entry, since a bare entry would render nothing", () => {
    for (const entry of KNOWN_LINK_HOSTS) {
      expect(entry.host).not.toContain("/");
      expect(entry.host).toBe(entry.host.toLowerCase());
      expect(entry.name.length).toBeGreaterThan(0);
      expect(typeof entry.mark).not.toBe("undefined");
    }
  });
});
