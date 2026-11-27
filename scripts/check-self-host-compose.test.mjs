import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";

import {
  COMPOSE_FILE,
  EXAMPLE_ENV_FILE,
  EXPECTED_SERVICES,
} from "./check-self-host-compose.mjs";

const REPO_ROOT = path.resolve(import.meta.dirname, "..");
const PROVIDER_COMPOSE_FILE = "docker/docker-compose.runtime.provider.yml";
const composeAvailable =
  spawnSync("docker", ["compose", "version"], { encoding: "utf8" }).status === 0;
// Whether this Compose's `config` can leave env files unread and show their
// paths instead.
const composeShowsEnvFiles =
  composeAvailable &&
  spawnSync("docker", ["compose", "config", "--help"], { encoding: "utf8" }).stdout.includes(
    "--no-env-resolution",
  );

test("self-host validation is bound to the public Compose example", () => {
  assert.equal(COMPOSE_FILE, "docker/docker-compose.runtime.yml");
  assert.equal(EXAMPLE_ENV_FILE, "docker/.env.example");
  assert.deepEqual(EXPECTED_SERVICES, [
    "git-edge",
    "git-shard-0",
    "origin-gateway",
    "proxy",
    "redis",
    "runtime",
  ]);
});

// PROXY_PINNED_MODEL pins managed runs on the sidecar's static credentials to
// the managed model, so both runtime Compose files must pass it through when
// the operator sets it, fall back to MANAGED_AI_MODEL_ID when it is unset, and
// treat an explicitly empty value as no pin.
test(
  "the proxy sidecar takes its pinned model from the environment that runs Compose",
  { skip: !composeAvailable && "Docker Compose v2 unavailable" },
  () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), "instafy-compose-pin-"));
    try {
      const emptyEnvFile = path.join(root, "empty.env");
      fs.writeFileSync(emptyEnvFile, "");
      fs.mkdirSync(path.join(root, "docker"));
      fs.writeFileSync(path.join(root, "docker", ".env.local"), "");
      // The provider sidecar's env_file. Compose lets `environment:` override
      // it, so a pin placed here never reaches the proxy.
      const sidecarEnvFile = path.join(root, "proxy-credential-lease.env");
      fs.writeFileSync(sidecarEnvFile, "PROXY_PINNED_MODEL=from-sidecar-env-file\n");
      const pinnedModel = (composeFile, overrides) => {
        const result = spawnSync(
          "docker",
          [
            "compose",
            "--project-directory",
            root,
            "--env-file",
            emptyEnvFile,
            "--file",
            path.join(REPO_ROOT, composeFile),
            "config",
            "--format",
            "json",
            "proxy",
          ],
          {
            encoding: "utf8",
            // Only what the Docker CLI needs, so no ambient pin leaks in.
            env: {
              PATH: process.env.PATH,
              HOME: process.env.HOME,
              ...(process.env.DOCKER_CONFIG
                ? { DOCKER_CONFIG: process.env.DOCKER_CONFIG }
                : {}),
              INSTAFY_ENV_DIR: root,
              PROXY_CREDENTIAL_LEASE_ENV_FILE: sidecarEnvFile,
              RUNTIME_PROXY_IMAGE: "runtime-proxy:fixture",
              RUNTIME_AGENT_IMAGE: "runtime-agent:fixture",
              ...overrides,
            },
            timeout: 30_000,
          },
        );
        assert.equal(result.status, 0, `${composeFile}: ${result.stderr}`);
        return JSON.parse(result.stdout).services.proxy.environment.PROXY_PINNED_MODEL;
      };

      for (const composeFile of [COMPOSE_FILE, PROVIDER_COMPOSE_FILE]) {
        assert.equal(pinnedModel(composeFile, {}), "", `${composeFile}: unset is no pin`);
        assert.equal(
          pinnedModel(composeFile, { PROXY_PINNED_MODEL: "", MANAGED_AI_MODEL_ID: "" }),
          "",
          `${composeFile}: empty is no pin`,
        );
        assert.equal(
          pinnedModel(composeFile, { MANAGED_AI_MODEL_ID: "gpt-6-luna" }),
          "gpt-6-luna",
          `${composeFile}: falls back to MANAGED_AI_MODEL_ID`,
        );
        assert.equal(
          pinnedModel(composeFile, { PROXY_PINNED_MODEL: "", MANAGED_AI_MODEL_ID: "gpt-6-luna" }),
          "",
          `${composeFile}: an explicitly empty PROXY_PINNED_MODEL switches the pin off`,
        );
        assert.equal(
          pinnedModel(composeFile, { PROXY_PINNED_MODEL: "gpt-6-luna" }),
          "gpt-6-luna",
          `${composeFile}: passes PROXY_PINNED_MODEL through`,
        );
        assert.equal(
          pinnedModel(composeFile, {
            PROXY_PINNED_MODEL: "pinned-model",
            MANAGED_AI_MODEL_ID: "managed-model",
          }),
          "pinned-model",
          `${composeFile}: PROXY_PINNED_MODEL wins`,
        );
      }
    } finally {
      fs.rmSync(root, { force: true, recursive: true });
    }
  },
);

// The local proxy sends a ChatGPT login's and an API key's requests to the
// provider unless PROXY_UPSTREAM_*_ENDPOINT names another upstream (such as
// scripts/fake-rate-limit-upstream.mjs). The runtime's own
// CODEX_PROXY_CHATGPT_ENDPOINT and CODEX_OPENAI_ENDPOINT, which point at this
// proxy, must never become its upstream: that would send it to itself.
test(
  "the local proxy's upstream is the provider unless PROXY_UPSTREAM_* names another",
  { skip: !composeAvailable && "Docker Compose v2 unavailable" },
  () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), "instafy-compose-upstream-"));
    try {
      const emptyEnvFile = path.join(root, "empty.env");
      fs.writeFileSync(emptyEnvFile, "");
      fs.mkdirSync(path.join(root, "docker"));
      fs.writeFileSync(path.join(root, "docker", ".env.local"), "");
      const upstreams = (overrides) => {
        const result = spawnSync(
          "docker",
          ["compose", "--project-directory", root, "--env-file", emptyEnvFile, "--file", path.join(REPO_ROOT, COMPOSE_FILE), "config", "--format", "json", "proxy"],
          {
            encoding: "utf8",
            env: {
              PATH: process.env.PATH,
              HOME: process.env.HOME,
              ...(process.env.DOCKER_CONFIG ? { DOCKER_CONFIG: process.env.DOCKER_CONFIG } : {}),
              INSTAFY_ENV_DIR: root,
              ...overrides,
            },
            timeout: 30_000,
          },
        );
        assert.equal(result.status, 0, result.stderr);
        const environment = JSON.parse(result.stdout).services.proxy.environment;
        return [environment.CODEX_PROXY_CHATGPT_ENDPOINT, environment.CODEX_OPENAI_ENDPOINT];
      };
      assert.deepEqual(upstreams({}), ["", ""], "unset is the provider itself");
      assert.deepEqual(
        upstreams({
          CODEX_PROXY_CHATGPT_ENDPOINT: "http://host.docker.internal:8789/backend-api/codex/responses",
          CODEX_OPENAI_ENDPOINT: "http://host.docker.internal:8789/v1/responses",
        }),
        ["", ""],
        "the runtime's endpoints, which point at this proxy, never become its upstream",
      );
      assert.deepEqual(
        upstreams({
          PROXY_UPSTREAM_CHATGPT_ENDPOINT: "http://host.docker.internal:8790/backend-api/codex/responses",
          PROXY_UPSTREAM_OPENAI_ENDPOINT: "http://host.docker.internal:8790/v1/responses",
        }),
        ["http://host.docker.internal:8790/backend-api/codex/responses", "http://host.docker.internal:8790/v1/responses"],
      );
    } finally {
      fs.rmSync(root, { force: true, recursive: true });
    }
  },
);

// A provider launch hands the managed launch metadata to the runtime only as
// the environment of the `docker compose` process (allocator/docker.rs).
// Compose passes a variable into the container only when the runtime
// service's `environment:` lists it, so an allowlisted key this file forgets
// is dropped without a trace. ORIGIN_GIT_REMOTE_URL was dropped that way, and
// hosted workspaces then had no git remote and lived only on the node's disk.
const ALLOCATOR_ALLOWLIST_FILE = "packages/runtime-provider-core/src/allocator/mod.rs";

