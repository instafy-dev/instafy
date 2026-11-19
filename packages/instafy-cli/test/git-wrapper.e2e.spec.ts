import { once } from "node:events";
import { randomUUID } from "node:crypto";
import fs from "node:fs";
import http from "node:http";
import os from "node:os";
import path from "node:path";
import { execFileSync, spawn, spawnSync } from "node:child_process";
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
  const entry = path.join(packageRoot, "bin", "instafy.js");
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
    "stages and commits in .instafy/.git, not in the repository an inherited GIT_DIR and GIT_INDEX_FILE name",
    async () => {
      const named = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "instafy-cli-git-named-")));
      const rootDir = fs.mkdtempSync(path.join(os.tmpdir(), "instafy-cli-git-inherited-"));
      try {
        // The fixtures are built and read with no inherited or user git settings.
        const fixtureEnv = {
          PATH: process.env.PATH,
          HOME: named,
          LANG: "C",
          GIT_CONFIG_NOSYSTEM: "1",
          GIT_CONFIG_GLOBAL: "/dev/null",
        };
        const git = (cwd: string, ...args: string[]) => {
          const result = spawnSync(
            "git",
            ["-c", "user.name=Named", "-c", "user.email=named@example.invalid", ...args],
            { cwd, env: fixtureEnv, encoding: "utf8" },
          );
          if (result.status !== 0) {
            throw new Error(`git ${args.join(" ")} failed: ${result.stderr || result.stdout}`);
          }
          return result.stdout.trim();
        };
        // A repository with a linked worktree, and what a commit hook in that worktree hands every
        // command it starts: the worktree's GIT_DIR, an absolute path, and its GIT_INDEX_FILE.
        const main = path.join(named, "main");
        const linked = path.join(named, "linked");
        fs.mkdirSync(main);
        git(main, "init", "-q", "-b", "main");
        fs.writeFileSync(path.join(main, "README.md"), "not a fixture\n");
        git(main, "add", "README.md");
        git(main, "commit", "-q", "-m", "named");
        git(main, "worktree", "add", "-q", "-b", "linked", linked);
        const namedGitDir = git(linked, "rev-parse", "--absolute-git-dir");
        // Each read keeps its exit status and errors, so a repository left broken shows in the comparison.
        const read = (...args: string[]) => {
          const result = spawnSync("git", args, { cwd: linked, env: fixtureEnv, encoding: "utf8" });
          return `${result.status}\n${result.stdout}${result.stderr}`;
        };
        const namedState = () => ({
          config: fs.readFileSync(path.join(main, ".git", "config"), "utf8"),
          index: read("ls-files", "--stage"),
          refs: read("for-each-ref", "--format=%(refname) %(objectname)"),
          objects: read("count-objects"),
          status: read("status", "--porcelain", "--untracked-files=all"),
        });
        const before = namedState();

        const canonicalGitDir = path.join(rootDir, ".instafy", ".git");
        fs.mkdirSync(path.join(rootDir, ".instafy"));
        git(rootDir, "--git-dir", canonicalGitDir, "--work-tree", rootDir, "init", "-q", "-b", "main");
        fs.writeFileSync(path.join(rootDir, "hello.txt"), "hello\n");
        const env = {
          GIT_DIR: namedGitDir,
          GIT_INDEX_FILE: path.join(namedGitDir, "index"),
          GIT_AUTHOR_NAME: "Instafy Test",
          GIT_AUTHOR_EMAIL: "test@example.invalid",
          GIT_COMMITTER_NAME: "Instafy Test",
          GIT_COMMITTER_EMAIL: "test@example.invalid",
        };

        const added = await execCli(["git", "add", "-A"], { cwd: rootDir, env });
        expect(added.code, added.stderr).toBe(0);
        const committed = await execCli(["git", "commit", "-q", "-m", "checkpoint"], { cwd: rootDir, env });
        expect(committed.code, committed.stderr).toBe(0);

        expect(namedState(), "instafy git changed the repository GIT_DIR names").toEqual(before);
        expect(git(rootDir, "--git-dir", canonicalGitDir, "ls-tree", "-r", "--name-only", "HEAD")).toBe("hello.txt");
      } finally {
        fs.rmSync(rootDir, { recursive: true, force: true });
        fs.rmSync(named, { recursive: true, force: true });
      }
    },
    20_000,
  );

  it(
    "keeps the index git hands a hook in .instafy/.git itself, so the hook's add lands in that commit",
    async () => {
      const rootDir = fs.mkdtempSync(path.join(os.tmpdir(), "instafy-cli-git-own-hook-"));
      try {
        initCanonicalRepo(rootDir);
        const canonicalGitDir = path.join(rootDir, ".instafy", ".git");
        const env = {
          GIT_CONFIG_NOSYSTEM: "1",
          GIT_CONFIG_GLOBAL: "/dev/null",
          GIT_AUTHOR_NAME: "Instafy Test",
          GIT_AUTHOR_EMAIL: "test@example.invalid",
          GIT_COMMITTER_NAME: "Instafy Test",
          GIT_COMMITTER_EMAIL: "test@example.invalid",
        };
        fs.writeFileSync(path.join(rootDir, "a.txt"), "one\n");
        fs.writeFileSync(path.join(rootDir, "b.txt"), "one\n");
        const added = await execCli(["git", "add", "-A"], { cwd: rootDir, env });
        expect(added.code, added.stderr).toBe(0);
        const first = await execCli(["git", "commit", "-q", "-m", "first"], { cwd: rootDir, env });
        expect(first.code, first.stderr).toBe(0);

        // During `commit -a` git runs this hook with GIT_DIR naming .instafy/.git and GIT_INDEX_FILE
        // naming the index the commit is building, which is where the hook's add has to go.
        const entry = path.join(new URL("../", import.meta.url).pathname, "bin", "instafy.js");
        fs.mkdirSync(path.join(canonicalGitDir, "hooks"), { recursive: true });
        fs.writeFileSync(
          path.join(canonicalGitDir, "hooks", "pre-commit"),
          `#!/bin/sh\nset -e\nprintf 'hook\\n' > b.txt\nexec node ${JSON.stringify(entry)} git add b.txt\n`,
          { mode: 0o755 },
        );
        fs.writeFileSync(path.join(rootDir, "a.txt"), "two\n");
        const committed = await execCli(["git", "commit", "-a", "-q", "-m", "second"], {
          cwd: rootDir,
          env,
        });
        expect(committed.code, committed.stderr).toBe(0);

        const committedFile = (name: string) =>
          spawnSync("git", ["--git-dir", canonicalGitDir, "show", `HEAD:${name}`], {
            encoding: "utf8",
          }).stdout;
        expect(committedFile("a.txt")).toBe("two\n");
        expect(committedFile("b.txt")).toBe("hook\n");
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

  it(
    "names what was not saved, keeps the fields in --json and exits non-zero",
    async () => {
      const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "instafy-cli-git-sync-not-saved-"));
      const runtimeId = randomUUID();
      const requests: Array<{ url: string; body: unknown }> = [];
      let syncResponse: { status: number; body: unknown } = { status: 200, body: {} };

      const server = http.createServer(async (req, res) => {
        const bodyRaw = await readAll(req);
        requests.push({ url: req.url ?? "", body: bodyRaw.trim() ? JSON.parse(bodyRaw) : null });
        res.setHeader("content-type", "application/json");
        if ((req.url ?? "") === "/access_token") {
          res.end(JSON.stringify({ token: "fresh-origin-token", endpoint: originEndpoint }));
          return;
        }
        if ((req.url ?? "") === "/git/sync") {
          res.statusCode = syncResponse.status;
          res.end(JSON.stringify(syncResponse.body));
          return;
        }
        res.statusCode = 404;
        res.end("{}");
      });
      await new Promise<void>((resolve) => {
        server.listen(0, "127.0.0.1", () => resolve());
      });
      const address = server.address();
      const port = typeof address === "object" && address ? address.port : 0;
      const originEndpoint = `http://127.0.0.1:${port}`;
      const env = {
        CONTROLLER_BASE_URL: originEndpoint,
        ORIGIN_ENDPOINT: originEndpoint,
        PROJECT_ID: "project-123",
        RUNTIME_ID: runtimeId,
        RUNTIME_ACCESS_TOKEN: "runtime-controller-token",
        RUNTIME_LEASE_ID: "lease-123",
      };

      try {
        // A partial save: the rest is on main, one file is kept on a recovery
        // ref and one was ignored.
        syncResponse = {
          status: 200,
          body: {
            rev: "feedbeef",
            baseRev: "cafecafe",
            gitSyncStatus: "partial",
            recoveryRef: "refs/instafy/recovery/origin-1/20261002T101010Z-conflict-abc",
            conflictedPaths: ["src/app.ts"],
            rejectedPaths: [{ path: ".env", reason: "ignored", keptSavedVersion: false }],
            unpushedRefs: 0,
          },
        };
        const partial = await execCli(["git", "sync", "-m", "save"], { cwd: tmpDir, env });
        expect(partial.code).toBe(1);
        expect(partial.stdout.trim()).toBe("feedbeef");
        expect(partial.stderr).toContain(
          "Not saved: src/app.ts (kept at refs/instafy/recovery/origin-1/20261002T101010Z-conflict-abc).",
        );
        expect(partial.stderr).toContain("Not saved: .env (ignored by .gitignore).");
        const mint = requests.find((request) => request.url === "/access_token")?.body as {
          preferRuntime?: string;
        } | null;
        expect(mint?.preferRuntime).toBe(runtimeId);

        const json = await execCli(["git", "sync", "--json"], { cwd: tmpDir, env });
        expect(json.code).toBe(1);
        const payload = JSON.parse(json.stdout) as Record<string, unknown>;
        expect(payload).toMatchObject({
          rev: "feedbeef",
          baseRev: "cafecafe",
          gitSyncStatus: "partial",
          recoveryRef: "refs/instafy/recovery/origin-1/20261002T101010Z-conflict-abc",
          conflictedPaths: ["src/app.ts"],
          rejectedPaths: [{ path: ".env", reason: "ignored", keptSavedVersion: false }],
          unpushedRefs: 0,
        });
        expect(payload["notSaved"]).toHaveLength(2);

        // Nothing saved: the origin answers 409 not_saved with the report.
        syncResponse = {
          status: 409,
          body: {
            error: "Not saved: the saved version kept changing (kept at refs/instafy/local-recovery/x-unpublished-1)",
            code: "not_saved",
            gitSyncStatus: "unpublished",
            recoveryRef: "refs/instafy/local-recovery/x-unpublished-1",
            conflictedPaths: [],
            rejectedPaths: [],
            unpushedRefs: 1,
          },
        };
        const failed = await execCli(["git", "sync"], { cwd: tmpDir, env });
        expect(failed.code).toBe(1);
        expect(failed.stdout.trim()).toBe("");
        expect(failed.stderr).toContain(
          "Not saved: the saved version kept changing (kept at refs/instafy/local-recovery/x-unpublished-1).",
        );
        const failedJson = await execCli(["git", "sync", "--json"], { cwd: tmpDir, env });
        expect(failedJson.code).toBe(1);
        expect(JSON.parse(failedJson.stdout)).toMatchObject({
          gitSyncStatus: "unpublished",
          recoveryRef: "refs/instafy/local-recovery/x-unpublished-1",
          unpushedRefs: 1,
        });

        // A complete save still prints only the rev and exits 0.
        syncResponse = { status: 200, body: { rev: "abc123", gitSyncStatus: "published" } };
        const clean = await execCli(["git", "sync"], { cwd: tmpDir, env });
        expect(clean.code).toBe(0);
        expect(clean.stdout.trim()).toBe("abc123");
        expect(clean.stderr).not.toContain("Not saved");
      } finally {
        await new Promise<void>((resolve) => {
          server.close(() => resolve());
        });
        fs.rmSync(tmpDir, { recursive: true, force: true });
      }
    },
    30_000,
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

// Set for the run of this file that the test below starts, so that run does not start another.
const NESTED_RUN = "INSTAFY_CLI_GIT_WRAPPER_NESTED_RUN";

// A repository with a linked worktree, built with no inherited or user git settings. Its linked worktree's GIT_DIR
// does not end in /.git, which is what makes a stray `git init` set core.bare=true in the shared config.
function namedRepository() {
  const named = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "instafy-cli-named-repository-")));
  const main = path.join(named, "main");
  const linked = path.join(named, "linked");
  const env = { PATH: process.env.PATH, HOME: named, LANG: "C", GIT_CONFIG_NOSYSTEM: "1", GIT_CONFIG_GLOBAL: "/dev/null" };
  const git = (cwd: string, ...args: string[]) =>
    execFileSync("git", ["-c", "user.name=Named", "-c", "user.email=named@example.invalid", ...args], {
      cwd,
      env,
      encoding: "utf8",
    }).trim();
  fs.mkdirSync(main);
  git(main, "init", "-q", "-b", "main");
  fs.writeFileSync(path.join(main, "README.md"), "not a fixture\n");
  git(main, "add", "README.md");
  git(main, "commit", "-q", "-m", "named");
  git(main, "worktree", "add", "-q", "-b", "linked", linked);
  return {
    root: named,
    gitDir: git(linked, "rev-parse", "--absolute-git-dir"),
    config: () => fs.readFileSync(path.join(main, ".git", "config"), "utf8"),
    state: () => ({
      index: git(linked, "ls-files", "--stage"),
      refs: git(linked, "for-each-ref", "--format=%(refname) %(objectname)"),
      head: git(linked, "rev-parse", "HEAD"),
      status: git(linked, "status", "--porcelain", "--untracked-files=all"),
    }),
  };
}

