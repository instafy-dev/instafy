import { once } from "node:events";
import { randomUUID } from "node:crypto";
import fs from "node:fs";
import http from "node:http";
import os from "node:os";
import path from "node:path";
import { spawn, spawnSync } from "node:child_process";
import { describe, expect, it } from "vitest";

async function readAll(stream: NodeJS.ReadableStream) {
  const chunks: Buffer[] = [];
  for await (const chunk of stream) {
    chunks.push(typeof chunk === "string" ? Buffer.from(chunk) : chunk);
  }
  return Buffer.concat(chunks).toString("utf8");
}

async function execCli(args: string[], options: { cwd: string; env?: NodeJS.ProcessEnv }) {
  const packageRoot = new URL("../", import.meta.url).pathname;
  const entry = path.join(packageRoot, "dist", "index.js");
  const tmpHome = fs.mkdtempSync(path.join(os.tmpdir(), "instafy-cli-home-"));
  try {
    const child = spawn("node", [entry, ...args], {
      env: { ...process.env, HOME: tmpHome, ...options.env },
      cwd: options.cwd,
      stdio: ["ignore", "pipe", "pipe"],
    });

    const stdoutPromise = readAll(child.stdout);
    const stderrPromise = readAll(child.stderr);
    const [code] = (await once(child, "exit")) as [number | null];
    const stdout = await stdoutPromise;
    const stderr = await stderrPromise;
    return { code, stdout, stderr };
  } finally {
    fs.rmSync(tmpHome, { recursive: true, force: true });
  }
}

function initCanonicalRepo(rootDir: string) {
  fs.mkdirSync(path.join(rootDir, ".instafy"), { recursive: true });
  const gitDir = path.join(rootDir, ".instafy", ".git");
  const init = spawnSync(
    "git",
    ["--git-dir", gitDir, "--work-tree", rootDir, "init", "--initial-branch=main"],
    { encoding: "utf8" },
  );
  if (init.status !== 0) {
    throw new Error(`git init failed: ${init.stderr || init.stdout}`);
  }
}