// Exceptions to "every allowlisted key reaches the runtime container".
const NOT_FORWARDED_TO_RUNTIME = new Map([
  // Compose-level only: Compose reads these itself to size the container
  // (`cpus:` and `mem_limit:`). Nothing inside the container reads them.
  ["RUNTIME_CPU_LIMIT", "compose-level"],
  ["RUNTIME_MEMORY_LIMIT", "compose-level"],
  // Read inside the container, but not forwarded yet. The origin server and
  // browser-webrtc-sender each fall back to the same loopback default
  // (127.0.0.1:9225), and they must move together. Forwarding the URL as an
  // empty value would break WebRTC: the origin treats an empty
  // INSTAFY_BROWSER_WEBRTC_SENDER_URL as invalid instead of unset. Forward
  // both with a shared default before a provider sets either one.
  ["INSTAFY_BROWSER_WEBRTC_SENDER_URL", "not-forwarded-yet"],
  ["INSTAFY_BROWSER_WEBRTC_BIND", "not-forwarded-yet"],
]);

// The managed launch keys: the string literals of the one `matches!(key, ...)`
// in is_allowed_managed_runtime_env_key. Anything else in its body (a guard,
// a wildcard, a prefix test, a second statement) fails here instead of
// passing with a list that leaves it out.
function allocatorManagedEnvAllowlist() {
  const source = fs.readFileSync(path.join(REPO_ROOT, ALLOCATOR_ALLOWLIST_FILE), "utf8");
  return managedEnvAllowlistIn(source, ALLOCATOR_ALLOWLIST_FILE);
}

function managedEnvAllowlistIn(source, label) {
  const definitions = [
    ...source.matchAll(/\bfn is_allowed_managed_runtime_env_key\(key: &str\) -> bool \{\n([\s\S]*?)\n\}\n/g),
  ];
  assert.equal(definitions.length, 1, `${label}: expected one is_allowed_managed_runtime_env_key`);
  const names = [];
  const rest = definitions[0][1]
    .replace(/\/\/.*$/gm, "")
    .replace(/"([A-Za-z_][A-Za-z0-9_]*)"/g, (_, name) => {
      names.push(name);
      return "";
    })
    .replace(/\s+/g, "");
  assert.equal(
    rest,
    `matches!(key,${"|".repeat(Math.max(names.length - 1, 0))})`,
    `${label}: is_allowed_managed_runtime_env_key holds more than one match of names`,
  );
  assert.ok(names.length > 0, `${label}: no managed launch keys`);
  assert.equal(new Set(names).size, names.length, `${label}: a managed launch key is listed twice`);
  return names;
}

// A Compose file's lines, as the checks here read it by hand so they need no
// Docker. YAML also ends a line at a lone CR, U+0085, U+2028 or U+2029, which
// these checks would read as part of the line, and a byte order mark hides
// the first key from them, so a file that holds one fails instead. A CRLF
// line ending reads as the LF it stands for.
function composeLines(text, label) {
  const normalized = text.replaceAll("\r\n", "\n");
  assert.doesNotMatch(
    normalized,
    /[\r\u0085\u2028\u2029\uFEFF]/,
    `${label}: the Compose file checks here read only LF and CRLF line breaks and no byte order mark; take out the lone CR, U+0085, U+2028, U+2029 or U+FEFF`,
  );
  return normalized.split("\n");
}

// A Compose file's runtime service, line by line.
function runtimeServiceLines(composeFile) {
  const lines = composeLines(fs.readFileSync(path.join(REPO_ROOT, composeFile), "utf8"), composeFile);
  const start = lines.indexOf("  runtime:");
  assert.notEqual(start, -1, `${composeFile}: runtime service not found`);
  let end = lines.findIndex((line, index) => index > start && /^ {0,2}\S/.test(line));
  if (end === -1) {
    end = lines.length;
  }
  return lines.slice(start, end);
}