type VitestReport = {
  numFailedTests: number;
  testResults: Array<{ assertionResults: Array<{ title: string; status: string }> }>;
};

describe.skipIf(process.env[NESTED_RUN] === "1")("instafy git's tests, run by git", () => {
  it(
    "leave the repository GIT_DIR and GIT_INDEX_FILE name alone",
    () => {
      const named = namedRepository();
      try {
        const configBefore = named.config();
        const before = named.state();
        const packageRoot = new URL("../", import.meta.url).pathname;
        const report = path.join(named.root, "report.json");
        // What a commit hook in a linked worktree gets; `git rebase --exec` sets GIT_DIR alone.
        const env: NodeJS.ProcessEnv = {
          ...process.env,
          GIT_DIR: named.gitDir,
          GIT_INDEX_FILE: path.join(named.gitDir, "index"),
          [NESTED_RUN]: "1",
        };
        for (const name of Object.keys(env)) {
          if (name.startsWith("VITEST")) delete env[name];
        }

        const run = spawnSync(
          process.execPath,
          [
            path.join(packageRoot, "node_modules", "vitest", "vitest.mjs"),
            "run",
            "test/git-wrapper.e2e.spec.ts",
            "--reporter=json",
            `--outputFile=${report}`,
          ],
          { cwd: packageRoot, env, encoding: "utf8", timeout: 150_000 },
        );
        const output = `${run.stdout}\n${run.stderr}`;

        expect(named.config(), "a test changed the config of the repository GIT_DIR names").toBe(configBefore);
        expect(named.state()).toEqual(before);
        expect(run.status, output).toBe(0);
        const results = JSON.parse(fs.readFileSync(report, "utf8")) as VitestReport;
        const passed = results.testResults
          .flatMap((file) => file.assertionResults)
          .filter((test) => test.status === "passed")
          .map((test) => test.title);
        expect(results.numFailedTests, output).toBe(0);
        // The test that inits a repository of its own and stages through `instafy git`.
        expect(passed).toContain("stages files inside embedded git repos (git-inside-git)");
      } finally {
        fs.rmSync(named.root, { recursive: true, force: true });
      }
    },
    180_000,
  );
});
