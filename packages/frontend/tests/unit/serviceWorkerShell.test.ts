import { readFileSync } from "node:fs";
import vm from "node:vm";
import { describe, expect, it } from "vitest";

const SHELL = '<!doctype html><html><body><div id="root"></div></body></html>';
const ABUSE = readFileSync(new URL("../../public/abuse.html", import.meta.url), "utf8");

// Runs public/sw.js with a fake network and cache, then sends it one page load.
async function navigate(path: string, body: string, contentType: string) {
  const stored = new Map<string, string>([["/index.html", SHELL.replace("<body>", "<body>old")]]);
  const cache = {
    put: async (key: string, response: Response) => void stored.set(key, await response.text()),
    match: async (key: string) => (stored.has(key) ? new Response(stored.get(key)) : undefined),
  };
  const listeners = new Map<string, (event: unknown) => void>();
  const context = vm.createContext({
    URL,
    Response,
    Promise,
    caches: { open: async () => cache },
    fetch: async () => new Response(body, { headers: { "Content-Type": contentType } }),
    self: {
      location: { origin: "https://studio.example.test" },
      addEventListener: (name: string, listener: (event: unknown) => void) => listeners.set(name, listener),
    },
  });
  vm.runInContext(readFileSync(new URL("../../public/sw.js", import.meta.url), "utf8"), context);
  let reply: Promise<Response> | undefined;
  listeners.get("fetch")?.({
    request: { url: `https://studio.example.test${path}`, mode: "navigate", method: "GET" },
    respondWith: (response: Promise<Response>) => {
      reply = response;
    },
  });
  const served = await reply;
  return { served: await served?.text(), shell: stored.get("/index.html") };
}

describe("service worker offline shell", () => {
  it("keeps the app shell from a page load of the app", async () => {
    const { served, shell } = await navigate("/studio", SHELL, "text/html; charset=utf-8");
    expect(served).toBe(SHELL);
    expect(shell).toBe(SHELL);
  });

  it("does not replace the shell with a page served as its own file", async () => {
    for (const [path, body, type] of [
      ["/abuse", ABUSE, "text/html; charset=utf-8"],
      ["/robots.txt", "User-agent: *", "text/plain"],
    ]) {
      const { served, shell } = await navigate(path, body, type);
      expect(served, path).toBe(body);
      expect(shell, path).toContain("<body>old");
    }
  });
});