// The provider Compose file's runtime service as text, plus the variables its
// `environment:` map sets.
function providerRuntimeService(service = runtimeServiceLines(PROVIDER_COMPOSE_FILE)) {
  const environmentStart = service.indexOf("    environment:");
  assert.notEqual(environmentStart, -1, `${PROVIDER_COMPOSE_FILE}: runtime environment not found`);
  const environment = new Map();
  for (const line of service.slice(environmentStart + 1)) {
    if (line.trim() === "" || /^\s*#/.test(line)) {
      continue;
    }
    const entry = line.match(/^ {6}([A-Za-z_][A-Za-z0-9_]*):\s*(.*)$/);
    if (!entry) {
      break;
    }
    // The value without a trailing comment or the quotes of a quoted scalar.
    // Escapes and tags stay as written, so a value that starts with one fails
    // the check below instead of passing it.
    environment.set(entry[1], yamlLineParts(entry[2]).code.replace(/^(["'])(.*)\1$/, "$2"));
  }
  return { text: service.join("\n"), environment };
}

test("the provider runtime receives every managed launch variable a runtime reads", () => {
  const allowlist = allocatorManagedEnvAllowlist();
  // Guards the source parse itself: an empty or truncated list would pass vacuously.
  for (const key of [
    "RUNTIME_CPU_LIMIT",
    "ORIGIN_GIT_REMOTE_URL",
    "INSTAFY_BROWSER_EGRESS_MAX_CONNECTIONS",
  ]) {
    assert.ok(allowlist.includes(key), `allowlist parse is missing ${key}`);
  }

  const runtime = providerRuntimeService();
  for (const key of allowlist) {
    const exception = NOT_FORWARDED_TO_RUNTIME.get(key);
    if (exception) {
      assert.ok(
        !runtime.environment.has(key),
        `${key} is forwarded now: remove it from NOT_FORWARDED_TO_RUNTIME`,
      );
      if (exception === "compose-level") {
        assert.ok(
          runtime.text.includes(`\${${key}`),
          `${key} is listed as compose-level, but the runtime service never reads it`,
        );
      }
      continue;
    }
    const value = runtime.environment.get(key);
    assert.ok(
      value !== undefined,
      `${PROVIDER_COMPOSE_FILE}: the runtime environment drops the allowlisted ${key}`,
    );
    assert.ok(
      value.startsWith(`\${${key}:-`) || value.startsWith(`\${${key}-`),
      `${PROVIDER_COMPOSE_FILE}: ${key} must pass the launch value through, got ${value}`,
    );
  }
  for (const key of NOT_FORWARDED_TO_RUNTIME.keys()) {
    assert.ok(allowlist.includes(key), `${key} is no longer allowlisted: drop its exception`);
  }
});

// The check above reads a value without its trailing comment or outer quotes,
// so a quoted value, as a JSON default needs, passes a launch value through
// as a plain one does, and an escaped `$$` still does not.
test("the provider runtime's values drop a trailing comment and their quotes", () => {
  const { environment } = providerRuntimeService([
    "  runtime:",
    "    environment:",
    '      ICE_SERVERS_JSON: "${ICE_SERVERS_JSON:-[{\\"urls\\":[\\"stun:stun.example.test:19302\\"]}]}" # a default',
    "      QUOTED: '${QUOTED:-a #b}'",
    "      PLAIN: ${PLAIN:-} # from the launch",
    '      ESCAPED: "$${ESCAPED:-}"',
  ]);
  assert.deepEqual(Object.fromEntries(environment), {
    ICE_SERVERS_JSON: '${ICE_SERVERS_JSON:-[{\\"urls\\":[\\"stun:stun.example.test:19302\\"]}]}',
    QUOTED: "${QUOTED:-a #b}",
    PLAIN: "${PLAIN:-}",
    ESCAPED: "$${ESCAPED:-}",
  });
});

// What a launch request decides in the environment of the `docker compose`
// process (allocator/docker.rs): the managed launch keys (allocator/mod.rs),
// and the variables build_env derives from the request's own fields
// (REQUEST_DERIVED_RUNTIME_ENV_KEYS). Compose, the Docker CLI and the dynamic
// loader read that environment, and Compose puts the variables a runtime
// Compose file uses outside the runtime's `environment:` into other services,
// mounts, env_file paths, images, ports, build settings and resource limits.
// So apart from the CPU and memory limits, which the controller sets from the
// runtime's size, each of them must be a variable the runtime Compose files use
// only inside the runtime container. Every other variable the files pass into
// the runtime container is the provider's or its operator's
// (OPERATOR_ONLY_RUNTIME_ENV_KEYS), set in the provider service's own
// environment, which Compose inherits: a launch never sets it.
const ALLOCATOR_DOCKER_FILE = "packages/runtime-provider-core/src/allocator/docker.rs";

// A `const NAME: &[&str] = &[...]` list in a Rust file: exactly one
// definition, holding only string literals and comments, with no name twice,
// so that an edit this parse does not follow fails here instead of passing
// with a shorter list.
function rustStringList(file, name) {
  return rustStringListIn(fs.readFileSync(path.join(REPO_ROOT, file), "utf8"), file, name);
}

function rustStringListIn(source, file, name) {
  const definitions = [
    ...source.matchAll(new RegExp(String.raw`\nconst ${name}: &\[&str\] = &\[\n([\s\S]*?)\n\];\n`, "g")),
  ];
  assert.equal(definitions.length, 1, `${file}: expected one definition of ${name}`);
  const names = [];
  const rest = definitions[0][1]
    .replace(/\/\/.*$/gm, "")
    .replace(/"([A-Za-z_][A-Za-z0-9_]*)",?/g, (_, entry) => {
      names.push(entry);
      return "";
    });
  assert.match(rest, /^\s*$/, `${file}: ${name} holds more than names: ${rest.trim()}`);
  assert.ok(names.length > 0, `${file}: ${name} is empty`);
  assert.equal(new Set(names).size, names.length, `${file}: ${name} names a variable twice`);
  return names;
}

// The allocator's lists of who sets which variable.
function allocatorEnvLists() {
  const lists = {
    managed: allocatorManagedEnvAllowlist(),
    exactOnly: rustStringList(ALLOCATOR_DOCKER_FILE, "EXACT_ONLY_LAUNCH_ENV_KEYS"),
    operatorOnly: rustStringList(ALLOCATOR_DOCKER_FILE, "OPERATOR_ONLY_RUNTIME_ENV_KEYS"),
    requestDerived: rustStringList(ALLOCATOR_DOCKER_FILE, "REQUEST_DERIVED_RUNTIME_ENV_KEYS"),
  };
  // Guard the parses themselves.
  for (const [list, key] of [
    ["managed", "INSTAFY_ENABLE_BROWSER_SESSION"],
    ["exactOnly", "INSTAFY_BROWSER_EGRESS_ISOLATION"],
    ["operatorOnly", "ORIGIN_SKIP_AUTH"],
    ["operatorOnly", "PROXY_BASE_URL"],
    ["requestDerived", "RUNTIME_METADATA"],
  ]) {
    assert.ok(lists[list].includes(key), `the ${list} list parse is missing ${key}`);
  }
  return lists;
}

test("the allocator list parses fail on Rust they do not follow", () => {
  const allowlist = (body) =>
    `\npub(crate) fn is_allowed_managed_runtime_env_key(key: &str) -> bool {\n${body}\n}\n`;
  assert.deepEqual(
    managedEnvAllowlistIn(
      allowlist(`    matches!(\n        key,\n        // A comment.\n        "A_KEY"\n            | "B_KEY"\n    )`),
      "self-test",
    ),
    ["A_KEY", "B_KEY"],
  );
  for (const body of [
    `    matches!(\n        key,\n        "A_KEY" | _\n    )`,
    `    matches!(\n        key,\n        "A_KEY" | other if other.starts_with("B_")\n    )`,
    `    key.starts_with("A_") || matches!(\n        key,\n        "B_KEY"\n    )`,
    `    matches!(\n        key,\n        "A_KEY" | concat!("B_", "KEY")\n    )`,
    `    matches!(\n        key,\n        "A_KEY" | "A_KEY"\n    )`,
    `    matches!(\n        key,\n    )`,
  ]) {
    assert.throws(() => managedEnvAllowlistIn(allowlist(body), "self-test"), Error, body);
  }
  assert.throws(
    () => managedEnvAllowlistIn(allowlist(`    matches!(key, "A_KEY")`).repeat(2), "self-test"),
    Error,
    "two definitions",
  );

  const list = (body) => `\nconst SOME_KEYS: &[&str] = &[\n${body}\n];\n`;
  assert.deepEqual(
    rustStringListIn(list(`    "A_KEY",\n    // A comment.\n    "B_KEY",`), "self-test", "SOME_KEYS"),
    ["A_KEY", "B_KEY"],
  );
  for (const body of [
    `    "A_KEY",\n    OTHER_KEYS[0],`,
    `    "A_KEY",\n    "A_KEY",`,
    `    // Only a comment.`,
  ]) {
    assert.throws(() => rustStringListIn(list(body), "self-test", "SOME_KEYS"), Error, body);
  }
  assert.throws(
    () => rustStringListIn(list(`    "A_KEY",`).repeat(2), "self-test", "SOME_KEYS"),
    Error,
    "two definitions",
  );
});

// Where a YAML node can start on a line: after the indentation, after a `- `
// or `? ` indicator or a `: ` value indicator, and inside a flow collection.
const YAML_NODE_START = String.raw`(?:^\s*|(?:^|\s)[-?]\s+|:\s+|[[{,]\s*)`;
// The tags a value may carry and still read as written: a value tagged !!null
// is taken from the environment like an untagged null, the others set a value.
const PLAIN_SCALAR_TAG = String.raw`!!(?:null|str|int|float|bool)(?=\s|$)`;
// A block scalar's header (`|` or `>`, with optional indentation and chomping
// indicators) as a sequence item or, with group 1 its key, a mapping value.
const BLOCK_SCALAR_HEADER =
  /^(?:((["']?)[^\s"'#][^#]*?\2\s*):\s+)?(?:!!str\s+)?[|>](?:[1-9][+-]?|[+-][1-9]?)?$/;

// YAML the line scan below does not follow. Each can hide an `environment:` or
// `args:` entry, or a `$`, from the scan, so a Compose file that uses one fails
// the scan instead.
const UNFOLLOWED_YAML = [
  [new RegExp(String.raw`${YAML_NODE_START}(?:!\S*\s+)?[&*][^\s,\]}]`), "an anchor or alias"],
  [new RegExp(String.raw`${YAML_NODE_START}<<\s*:`), "a merge key"],
  [new RegExp(String.raw`${YAML_NODE_START}\?(?:\s|$)`), "an explicit key"],
  [
    new RegExp(String.raw`(?:^\s*|(?:^|\s)[-?]\s+|[[{,]\s*)!|:\s+(?!${PLAIN_SCALAR_TAG})!`),
    "a tag, apart from a plain one on a value",
  ],
  [new RegExp(String.raw`${YAML_NODE_START}\{(?!\s*\})`), "a flow mapping"],
];

// Records each variable a line interpolates: $NAME or ${NAME}, but not an
// escaped $$NAME.
function addInterpolations(line, uses) {
  for (const match of line.matchAll(
    /\$\$|\$(?:\{([A-Za-z_][A-Za-z0-9_]*)|([A-Za-z_][A-Za-z0-9_]*))/g,
  )) {
    const name = match[1] ?? match[2];
    if (name) {
      uses.add(name);
    }
  }
}

// A YAML line without its comment (`code`), the same text with the contents of
// its quoted scalars left out (`bare`), whether a quoted scalar is still open
// at the end of the line, and whether a double-quoted one uses a \x, \u or \U
// escape, which can spell any character, `$` included.
function yamlLineParts(line) {
  let code = "";
  let bare = "";
  let quote = "";
  let spellingEscape = false;
  for (let index = 0; index < line.length; index += 1) {
    const char = line[index];
    if (quote) {
      code += char;
      if (quote === '"' && char === "\\") {
        const escaped = line[index + 1] ?? "";
        spellingEscape ||= /^[xuU]$/.test(escaped);
        code += escaped;
        index += 1;
      } else if (char === "'" && quote === "'" && line[index + 1] === "'") {
        code += "'";
        index += 1;
      } else if (char === quote) {
        quote = "";
        bare += char;
      }
      continue;
    }
    if (char === "#" && (index === 0 || /\s/.test(line[index - 1]))) {
      break;
    }
    // A quoted scalar starts where a node can, after a plain tag if it has one.
    if (
      (char === '"' || char === "'") &&
      new RegExp(String.raw`${YAML_NODE_START}(?:${PLAIN_SCALAR_TAG}\s+)?$`).test(line.slice(0, index))
    ) {
      quote = char;
    }
    code += char;
    bare += char;
  }
  return { code: code.trimEnd(), bare: bare.trimEnd(), openQuote: quote !== "", spellingEscape };
}

// The variable a block-style `environment:` or `args:` entry takes from the
// process environment, null for an entry that sets its own value, and
// undefined for a line that is no such entry.
function passedThroughEntry(content) {
  const item = content.match(/^-(?:\s+(.*))?$/);
  if (item) {
    const value = item[1] ?? "";
    const name = value.match(/^(["']?)([A-Za-z_][A-Za-z0-9_]*)\1$/);
    if (name) {
      return name[2];
    }
    return /^(["']?)[A-Za-z_][A-Za-z0-9_]*=.*\1$/.test(value) ? null : undefined;
  }
  const entry = content.match(/^(["']?)([A-Za-z_][A-Za-z0-9_]*)\1\s*:(?:\s+(.*))?$/);
  if (!entry) {
    return undefined;
  }
  // YAML's null, which Compose reads as "take it from the environment".
  return /^(?:~|null|!!null(?:\s.*)?)?$/i.test(entry[3] ?? "") ? entry[2] : null;
}

// The variables a Compose file uses inside its runtime service's
// `environment:`, the ones its runtime service's `cpus:` and `mem_limit:` use,
// and the ones it uses anywhere else. Compose takes a variable from the
// environment of the `docker compose` process wherever the file interpolates
// it ($NAME or ${NAME}, but not an escaped $$NAME), block scalars included,
// and, with no `$`, for an `environment:` or build `args:` entry that has no
// value or a null one and for a secret or config whose source is
// `environment: NAME`. This is a line scan of the plain block style these files
// are written in, not a YAML parser. It fails on the YAML it does not follow
// (a line break other than LF or CRLF, a byte order mark, UNFOLLOWED_YAML, a
// quoted value continued on another line, a \x, \u or \U escape, a $ in a
// trailing comment, flow-style or unrecognised `environment:` and `args:`
// entries, `extends:` and `include:`), and where Docker Compose is
// available a test below checks Compose's own reading of both files. An
// env_file's contents are not in this repository and are not checked.
function composeVariableUsesInText(text, label) {
  const lines = composeLines(text, label);
  const codes = lines.map((line) => yamlLineParts(line).code);
  const serviceStart = codes.indexOf("  runtime:");
  assert.notEqual(serviceStart, -1, `${label}: runtime service not found`);
  let serviceEnd = codes.findIndex((code, index) => index > serviceStart && /^ {0,2}\S/.test(code));
  if (serviceEnd === -1) {
    serviceEnd = lines.length;
  }
  const environmentStart = codes.indexOf("    environment:", serviceStart);
  assert.ok(
    environmentStart > serviceStart && environmentStart < serviceEnd,
    `${label}: runtime environment not found`,
  );
  const environment = new Set();
  const limits = new Set();
  const elsewhere = new Set();
  // The top-level key the current line is under.
  let section = null;
  // The `environment:` or `args:` key whose entries the current line is among.
  let block = null;
  // The block scalar whose content the current line may be.
  let scalar = null;
  lines.forEach((line, index) => {
    const indent = line.length - line.trimStart().length;
    if (scalar) {
      if (line.trim() === "") {
        return;
      }
      // Every line indented deeper than the scalar's parent node is content,
      // a line that starts with `#` included.
      if (indent > scalar.parent) {
        addInterpolations(line, scalar.uses);
        return;
      }
      scalar = null;
    }
    if (line.trim() === "" || /^\s*#/.test(line)) {
      return;
    }
    const at = `${label}:${index + 1}`;
    const parts = yamlLineParts(line);
    assert.ok(
      !parts.openQuote,
      `${at}: the variable scan does not follow a quoted value continued on the next line; keep it on one line`,
    );
    assert.ok(
      !parts.spellingEscape,
      `${at}: the variable scan does not follow a \\x, \\u or \\U escape in a double-quoted value, which can spell a $`,
    );
    for (const [pattern, what] of UNFOLLOWED_YAML) {
      assert.doesNotMatch(
        parts.bare,
        pattern,
        `${at}: the variable scan does not follow ${what}; write this in plain block style, and quote a value that holds [, { or a comma`,
      );
    }
    const content = parts.code.trimStart();
    // A sequence item may start with its node's key, as a lifecycle hook's
    // `- environment:` does.
    const dashes = content.match(/^(?:-(?:\s+|$))*/)[0];
    const node = content.slice(dashes.length);
    const column = indent + dashes.length;
    if (indent === 0) {
      section = node.match(/^(["']?)([^\s"':#]+)\1\s*:/)?.[2] ?? null;
      assert.notEqual(
        section,
        "include",
        `${at}: the variable scan does not follow include:, which brings in another file`,
      );
    }
    // A block sequence may sit at its key's own indentation.
    if (block && (indent < block.indent || (indent === block.indent && dashes === ""))) {
      block = null;
    }
    const sizesRuntime =
      index > serviceStart &&
      index < serviceEnd &&
      indent === 4 &&
      dashes === "" &&
      /^(?:cpus|mem_limit)\s*:/.test(node);
    const uses =
      block?.start === environmentStart ? environment : sizesRuntime ? limits : elsewhere;
    addInterpolations(parts.code, uses);
    // Compose ignores a comment, but the scan finds one without a full YAML
    // reading, so a $ after what it takes for a comment fails instead.
    const afterCode = new Set();
    addInterpolations(line.slice(parts.code.length), afterCode);
    assert.equal(
      afterCode.size,
      0,
      `${at}: the variable scan does not read a $ in a trailing comment; put the comment on a line of its own`,
    );
    const blockScalar = node.match(BLOCK_SCALAR_HEADER);
    if (blockScalar) {
      scalar = {
        parent: blockScalar[1] === undefined ? indent + dashes.lastIndexOf("-") : column,
        uses,
      };
    }
    if (block) {
      const passedThrough = passedThroughEntry(content);
      assert.notEqual(
        passedThrough,
        undefined,
        `${at}: the variable scan does not read this ${block.key}: entry; write it as NAME: value or - NAME=value`,
      );
      if (passedThrough) {
        uses.add(passedThrough);
      }
      return;
    }
    assert.ok(
      section !== "services" || !/^(["']?)extends\1\s*:/.test(node),
      `${at}: the variable scan does not follow extends:, which copies another service's settings`,
    );
    const key = node.match(/^(["']?)(environment|args)\1\s*:\s*(.*)$/);
    if (!key) {
      return;
    }
    const value = key[3];
    if (value === "") {
      block = { start: index, indent: column, key: key[2] };
      return;
    }
    assert.doesNotMatch(
      value,
      /^\[(?!\s*\]$)/,
      `${at}: the variable scan reads ${key[2]}: entries only in block style, one per line`,
    );
    // A secret's or config's source. Anywhere else a scalar here is a label's
    // value, or a service setting Compose rejects.
    const source =
      key[2] === "environment" && (section === "secrets" || section === "configs")
        ? value.match(/^(["']?)([A-Za-z_][A-Za-z0-9_]*)\1$/)
        : null;
    if (source) {
      uses.add(source[2]);
    }
  });
  return { environment, limits, elsewhere };
}

function composeVariableUses(composeFile) {
  return composeVariableUsesInText(
    fs.readFileSync(path.join(REPO_ROOT, composeFile), "utf8"),
    composeFile,
  );
}

test("the Compose variable scan sees the variables Compose passes through without a $", () => {
  const uses = composeVariableUsesInText(
    [
      "services:",
      "  proxy:",
      "    build:",
      "      args:",
      "        - BUILD_ARG_PASSED",
      "        - BUILD_ARG_COMMENTED # passed through",
      "        - BUILD_ARG_SET=1",
      "    environment:",
      "      SIDECAR_PASSED:",
      "      SIDECAR_COMMENTED: # passed through",
      "      SIDECAR_NULL: null",
      "      SIDECAR_NULL_UPPER: NULL",
      "      SIDECAR_NULL_TITLE: Null # passed through",
      "      SIDECAR_NULL_TAGGED: !!null",
      "      SIDECAR_TILDE: ~",
      "      'SIDECAR_QUOTED':",
      '      SIDECAR_EMPTY: ""',
      "      SIDECAR_TAGGED_STRING: !!str",
      "      SIDECAR_SET: ${SIDECAR_INTERPOLATED:-}",
      "      SIDECAR_ESCAPED: $$NOT_INTERPOLATED $${NOT_INTERPOLATED_EITHER} $$$INTERPOLATED_AFTER_ESCAPE",
      "      SIDECAR_HASH: value#${INTERPOLATED_AFTER_HASH}",
      '      SIDECAR_JSON: "${SIDECAR_JSON_DEFAULTED:-[{\\"urls\\":[]}]}"',
      '      SIDECAR_TAGGED_QUOTED: !!str "a # ${INTERPOLATED_IN_TAGGED_QUOTE}"',
      "    depends_on:",
      "      - redis",
      "    volumes:",
      "      - ${VOLUME_SOURCE:-.}:/data",
      "      - proxy-cache:/cache",
      "    labels:",
      "      environment: prod-eu",
      '    entrypoint: ["sh", "-lc"]',
      "    command:",
      "      - |",
      "        # fetch through the proxy for ${BLOCK_SCALAR_COMMENT_LINE}",
      '        case "$$1" in',
      "          *) exec proxy ;;",
      "        esac",
      "        { echo start; exec proxy; }",
      "        echo $${NOT_INTERPOLATED_IN_BLOCK_SCALAR} \\",
      "",
      "          && exec proxy ${BLOCK_SCALAR_LINE}",
      "    healthcheck:",
      "      test: [\"CMD\", \"sh\", \"-c\", \"echo '&' '*' '{' && true\"]",
      "    post_start:",
      "      - command: ./warm.sh",
      "        environment:",
      "          HOOK_PASSED:",
      "      - environment:",
      "          HOOK_FIRST_KEY_PASSED: null",
      "        command: ./again.sh",
      "  helper:",
      "    cpus: ${HELPER_CPUS:-1}",
      "    environment: # a sequence at the key's own indentation",
      "    - HELPER_PASSED",
      "    - 'HELPER_QUOTED' # passed through",
      "    - HELPER_SET=${HELPER_INTERPOLATED:-}",
      '    - "HELPER_SET_QUOTED=a b"',
      "    cap_add:",
      "    - SYS_ADMIN",
      "  runtime: # the service under test",
      "    image: ${RUNTIME_IMAGE}",
      "    cpus: ${RUNTIME_CPUS:-2}",
      "    mem_limit: ${RUNTIME_MEMORY:-4g} # sized by the controller",
      "    environment: # what a launch request reaches",
      "      # COMMENTED_OUT: ${COMMENTED_OUT}",
      "      RUNTIME_PASSED:",
      "      RUNTIME_COMMENTED: # passed through",
      "      RUNTIME_SET: ${RUNTIME_INTERPOLATED:-}",
      "      RUNTIME_SCRIPT: |",
      "        # ${RUNTIME_BLOCK_SCALAR}",
      "      RUNTIME_AFTER_SCRIPT: ${RUNTIME_AFTER_BLOCK_SCALAR}",
      "    cap_drop:",
      "      - NET_RAW",
      "volumes:",
      "  proxy-cache: {}",
      "secrets:",
      "  token:",
      "    environment: SECRET_SOURCE # a secret's source",
      "",
    ].join("\n"),
    "inline Compose file",
  );
  assert.deepEqual([...uses.environment].sort(), [
    "RUNTIME_AFTER_BLOCK_SCALAR",
    "RUNTIME_BLOCK_SCALAR",
    "RUNTIME_COMMENTED",
    "RUNTIME_INTERPOLATED",
    "RUNTIME_PASSED",
  ]);
  assert.deepEqual([...uses.limits].sort(), ["RUNTIME_CPUS", "RUNTIME_MEMORY"]);
  assert.deepEqual([...uses.elsewhere].sort(), [
    "BLOCK_SCALAR_COMMENT_LINE",
    "BLOCK_SCALAR_LINE",
    "BUILD_ARG_COMMENTED",
    "BUILD_ARG_PASSED",
    "HELPER_CPUS",
    "HELPER_INTERPOLATED",
    "HELPER_PASSED",
    "HELPER_QUOTED",
    "HOOK_FIRST_KEY_PASSED",
    "HOOK_PASSED",
    "INTERPOLATED_AFTER_ESCAPE",
    "INTERPOLATED_AFTER_HASH",
    "INTERPOLATED_IN_TAGGED_QUOTE",
    "RUNTIME_IMAGE",
    "SECRET_SOURCE",
    "SIDECAR_COMMENTED",
    "SIDECAR_INTERPOLATED",
    "SIDECAR_JSON_DEFAULTED",
    "SIDECAR_NULL",
    "SIDECAR_NULL_TAGGED",
    "SIDECAR_NULL_TITLE",
    "SIDECAR_NULL_UPPER",
    "SIDECAR_PASSED",
    "SIDECAR_QUOTED",
    "SIDECAR_TILDE",
    "VOLUME_SOURCE",
  ]);
});

test("the Compose variable scan fails on YAML it does not follow", () => {
  // Through each case Compose can hand the proxy sidecar a variable from the
  // environment that runs Compose without the line scan seeing it, so the scan
  // fails there instead.
  for (const [what, topLevel, sidecar, failure] of [
    ["an anchor", ["x-shared: &shared-env", "  SHARED_PASSED:"], ["    image: proxy"], /an anchor or alias/],
    ["an alias", [], ["    environment: *shared-env"], /an anchor or alias/],
    ["a merge key", [], ["    environment:", "      <<:", "        SHARED_PASSED:"], /a merge key/],
    ["an explicit key", [], ["    ? environment", "    : - SIDECAR_PASSED"], /an explicit key/],
    ["a flow mapping", [], ["    build: {args: [BUILD_ARG_PASSED]}"], /a flow mapping/],
    ["a tagged flow mapping", [], ["    build: !!map {args: [BUILD_ARG_PASSED]}"], /a tag/],
    ["a tagged key", [], ["    !!str environment:", "      SIDECAR_PASSED:"], /a tag/],
    ["a verbatim null", [], ["    environment:", "      SIDECAR_PASSED: !<tag:yaml.org,2002:null>"], /a tag/],
    ["Compose's !override", [], ["    environment: !override", "      SIDECAR_PASSED:"], /a tag/],
    ["flow-style environment entries", [], ["    environment: [SIDECAR_PASSED]"], /environment: entries only in block style/],
    ["flow-style build args", [], ["    build:", "      args: [BUILD_ARG_PASSED]"], /args: entries only in block style/],
    ["flow-style entries under a block key", [], ["    environment:", "      [SIDECAR_PASSED]"], /does not read this environment: entry/],
    ["a value continued on the next line", [], ["    environment:", "      SIDECAR_SET: one", "        two"], /does not read this environment: entry/],
    ["a quoted value continued on the next line", [], ["    labels:", '      note: "model', '        #${SIDECAR_INTERPOLATED}"'], /a quoted value continued/],
    ["an escape that spells a $", [], ["    environment:", '      SIDECAR_SET: "\\x24{SIDECAR_INTERPOLATED}"'], /escape in a double-quoted value/],
    ["a tagged escape that spells a $", [], ["    environment:", '      SIDECAR_SET: !!str "\\x24{SIDECAR_INTERPOLATED:+1}"'], /escape in a double-quoted value/],
    ["a tagged quoted value continued on the next line", [], ["    labels:", '      note: !!str "model', '        #${SIDECAR_INTERPOLATED:+set}"'], /a quoted value continued/],
    ["a $ in a trailing comment", [], ["    environment:", "      SIDECAR_SET: one # ${SIDECAR_INTERPOLATED}"], /trailing comment/],
    ["extends", [], ["    extends: runtime"], /extends:/],
    ["include", ["include:", "  - sidecar.yml"], ["    image: proxy"], /include:/],
    ["a lone CR", [], ["    image: proxy # the sidecar\r    environment:\r      - SIDECAR_PASSED"], /only LF and CRLF line breaks/],
    ["a next line (U+0085)", [], ["    environment:", "      SIDECAR_SET: one\u0085      SIDECAR_PASSED:"], /only LF and CRLF line breaks/],
    ["a line separator (U+2028)", [], ["    image: proxy # the sidecar\u2028    environment:\u2028      - SIDECAR_PASSED"], /only LF and CRLF line breaks/],
    ["a paragraph separator (U+2029)", [], ["    image: proxy # the sidecar\u2029    environment:\u2029      - SIDECAR_PASSED"], /only LF and CRLF line breaks/],
    ["a byte order mark", ["\uFEFFx-note: first"], ["    image: proxy"], /no byte order mark/],
  ]) {
    const text = [
      ...topLevel,
      "services:",
      "  proxy:",
      ...sidecar,
      "  runtime:",
      "    environment:",
      "      RUNTIME_SET: ${RUNTIME_INTERPOLATED:-}",
      "",
    ].join("\n");
    assert.throws(() => composeVariableUsesInText(text, "inline Compose file"), failure, what);
  }
});

test("the Compose variable scan reads a CRLF line ending as an LF", () => {
  const text = [
    "services:",
    "  proxy:",
    "    environment:",
    "      - SIDECAR_PASSED",
    "  runtime:",
    "    environment:",
    "      RUNTIME_SET: ${RUNTIME_INTERPOLATED:-} # read by the runtime",
    "",
  ].join("\n");
  assert.deepEqual(
    composeVariableUsesInText(text.replaceAll("\n", "\r\n"), "inline Compose file"),
    composeVariableUsesInText(text, "inline Compose file"),
  );
});

test("a launch request sets only variables the runtime Compose files keep inside the runtime, and each other runtime variable is the operator's", () => {
  const { managed, exactOnly, operatorOnly, requestDerived } = allocatorEnvLists();
  for (const key of exactOnly) {
    assert.ok(managed.includes(key), `EXACT_ONLY_LAUNCH_ENV_KEYS lists ${key}, which is no managed launch key`);
  }
  for (const [first, firstName, second, secondName] of [
    [managed, "the managed launch keys", operatorOnly, "OPERATOR_ONLY_RUNTIME_ENV_KEYS"],
    [managed, "the managed launch keys", requestDerived, "REQUEST_DERIVED_RUNTIME_ENV_KEYS"],
    [operatorOnly, "OPERATOR_ONLY_RUNTIME_ENV_KEYS", requestDerived, "REQUEST_DERIVED_RUNTIME_ENV_KEYS"],
  ]) {
    for (const key of first) {
      assert.ok(!second.includes(key), `${key} is in both ${firstName} and ${secondName}`);
    }
  }
  // What a launch decides stays among the runtime's own names, none of them a
  // setting the Docker CLI, Compose, BuildKit, the loader, the shell, git, Go,
  // TLS or an HTTP client reads; the scan below covers what the Compose files
  // themselves read.
  const requestSet = [...managed, ...requestDerived];
  for (const key of requestSet) {
    assert.match(key, /^(?:INSTAFY|ORIGIN|RUNTIME)_/, `${key} is outside the runtime's own variable families`);
    assert.doesNotMatch(key, /_PROXY$/i, `${key} reads as a proxy setting`);
  }

  const environment = new Set();
  const elsewhere = new Map();
  for (const composeFile of [COMPOSE_FILE, PROVIDER_COMPOSE_FILE]) {
    const uses = composeVariableUses(composeFile);
    for (const key of uses.environment) {
      environment.add(key);
    }
    for (const key of uses.elsewhere) {
      if (!elsewhere.has(key)) {
        elsewhere.set(key, composeFile);
      }
    }
    for (const [key, reason] of NOT_FORWARDED_TO_RUNTIME) {
      assert.ok(
        reason !== "compose-level" || uses.limits.has(key),
        `${composeFile}: Compose parse is missing ${key} on the runtime's cpus: or mem_limit:`,
      );
    }
    // Only the size limits may size the runtime. Any other variable on its
    // `cpus:` or `mem_limit:`, a default behind a size limit included, counts
    // as used outside the runtime's environment.
    for (const key of uses.limits) {
      if (NOT_FORWARDED_TO_RUNTIME.get(key) !== "compose-level" && !elsewhere.has(key)) {
        elsewhere.set(key, composeFile);
      }
    }
  }
  for (const key of ["RUNTIME_REPO_HOST", "RUNTIME_AGENT_IMAGE", "RUNTIME_PROXY_IMAGE", "INSTAFY_ENV_DIR"]) {
    assert.ok(elsewhere.has(key), `Compose parse is missing ${key} outside the runtime environment`);
  }

  for (const key of requestSet) {
    assert.ok(
      !elsewhere.has(key),
      `${elsewhere.get(key)} uses ${key} outside the runtime container's environment, so a launch request must not set it`,
    );
  }
  for (const [list, listName] of [
    [requestDerived, "REQUEST_DERIVED_RUNTIME_ENV_KEYS"],
    [operatorOnly, "OPERATOR_ONLY_RUNTIME_ENV_KEYS"],
  ]) {
    for (const key of list) {
      assert.ok(
        environment.has(key),
        `no runtime Compose file passes ${key} to the runtime container: drop it from ${listName}`,
      );
    }
  }
  for (const key of environment) {
    assert.ok(
      elsewhere.has(key) || managed.includes(key) || operatorOnly.includes(key) || requestDerived.includes(key),
      `the runtime container takes ${key} only from its environment, and ${ALLOCATOR_DOCKER_FILE} does not say who sets it: add it to OPERATOR_ONLY_RUNTIME_ENV_KEYS, so that only the provider's operator sets it, in the provider service's own environment, or, if a launch must choose it, make it a managed launch key in ${ALLOCATOR_ALLOWLIST_FILE} or a variable build_env derives from the request (REQUEST_DERIVED_RUNTIME_ENV_KEYS), which this test then keeps inside the runtime container`,
    );
  }
});

// The line scan above needs no Docker but is not a YAML parser, so where
// Docker Compose is available this test also checks Compose's own reading of
// both files. Compose renders each file without any variable a request may
// set, with only the size limits, with every such variable but the size
// limits, and with all of them, each holding a value of its own. Setting the
// size limits may change only the runtime's `cpus:` and `mem_limit:`, and
// setting any other of those variables, with or without the size limits, only
// the runtime container's `environment:`. A change anywhere else is a place
// where Compose reads one of those variables, a `${NAME:+...}` that only
// tests whether it is set included. What Compose reads from its environment
// only later, for a lifecycle hook or a secret or config, renders as the
// variable's name either way, so that is looked for as well. Compose renders
// without loading env files, so an env_file's path shows where it takes one
// of those variables; a Compose too old for that merges each env file into
// `environment:` and leaves its path out, and then only the line scan checks
// env_file paths. A default behind a provider variable that every rendering
// sets is never read, and no rendering sets one size limit without the other,
// so such a default and a variable read only while just one size limit is
// set are checked only by the line scan.
const SIZE_LIMIT_VALUES = new Map([
  ["RUNTIME_CPU_LIMIT", "1.25"],
  ["RUNTIME_MEMORY_LIMIT", "1234m"],
]);

// A value of its own for each variable a launch request may set: delimited,
// so that no key's value is part of another's, apart from the size limits,
// which Compose parses.
function requestValue(key) {
  return SIZE_LIMIT_VALUES.get(key) ?? `launch-request(${key})`;
}

// Compose's reading of `composeFile` with `variables` in its environment,
// every profile the file declares included, since Compose interpolates every
// service of a file it loads, and env files left unread where this Compose
// can show their paths instead.
function composeConfig(root, composeFile, variables) {
  const envFiles = composeShowsEnvFiles ? ["--no-env-resolution"] : [];
  const run = (command) =>
    spawnSync(
      "docker",
      ["compose", "--project-directory", root, "--env-file", path.join(root, "empty.env"), "--file", composeFile, ...command],
      {
        encoding: "utf8",
        // Only what the Docker CLI needs, plus the given variables.
        env: {
          PATH: process.env.PATH,
          HOME: process.env.HOME,
          ...(process.env.DOCKER_CONFIG ? { DOCKER_CONFIG: process.env.DOCKER_CONFIG } : {}),
          ...variables,
        },
        timeout: 30_000,
      },
    );
  const profiles = run(["config", ...envFiles, "--profiles"]);
  if (profiles.status !== 0) {
    return { error: profiles.stderr || String(profiles.error) };
  }
  const profileArgs = profiles.stdout
    .split("\n")
    .filter((profile) => profile.trim() !== "")
    .flatMap((profile) => ["--profile", profile.trim()]);
  const result = run([...profileArgs, "config", ...envFiles, "--format", "json"]);
  return result.status === 0
    ? { config: JSON.parse(result.stdout) }
    : { error: result.stderr || String(result.error) };
}

// Where Compose's reading of a file with more of a request's variables set
// (`after`) takes something from them, compared with its reading with fewer
// (`before`): every difference outside the runtime container's `environment:`
// and, if `sized`, its size limits, and every lifecycle hook entry, secret or
// config that names one of `keys` for Compose to read later.
function composeRequestReads(before, after, keys, sized = true) {
  const reads = [];
  const runtimeOwn = (at) =>
    at[0] === "services" &&
    at[1] === "runtime" &&
    (at[2] === "environment" ||
      (sized && at.length === 3 && (at[2] === "cpus" || at[2] === "mem_limit")));
  const isObject = (value) => value !== null && typeof value === "object";
  const compare = (before, after, at) => {
    if (before === after || runtimeOwn(at)) {
      return;
    }
    if (isObject(before) && isObject(after) && Array.isArray(before) === Array.isArray(after)) {
      for (const name of new Set([...Object.keys(before), ...Object.keys(after)])) {
        compare(before[name], after[name], [...at, name]);
      }
      return;
    }
    reads.push(`${at.join(".")}: ${JSON.stringify(before)} becomes ${JSON.stringify(after)}`);
  };
  compare(before, after, []);
  const visit = (value, at) => {
    if (!isObject(value) || runtimeOwn(at)) {
      return;
    }
    for (const [name, child] of Object.entries(value)) {
      const childAt = [...at, name];
      // An entry Compose takes from its environment only when it runs, as a
      // lifecycle hook's is, renders as a null.
      if (child === null && keys.includes(name)) {
        reads.push(`${childAt.join(".")}: read when Compose runs it`);
      }
      // A secret's or config's source, read when Compose creates it.
      if (
        childAt.length === 3 &&
        (childAt[0] === "secrets" || childAt[0] === "configs") &&
        name === "environment" &&
        keys.includes(child)
      ) {
        reads.push(`${childAt.join(".")}: ${child}, read when Compose creates it`);
      }
      visit(child, childAt);
    }
  };
  visit(after, []);
  return reads;
}

// Where the readings described above show Compose, reading `file` with
// `providerVariables` in its environment, take something from a launch
// request's variables `keys` outside the runtime container's `environment:`
// and, for the size limits, the runtime's `cpus:` and `mem_limit:`, and its
// reading with all of them (`set`). Otherwise an error that names the
// readings Compose refused.
function composeRequestReadsOf(root, file, keys, providerVariables = {}) {
  const sizes = keys.filter((key) => SIZE_LIMIT_VALUES.has(key));
  const others = keys.filter((key) => !SIZE_LIMIT_VALUES.has(key));
  const readings = [
    ["without a launch request's variables", []],
    ["with only a launch request's size limits", sizes],
    ["with a launch request's variables but its size limits", others],
    ["with all of a launch request's variables", keys],
  ].map(([what, included]) => ({
    what,
    ...composeConfig(root, file, {
      ...providerVariables,
      ...Object.fromEntries(included.map((key) => [key, requestValue(key)])),
    }),
  }));
  const refused = readings.filter((reading) => !reading.config);
  if (refused.length > 0) {
    const which =
      refused.length === readings.length
        ? "with or without a launch request's variables"
        : refused.map((reading) => reading.what).join(", or ");
    return { error: `${which}: ${refused[0].error.trim()}` };
  }
  const [unset, sized, unsized, set] = readings.map((reading) => reading.config);
  const reads = new Set([
    ...composeRequestReads(unset, sized, keys),
    ...composeRequestReads(unset, unsized, keys, false),
    ...composeRequestReads(sized, set, keys, false),
  ]);
  return { reads: [...reads], set };
}

test(
  "Compose takes a launch request's variables, apart from the size limits, only into the runtime container",
  { skip: !composeAvailable && "Docker Compose v2 unavailable" },
  (t) => {
    if (!composeShowsEnvFiles) {
      t.diagnostic("this Compose cannot show env_file paths, so only the line scan checks them");
    }
    const { managed, requestDerived } = allocatorEnvLists();
    const keys = [...new Set([...managed, ...requestDerived])];
    for (const key of SIZE_LIMIT_VALUES.keys()) {
      assert.equal(NOT_FORWARDED_TO_RUNTIME.get(key), "compose-level", `${key} is no size limit`);
      assert.ok(keys.includes(key), `${key} is not a variable a launch request may set`);
    }
    const root = fs.mkdtempSync(path.join(os.tmpdir(), "instafy-compose-request-"));
    try {
      fs.writeFileSync(path.join(root, "empty.env"), "");
      fs.mkdirSync(path.join(root, "docker"));
      fs.writeFileSync(path.join(root, "docker", ".env.local"), "");
      const sidecarEnvFile = path.join(root, "proxy-credential-lease.env");
      fs.writeFileSync(sidecarEnvFile, "");
      // What the provider's own environment supplies. A variable a runtime
      // Compose file requires and only the provider sets belongs here.
      const providerVariables = {
        INSTAFY_ENV_DIR: root,
        PROXY_CREDENTIAL_LEASE_ENV_FILE: sidecarEnvFile,
        RUNTIME_PROXY_IMAGE: "runtime-proxy:fixture",
        RUNTIME_AGENT_IMAGE: "runtime-agent:fixture",
      };
      for (const composeFile of [COMPOSE_FILE, PROVIDER_COMPOSE_FILE]) {
        const result = composeRequestReadsOf(root, path.join(REPO_ROOT, composeFile), keys, providerVariables);
        assert.ok(result.reads, `${composeFile}: Compose cannot read it ${result.error}`);
        assert.deepEqual(
          result.reads,
          [],
          `${composeFile}: Compose takes these from a launch request's variables outside the runtime container`,
        );
        // Guard the check itself: the values do reach the runtime, the size
        // limits size it, and the line scan saw each variable Compose passed
        // into the runtime container.
        const runtime = result.set.services.runtime;
        for (const key of ["ORIGIN_GIT_REMOTE_URL", "RUNTIME_METADATA", "ORIGIN_METADATA"]) {
          assert.equal(
            runtime.environment[key],
            requestValue(key),
            `${composeFile}: the launch request's ${key} never reached the runtime`,
          );
        }
        assert.equal(String(runtime.cpus), requestValue("RUNTIME_CPU_LIMIT"), `${composeFile}: cpus`);
        // 1234m, which Compose renders in bytes.
        assert.equal(String(runtime.mem_limit), String(1234 * 1024 * 1024), `${composeFile}: mem_limit`);
        const scanned = composeVariableUses(composeFile).environment;
        for (const value of Object.values(runtime.environment)) {
          for (const key of keys) {
            if (!SIZE_LIMIT_VALUES.has(key) && String(value).includes(requestValue(key))) {
              assert.ok(
                scanned.has(key),
                `${composeFile}: Compose passes ${key} to the runtime container, but the line scan did not see it there`,
              );
            }
          }
        }
      }
    } finally {
      fs.rmSync(root, { force: true, recursive: true });
    }
  },
);

// The check above rests on how Compose renders what it reads. Each case here
// is a scratch Compose file in which Compose takes a launch request's variable
// somewhere the check must refuse, and the check must find it with the
// Compose that runs these tests. A Compose that cannot load a lifecycle hook,
// a watch action, or a secret or config from the environment cannot load one
// in the runtime Compose files either, so such a case is skipped.
test(
  "the Compose check finds a launch request's variables wherever Compose reads them",
  { skip: !composeAvailable && "Docker Compose v2 unavailable" },
  (t) => {
    const helper = ["  helper:", "    image: helper"];
    const cases = [
      ["another service's value", [...helper, "    environment:", "      HELPER_MODEL: ${INSTAFY_VNC_GEOMETRY:-}"], "services.helper.environment.HELPER_MODEL"],
      ["a test of whether it is set", [...helper, "    environment:", "      HELPER_HAS_MODEL: ${INSTAFY_VNC_GEOMETRY:+set}"], "services.helper.environment.HELPER_HAS_MODEL"],
      ["an entry passed through", [...helper, "    environment:", "      - INSTAFY_VNC_GEOMETRY"], "services.helper.environment.INSTAFY_VNC_GEOMETRY"],
      ["a size limit", [...helper, "    environment:", "      HELPER_MEMORY: ${RUNTIME_MEMORY_LIMIT:-4g}"], "services.helper.environment.HELPER_MEMORY"],
      ["a service under a profile", [...helper, "    profiles:", "      - debug", "    environment:", "      HELPER_MODEL: ${INSTAFY_VNC_GEOMETRY:-}"], "services.helper.environment.HELPER_MODEL"],
      ["the runtime's other settings", ["    labels:", "      model: ${INSTAFY_VNC_GEOMETRY:-}"], "services.runtime.labels.model"],
      ["a default behind a size limit", ["    cpus: ${RUNTIME_CPU_LIMIT:-${INSTAFY_VNC_GEOMETRY:+1}2}"], "services.runtime.cpus"],
      ["a test beside a size limit", ["    cpus: ${RUNTIME_CPU_LIMIT:+${INSTAFY_VNC_GEOMETRY:+1}}${RUNTIME_CPU_LIMIT:-2}"], "services.runtime.cpus"],
      ["a lifecycle hook", [...helper, "    post_start:", "      - command: ./warm.sh", "        environment:", "          - INSTAFY_VNC_GEOMETRY"], "services.helper.post_start.0.environment.INSTAFY_VNC_GEOMETRY", "optional"],
      ["a watch action", [...helper, "    develop:", "      watch:", "        - path: ./src", "          target: /src", "          action: sync+exec", "          exec:", "            command: ./reload.sh", "            environment:", "              INSTAFY_VNC_GEOMETRY:"], "services.helper.develop.watch.0.exec.environment.INSTAFY_VNC_GEOMETRY", "optional"],
      ["a secret", [...helper, "    secrets:", "      - model", "secrets:", "  model:", "    environment: INSTAFY_VNC_GEOMETRY"], "secrets.model.environment", "optional"],
      ["a config", [...helper, "    configs:", "      - model", "configs:", "  model:", "    environment: INSTAFY_VNC_GEOMETRY"], "configs.model.environment", "optional"],
    ];
    if (composeShowsEnvFiles) {
      cases.push(["an env file's path", ["    env_file:", "      - path: ${INSTAFY_VNC_GEOMETRY:-/dev/null}", "        required: false"], "services.runtime.env_file.0.path"]);
    } else {
      t.diagnostic("an env file's path: skipped, this Compose cannot show env_file paths");
    }
    const keys = ["INSTAFY_VNC_GEOMETRY", "ORIGIN_GIT_REMOTE_URL", ...SIZE_LIMIT_VALUES.keys()];
    const root = fs.mkdtempSync(path.join(os.tmpdir(), "instafy-compose-reads-"));
    try {
      fs.writeFileSync(path.join(root, "empty.env"), "");
      for (const [index, [what, lines, expected, optional]] of cases.entries()) {
        const file = path.join(root, `case-${index}.yml`);
        // The runtime, sized by its memory limit. A case that starts with a
        // four-space line adds settings to the runtime, before its
        // `environment:`; any other case follows the runtime.
        const runtime = [
          "services:",
          "  runtime:",
          "    image: runtime",
          "    mem_limit: ${RUNTIME_MEMORY_LIMIT:-4g}",
          "    environment:",
          "      ORIGIN_GIT_REMOTE_URL: ${ORIGIN_GIT_REMOTE_URL:-}",
          "      INSTAFY_VNC_GEOMETRY: ${INSTAFY_VNC_GEOMETRY:-}",
        ];
        const text = lines[0].startsWith("    ") ? [...runtime.slice(0, 4), ...lines, ...runtime.slice(4)] : [...runtime, ...lines];
        fs.writeFileSync(file, `${text.join("\n")}\n`);
        const result = composeRequestReadsOf(root, file, keys);
        if (optional && result.error) {
          t.diagnostic(`${what}: skipped, this Compose does not load it: ${result.error}`);
          continue;
        }
        assert.ok(result.reads, `${what}: ${result.error}`);
        assert.ok(
          result.reads.some((read) => read.startsWith(`${expected}:`)),
          `${what}: expected a read at ${expected}, got ${JSON.stringify(result.reads)}`,
        );
      }
      // And the control: a file that keeps the variables inside the runtime
      // container shows no read.
      const file = path.join(root, "control.yml");
      fs.writeFileSync(
        file,
        [
          "services:",
          "  runtime:",
          "    image: runtime",
          "    cpus: ${RUNTIME_CPU_LIMIT:-2}",
          "    mem_limit: ${RUNTIME_MEMORY_LIMIT:-4g}",
          "    environment:",
          "      ORIGIN_GIT_REMOTE_URL: ${ORIGIN_GIT_REMOTE_URL:-}",
          "      INSTAFY_VNC_GEOMETRY:",
          "",
        ].join("\n"),
      );
      const control = composeRequestReadsOf(root, file, keys);
      assert.ok(control.reads, control.error);
      assert.deepEqual(control.reads, []);
    } finally {
      fs.rmSync(root, { force: true, recursive: true });
    }
  },
);

// The runtime agent and the origin server both trim the value and treat an
// empty remote as none, so an unset variable keeps today's no-remote behavior.
test("the provider runtime forwards an unset git remote as empty", () => {
  assert.equal(
    providerRuntimeService().environment.get("ORIGIN_GIT_REMOTE_URL"),
    "${ORIGIN_GIT_REMOTE_URL:-}",
  );
});

// The runtime agent's held-pages switch turns holding another chat's pages off
// without a release. A provider runtime gets only what the provider Compose
// file's `environment:` lists, and that file once left the switch out, so it
// could not be set on hosted runtimes at all.
const HOLD_PAGES_SOURCE_FILE = "packages/runtime-agent/src/jobs/space_pages.rs";

function holdPagesVariable() {
  const source = fs.readFileSync(path.join(REPO_ROOT, HOLD_PAGES_SOURCE_FILE), "utf8");
  const name = source.match(/const HOLD_PAGES_ENV: &str = "([A-Za-z_][A-Za-z0-9_]*)";/)?.[1];
  assert.ok(name, `${HOLD_PAGES_SOURCE_FILE}: HOLD_PAGES_ENV not found`);
  return name;
}

test("the provider runtime forwards the held-pages switch, on when unset", () => {
  const name = holdPagesVariable();
  assert.equal(name, "INSTAFY_HOLD_PAGES");
  assert.equal(providerRuntimeService().environment.get(name), `\${${name}:-1}`);
});

// The runtime agent's switch for research pages that search before the
// browser is off until it is set, on hosted runtimes too.
test("the provider runtime forwards the research-pages switch, off when unset", () => {
  const source = fs.readFileSync(path.join(REPO_ROOT, "packages/runtime-agent/src/jobs/mod.rs"), "utf8");
  const name = source.match(/const RESEARCH_PAGES_SEARCH_FIRST_ENV: &str = "([A-Za-z_][A-Za-z0-9_]*)";/)?.[1];
  assert.equal(name, "INSTAFY_RESEARCH_PAGES_SEARCH_FIRST");
  assert.equal(providerRuntimeService().environment.get(name), `\${${name}:-0}`);
});

test(
  "the held-pages switch reaches the runtime from where each Compose file reads it",
  { skip: !composeAvailable && "Docker Compose v2 unavailable" },
  () => {
    const name = holdPagesVariable();
    const root = fs.mkdtempSync(path.join(os.tmpdir(), "instafy-compose-hold-pages-"));
    try {
      const emptyEnvFile = path.join(root, "empty.env");
      fs.writeFileSync(emptyEnvFile, "");
      fs.mkdirSync(path.join(root, "docker"));
      const localEnvFile = path.join(root, "docker", ".env.local");
      const sidecarEnvFile = path.join(root, "proxy-credential-lease.env");
      fs.writeFileSync(sidecarEnvFile, "");
      const runtimeValue = (composeFile, { environment = {}, envLocal = "" } = {}) => {
        fs.writeFileSync(localEnvFile, envLocal);
        const result = spawnSync(
          "docker",
          [
            "compose",
            "--project-directory",
            root,
            "--env-file",
            emptyEnvFile,
            "--file",
            path.join(REPO_ROOT, composeFile),
            "config",
            "--format",
            "json",
            "runtime",
          ],
          {
            encoding: "utf8",
            // Only what the Docker CLI needs, so no ambient value leaks in.
            env: {
              PATH: process.env.PATH,
              HOME: process.env.HOME,
              ...(process.env.DOCKER_CONFIG
                ? { DOCKER_CONFIG: process.env.DOCKER_CONFIG }
                : {}),
              INSTAFY_ENV_DIR: root,
              PROXY_CREDENTIAL_LEASE_ENV_FILE: sidecarEnvFile,
              RUNTIME_PROXY_IMAGE: "runtime-proxy:fixture",
              RUNTIME_AGENT_IMAGE: "runtime-agent:fixture",
              ...environment,
            },
            timeout: 30_000,
          },
        );
        assert.equal(result.status, 0, `${composeFile}: ${result.stderr}`);
        return JSON.parse(result.stdout).services.runtime.environment[name];
      };

      // Hosted: the provider service runs Compose with its own environment
      // (allocator/docker.rs), so its value is the one that counts.
      assert.equal(runtimeValue(PROVIDER_COMPOSE_FILE), "1", "unset keeps holding on");
      assert.equal(
        runtimeValue(PROVIDER_COMPOSE_FILE, { environment: { [name]: "" } }),
        "1",
        "empty keeps holding on",
      );
      assert.equal(
        runtimeValue(PROVIDER_COMPOSE_FILE, { environment: { [name]: "0" } }),
        "0",
        "the provider's 0 reaches the runtime",
      );

      // Self-hosted: the local file hands the runtime all of .env.local. An
      // `environment:` entry would override that file, so it must list none.
      assert.equal(
        runtimeValue(COMPOSE_FILE, { envLocal: `${name}=0\n` }),
        "0",
        ".env.local's 0 reaches the runtime",
      );
      assert.equal(
        runtimeValue(COMPOSE_FILE),
        undefined,
        "unset stays unset, which the runtime reads as on",
      );
    } finally {
      fs.rmSync(root, { force: true, recursive: true });
    }
  },
);

// runtime-agent runs as the container's first process, and nothing else
// there reaps the processes its tools leave behind: a machine kept 145
// finished ones (git, Chromium and its crash handler) after 52 minutes. An
// init as PID 1 reaps them, as the origin gateway's does.
test("the runtime runs under an init in both Compose files", () => {
  for (const composeFile of [COMPOSE_FILE, PROVIDER_COMPOSE_FILE]) {
    assert.ok(
      runtimeServiceLines(composeFile).includes("    init: true"),
      `${composeFile}: the runtime service needs init: true`,
    );
  }
});
