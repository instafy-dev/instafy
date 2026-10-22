import { describe, expect, it } from "vitest";
import {
  DISPOSABLE_TEST_USER_EMAIL_PATTERNS,
  isPlaywrightTestUserEmail,
  ownedProjectIdsSql,
  ownedRuntimeContainerIds,
  ownedRuntimeNetworkIds,
  ownedRuntimeRowsCleanupSql,
  parseProjectIds,
  runtimeCleanupDisabled,
  runtimeComposeNames,
} from "./runtimeCleanupScope.js";

const OWNED = "1a0b2c12-f6dd-4a28-84b3-28bce3048bad";
const DEVELOPERS = "9f8e7d6c-5b4a-4321-8fed-cba987654321";
const simple = (id: string) => id.replace(/-/g, "");
const names = { prefix: "instafy-runtime-", baseComposeProject: "instafy-runtime" };

describe("Playwright runtime cleanup scope", () => {
  it("is turned off by KEEP_RUNTIME=1 or PLAYWRIGHT_CLEANUP_RUNTIME=0", () => {
    expect(runtimeCleanupDisabled({})).toBe(false);
    expect(runtimeCleanupDisabled({ KEEP_RUNTIME: "1" })).toBe(true);
    expect(runtimeCleanupDisabled({ PLAYWRIGHT_CLEANUP_RUNTIME: "0" })).toBe(true);
    expect(runtimeCleanupDisabled({ PLAYWRIGHT_CLEANUP_RUNTIME: " 0 " })).toBe(true);
    expect(runtimeCleanupDisabled({ KEEP_RUNTIME: "0", PLAYWRIGHT_CLEANUP_RUNTIME: "1" })).toBe(false);
  });

  it("removes only the runtime containers of the suite's own projects", () => {
    const rows = [
      // the stack's shared services: the model proxy and the gateways
      "c-proxy\tinstafy-runtime-proxy-1\tinstafy-runtime",
      "c-gateway\tinstafy-runtime-origin-gateway-1\tinstafy-runtime",
      // a developer's own space
      `c-dev\tinstafy-runtime-${simple(DEVELOPERS)}-1234abcd-runtime-1\tinstafy-runtime-${simple(DEVELOPERS)}-1234abcd`,
      // started by hand, no compose project
      "c-loose\tinstafy-runtime-scratch\t",
      // a Playwright project's runtime
      `c-owned\tinstafy-runtime-${simple(OWNED)}-5678ef01-runtime-1\tinstafy-runtime-${simple(OWNED)}-5678ef01`,
    ].join("\n");
    expect(ownedRuntimeContainerIds(rows, { ...names, projectIds: [OWNED] })).toEqual(["c-owned"]);
    expect(ownedRuntimeContainerIds(rows, { ...names, projectIds: [] })).toEqual([]);
  });

  it("removes only the runtime networks of the suite's own projects", () => {
    const rows = [
      "n-base\tinstafy-runtime_default",
      `n-dev\tinstafy-runtime-${simple(DEVELOPERS)}-1234abcd_default`,
      `n-owned\tinstafy-runtime-${simple(OWNED)}-5678ef01_default`,
    ].join("\n");
    expect(ownedRuntimeNetworkIds(rows, { prefix: names.prefix, projectIds: [OWNED] })).toEqual(["n-owned"]);
  });

  it("clears runtime rows of the suite's own projects only", () => {
    const sql = ownedRuntimeRowsCleanupSql([OWNED]);
    expect(sql).not.toBeNull();
    const statements = sql!.split(";").map((statement) => statement.trim()).filter(Boolean);
    expect(statements).toHaveLength(5);
    for (const statement of statements) {
      expect(statement).toContain(`where project_id in ('${OWNED}')`);
    }
    expect(ownedRuntimeRowsCleanupSql([])).toBeNull();
    expect(ownedRuntimeRowsCleanupSql(["x'; delete from runtimes; --"])).toBeNull();
  });

  it("knows the suite's users: the configured one and the disposable ones the harness signs up", () => {
    const env = { PLAYWRIGHT_TEST_EMAIL: "Playwright@Instafy.dev" };
    for (const email of [
      "playwright@instafy.dev",
      `guest+${OWNED}@instafy.dev`,
      `private-runtime-shared-${OWNED}@instafy.dev`,
      `electron-shared-browser-${OWNED}@instafy.dev`,
    ]) {
      expect(isPlaywrightTestUserEmail(email, env), email).toBe(true);
    }
    for (const email of ["marcus@example.com", "guest@instafy.dev", "guest+me@instafy.dev", "teammate@instafy.dev"]) {
      expect(isPlaywrightTestUserEmail(email, env), email).toBe(false);
    }
    const sql = ownedProjectIdsSql({ PLAYWRIGHT_TEST_EMAIL: "Playwright@Instafy.dev" });
    expect(sql).toContain("lower(users.email) in ('playwright@instafy.dev')");
    // an address that could break out of the query is not used at all
    expect(ownedProjectIdsSql({ PLAYWRIGHT_TEST_EMAIL: "x'or'1'='1@instafy.dev" })).not.toContain("x'or");
    for (const pattern of DISPOSABLE_TEST_USER_EMAIL_PATTERNS) {
      expect(sql).toContain(`'${pattern}'`);
    }
    expect(sql).toContain("projects.owner_user_id");
  });

  it("reads project ids from psql output and the compose names from the environment", () => {
    expect(parseProjectIds(`${OWNED}\n\n${OWNED.toUpperCase()}\nnot-a-uuid\n`)).toEqual([OWNED]);
    expect(runtimeComposeNames({})).toEqual(names);
    expect(runtimeComposeNames({ DOCKER_PROJECT_PREFIX: "x-", COMPOSE_PROJECT_NAME: "x" })).toEqual({
      prefix: "x-",
      baseComposeProject: "x",
    });
  });
});