describe("instafy git", () => {
  it("prints help without a workspace", async () => {
    const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "instafy-cli-git-help-"));
    try {
      const { code, stdout } = await execCli(["git", "--help"], { cwd: tmpDir });
      expect(code).toBe(0);
      expect(stdout).toContain("instafy git <git-args...>");
    } finally {
      fs.rmSync(tmpDir, { recursive: true, force: true });
    }
  });

  it(
    "runs git against .instafy/.git (auto-detected upward)",
    async () => {
    const rootDir = fs.mkdtempSync(path.join(os.tmpdir(), "instafy-cli-git-root-"));
    try {
      initCanonicalRepo(rootDir);

      const nested = path.join(rootDir, "sub", "dir");
      fs.mkdirSync(nested, { recursive: true });

      const { code, stdout, stderr } = await execCli(["git", "rev-parse", "--show-prefix"], {
        cwd: nested,
      });
      if (code !== 0) {
        // eslint-disable-next-line no-console
        console.error("stdout:", stdout, "stderr:", stderr);
      }
      expect(code).toBe(0);
      expect(stdout.trim()).toBe("sub/dir/");

      const gitDir = path.join(rootDir, ".instafy", ".git");
      const resolved = await execCli(["git", "rev-parse", "--git-dir"], { cwd: nested });
      expect(resolved.code).toBe(0);
      expect(fs.realpathSync(resolved.stdout.trim())).toBe(fs.realpathSync(gitDir));
    } finally {
      fs.rmSync(rootDir, { recursive: true, force: true });
    }
    },
    20_000,
  );

  it(
    "repairs stale canonical origin remotes from runtime env",
    async () => {
      const rootDir = fs.mkdtempSync(path.join(os.tmpdir(), "instafy-cli-git-remote-"));
      try {
        initCanonicalRepo(rootDir);
        const setOldRemote = spawnSync(
          "git",
          [
            "--git-dir",
            path.join(rootDir, ".instafy", ".git"),
            "--work-tree",
            rootDir,
            "remote",
            "add",
            "origin",
            "http://git-edge:8080/old-project.git",
          ],
          { encoding: "utf8" },
        );
        if (setOldRemote.status !== 0) {
          throw new Error(`git remote add failed: ${setOldRemote.stderr || setOldRemote.stdout}`);
        }

        const { code, stdout, stderr } = await execCli(["git", "remote", "get-url", "origin"], {
          cwd: rootDir,
          env: {
            ORIGIN_GIT_REMOTE_URL: "http://host.docker.internal:8080/new-project.git",
          },
        });
        if (code !== 0) {
          // eslint-disable-next-line no-console
          console.error("stdout:", stdout, "stderr:", stderr);
        }

        expect(code).toBe(0);
        expect(stdout.trim()).toBe("http://host.docker.internal:8080/new-project.git");
      } finally {
        fs.rmSync(rootDir, { recursive: true, force: true });
      }
    },
    20_000,
  );

  it(
    "stages files inside embedded git repos (git-inside-git)",
    async () => {
      const rootDir = fs.mkdtempSync(path.join(os.tmpdir(), "instafy-cli-git-embedded-"));
      try {
        initCanonicalRepo(rootDir);

        const embedded = path.join(rootDir, "nested");
        fs.mkdirSync(embedded, { recursive: true });
        const initEmbedded = spawnSync("git", ["init"], { cwd: embedded, encoding: "utf8" });
        if (initEmbedded.status !== 0) {
          throw new Error(`embedded git init failed: ${initEmbedded.stderr || initEmbedded.stdout}`);
        }

        fs.writeFileSync(path.join(embedded, "hello.txt"), "embedded-hello\n", "utf8");

        const add = await execCli(["git", "add", "-A"], { cwd: rootDir });
        if (add.code !== 0) {
          // eslint-disable-next-line no-console
          console.error("stdout:", add.stdout, "stderr:", add.stderr);
        }
        expect(add.code).toBe(0);

        const staged = await execCli(["git", "diff", "--cached", "--name-only"], { cwd: rootDir });
        expect(staged.code).toBe(0);
        expect(staged.stdout.trim()).toBe("nested/hello.txt");

        const index = await execCli(["git", "ls-files", "--stage"], { cwd: rootDir });
        expect(index.code).toBe(0);
        expect(index.stdout).toContain("nested/hello.txt");
        expect(index.stdout).not.toMatch(/^160000\\s/m);
      } finally {
        fs.rmSync(rootDir, { recursive: true, force: true });
      }
    },
    20_000,
  );

  it(
    "calls Origin /git/sync",
    async () => {
      const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "instafy-cli-git-sync-"));
      const requests: Array<{ method: string; url: string; auth: string | null; body: unknown }> = [];

      const server = http.createServer(async (req, res) => {
        const bodyRaw = await readAll(req);
        let body: unknown = null;
        try {
          body = bodyRaw.trim() ? JSON.parse(bodyRaw) : null;
        } catch {
          body = bodyRaw;
        }

        requests.push({
          method: req.method ?? "",
          url: req.url ?? "",
          auth: typeof req.headers.authorization === "string" ? req.headers.authorization : null,
          body,
        });

        if ((req.url ?? "") !== "/git/sync") {
          res.statusCode = 404;
          res.end("not found");
          return;
        }

        res.setHeader("content-type", "application/json");
        res.end(JSON.stringify({ rev: "deadbeef" }));
      });

      await new Promise<void>((resolve) => {
        server.listen(0, "127.0.0.1", () => resolve());
      });

      const address = server.address();
      const port = typeof address === "object" && address ? address.port : 0;
      const originEndpoint = `http://127.0.0.1:${port}`;

      try {
        const { code, stdout, stderr } = await execCli(["git", "sync", "-m", "playwright: sync"], {
          cwd: tmpDir,
          env: {
            ORIGIN_ENDPOINT: originEndpoint,
            ORIGIN_ACCESS_TOKEN: "test-origin-token",
          },
        });
        if (code !== 0) {
          // eslint-disable-next-line no-console
          console.error("stdout:", stdout, "stderr:", stderr);
        }
        expect(code).toBe(0);
        expect(stdout.trim()).toBe("deadbeef");
        expect(requests).toHaveLength(1);
        expect(requests[0]).toMatchObject({
          method: "POST",
          url: "/git/sync",
          auth: "Bearer test-origin-token",
        });

        const body = requests[0]?.body as { message?: string } | null;
        expect(body?.message).toBe("playwright: sync");
      } finally {
        await new Promise<void>((resolve) => {
          server.close(() => resolve());
        });
        fs.rmSync(tmpDir, { recursive: true, force: true });
      }
    },
    20_000,
  );

  it(
    "mints a fresh origin token from the controller when runtime context is available and no origin token is set",
    async () => {
      const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "instafy-cli-git-sync-mint-"));
      const requests: Array<{ method: string; url: string; auth: string | null; body: unknown }> = [];

      const server = http.createServer(async (req, res) => {
        const bodyRaw = await readAll(req);
        let body: unknown = null;
        try {
          body = bodyRaw.trim() ? JSON.parse(bodyRaw) : null;
        } catch {
          body = bodyRaw;
        }

        requests.push({
          method: req.method ?? "",
          url: req.url ?? "",
          auth: typeof req.headers.authorization === "string" ? req.headers.authorization : null,
          body,
        });

        if ((req.url ?? "") === "/access_token") {
          res.setHeader("content-type", "application/json");
          res.end(JSON.stringify({
            token: "fresh-origin-token",
            endpoint: originEndpoint,
          }));
          return;
        }

        if ((req.url ?? "") === "/git/sync") {
          res.setHeader("content-type", "application/json");
          res.end(JSON.stringify({ rev: "cafebabe" }));
          return;
        }

        res.statusCode = 404;
        res.end("not found");
      });

      await new Promise<void>((resolve) => {
        server.listen(0, "127.0.0.1", () => resolve());
      });

      const address = server.address();
      const port = typeof address === "object" && address ? address.port : 0;
      const originEndpoint = `http://127.0.0.1:${port}`;

      try {
        const { code, stdout, stderr } = await execCli(["git", "sync", "-m", "playwright: minted sync"], {
          cwd: tmpDir,
          env: {
            CONTROLLER_BASE_URL: originEndpoint,
            ORIGIN_ENDPOINT: originEndpoint,
            PROJECT_ID: "project-123",
            RUNTIME_ID: randomUUID(),
            RUNTIME_ACCESS_TOKEN: "runtime-controller-token",
            RUNTIME_LEASE_ID: "lease-123",
          },
        });
        if (code !== 0) {
          // eslint-disable-next-line no-console
          console.error("stdout:", stdout, "stderr:", stderr);
        }
        expect(code).toBe(0);
        expect(stdout.trim()).toBe("cafebabe");
        expect(requests).toHaveLength(2);
        expect(requests[0]).toMatchObject({
          method: "POST",
          url: "/access_token",
          auth: "Bearer runtime-controller-token",
        });
        expect(requests[1]).toMatchObject({
          method: "POST",
          url: "/git/sync",
          auth: "Bearer fresh-origin-token",
        });

        const mintBody = requests[0]?.body as {
          projectId?: string;
          protocol?: string;
          scopes?: string[];
          leaseId?: string;
        } | null;
        expect(mintBody?.projectId).toBe("project-123");
        expect(mintBody?.protocol).toBe("http");
        expect(mintBody?.scopes).toEqual(["fs.write"]);
        expect(mintBody?.leaseId).toBe("lease-123");

        const syncBody = requests[1]?.body as { message?: string } | null;
        expect(syncBody?.message).toBe("playwright: minted sync");
      } finally {
        await new Promise<void>((resolve) => {
          server.close(() => resolve());
        });
        fs.rmSync(tmpDir, { recursive: true, force: true });
      }
    },
    20_000,
  );

  it(
    "prefers an existing origin token over minting a replacement",
    async () => {
      const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "instafy-cli-git-sync-origin-first-"));
      const requests: Array<{ method: string; url: string; auth: string | null; body: unknown }> = [];

      const server = http.createServer(async (req, res) => {
        const bodyRaw = await readAll(req);
        let body: unknown = null;
        try {
          body = bodyRaw.trim() ? JSON.parse(bodyRaw) : null;
        } catch {
          body = bodyRaw;
        }

        requests.push({
          method: req.method ?? "",
          url: req.url ?? "",
          auth: typeof req.headers.authorization === "string" ? req.headers.authorization : null,
          body,
        });

        if ((req.url ?? "") !== "/git/sync") {
          res.statusCode = 404;
          res.end("not found");
          return;
        }

        res.setHeader("content-type", "application/json");
        res.end(JSON.stringify({ rev: "feedface" }));
      });

      await new Promise<void>((resolve) => {
        server.listen(0, "127.0.0.1", () => resolve());
      });

      const address = server.address();
      const port = typeof address === "object" && address ? address.port : 0;
      const originEndpoint = `http://127.0.0.1:${port}`;

      try {
        const { code, stdout, stderr } = await execCli(["git", "sync", "-m", "playwright: origin first"], {
          cwd: tmpDir,
          env: {
            CONTROLLER_BASE_URL: `${originEndpoint}/controller-should-not-be-called`,
            PROJECT_ID: "project-123",
            RUNTIME_ACCESS_TOKEN: "runtime-controller-token",
            ORIGIN_ENDPOINT: originEndpoint,
            ORIGIN_ACCESS_TOKEN: "existing-origin-token",
          },
        });
        if (code !== 0) {
          // eslint-disable-next-line no-console
          console.error("stdout:", stdout, "stderr:", stderr);
        }
        expect(code).toBe(0);
        expect(stdout.trim()).toBe("feedface");
        expect(requests).toHaveLength(1);
        expect(requests[0]).toMatchObject({
          method: "POST",
          url: "/git/sync",
          auth: "Bearer existing-origin-token",
        });
      } finally {
        await new Promise<void>((resolve) => {
          server.close(() => resolve());
        });
        fs.rmSync(tmpDir, { recursive: true, force: true });
      }
    },
    20_000,
  );

  it(
    "falls back to a freshly minted origin token when the existing one has the wrong audience",
    async () => {
      const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "instafy-cli-git-sync-recover-"));
      const requests: Array<{ method: string; url: string; auth: string | null; body: unknown }> = [];
      let syncAttempts = 0;

      const server = http.createServer(async (req, res) => {
        const bodyRaw = await readAll(req);
        let body: unknown = null;
        try {
          body = bodyRaw.trim() ? JSON.parse(bodyRaw) : null;
        } catch {
          body = bodyRaw;
        }

        requests.push({
          method: req.method ?? "",
          url: req.url ?? "",
          auth: typeof req.headers.authorization === "string" ? req.headers.authorization : null,
          body,
        });

        if ((req.url ?? "") === "/git/sync") {
          syncAttempts += 1;
          if (syncAttempts === 1) {
            res.statusCode = 401;
            res.setHeader("content-type", "application/json");
            res.end(JSON.stringify({ error: "invalid origin token: InvalidAudience" }));
            return;
          }

          res.setHeader("content-type", "application/json");
          res.end(JSON.stringify({ rev: "recover123" }));
          return;
        }

        if ((req.url ?? "") === "/access_token") {
          res.setHeader("content-type", "application/json");
          res.end(JSON.stringify({
            token: "fresh-origin-token",
            endpoint: originEndpoint,
          }));
          return;
        }

        res.statusCode = 404;
        res.end("not found");
      });

      await new Promise<void>((resolve) => {
        server.listen(0, "127.0.0.1", () => resolve());
      });

      const address = server.address();
      const port = typeof address === "object" && address ? address.port : 0;
      const originEndpoint = `http://127.0.0.1:${port}`;

      try {
        const { code, stdout, stderr } = await execCli(["git", "sync", "-m", "playwright: recover"], {
          cwd: tmpDir,
          env: {
            CONTROLLER_BASE_URL: originEndpoint,
            RUNTIME_ID: randomUUID(),
            RUNTIME_ACCESS_TOKEN: "controller-token",
            PROJECT_ID: "project-123",
            ORIGIN_ENDPOINT: originEndpoint,
            ORIGIN_ACCESS_TOKEN: "stale-origin-token",
            RUNTIME_LEASE_ID: "lease-456",
          },
        });
        if (code !== 0) {
          // eslint-disable-next-line no-console
          console.error("stdout:", stdout, "stderr:", stderr);
        }
        expect(code).toBe(0);
        expect(stdout.trim()).toBe("recover123");
        expect(requests).toHaveLength(3);
        expect(requests[0]).toMatchObject({
          method: "POST",
          url: "/git/sync",
          auth: "Bearer stale-origin-token",
        });
        expect(requests[1]).toMatchObject({
          method: "POST",
          url: "/access_token",
          auth: "Bearer controller-token",
        });
        expect(requests[2]).toMatchObject({
          method: "POST",
          url: "/git/sync",
          auth: "Bearer fresh-origin-token",
        });

        const mintBody = requests[1]?.body as {
          projectId?: string;
          protocol?: string;
          scopes?: string[];
          leaseId?: string;
        } | null;
        expect(mintBody?.projectId).toBe("project-123");
        expect(mintBody?.protocol).toBe("http");
        expect(mintBody?.scopes).toEqual(["fs.write"]);
        expect(mintBody?.leaseId).toBe("lease-456");
      } finally {
        await new Promise<void>((resolve) => {
          server.close(() => resolve());
        });
        fs.rmSync(tmpDir, { recursive: true, force: true });
      }
    },
    20_000,
  );

  it("does not send an environment Origin token to an overridden endpoint", async () => {
    const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "instafy-cli-git-sync-bound-origin-"));
    let requests = 0;
    const server = http.createServer((_req, res) => {
      requests += 1;
      res.statusCode = 500;
      res.end("must not be reached");
    });
    await new Promise<void>((resolve) => {
      server.listen(0, "127.0.0.1", () => resolve());
    });
    const address = server.address();
    const port = typeof address === "object" && address ? address.port : 0;

    try {
      const { code, stderr } = await execCli(
        [
          "git",
          "sync",
          "--origin-endpoint",
          `http://127.0.0.1:${port}`,
        ],
        {
          cwd: tmpDir,
          env: {
            ORIGIN_ENDPOINT: "http://127.0.0.1:1",
            ORIGIN_ACCESS_TOKEN: "provisioned-origin-token",
          },
        },
      );
      expect(code).toBe(1);
      expect(requests).toBe(0);
      expect(stderr).toContain(
        "Refusing to send an environment-provided Origin credential to an endpoint other than ORIGIN_ENDPOINT",
      );
    } finally {
      await new Promise<void>((resolve) => server.close(() => resolve()));
      fs.rmSync(tmpDir, { recursive: true, force: true });
    }
  });
});
