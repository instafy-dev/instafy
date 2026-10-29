import fs from "node:fs";
import path from "node:path";

// Keep a concrete coverage contract: a typo/filter that selects one passing
// test must not turn the required lane green while omitting its main proof.
export const REQUIRED_BROWSER_LANES = Object.freeze({
  personal: {
    minimumTests: 6,
    files: ["electron-personal-browser.spec.ts"],
    titles: [
      "is enabled by default and rejects opening behind the explicit kill switch",
      "persists one local profile across restarts and isolates another profile",
      "keeps real login cookies per user across projects and restarts, then clears only that user",
      "revokes ownership and control when the Studio renderer reloads",
      "stops agent-driven page loads on a link-only site or a private address, also by the address actually connected to",
      "judges and takes form steps by the submission the browser makes, the default button's formaction, formmethod and formtarget included",
    ],
  },
  "browser-ui": {
    minimumTests: 59,
    // CI runs this lane as two Playwright shards, one job each. Each part
    // proves only its own tests; the required job checks this contract on
    // both parts' receipts together (combineRequiredBrowserParts).
    parts: 2,
    files: [
      "browser-agent-tabs.spec.ts",
      "browser-approval-feedback.spec.ts",
      "browser-chrome-mobile-layout.spec.ts",
      "browser-cobrowsing-ui.spec.ts",
      "browser-cursor-overlay.spec.ts",
      "shared-browser-approval-responsive.spec.ts",
      "shared-browser-expanded-safe-area.spec.ts",
      "shared-browser-focused-editable.spec.ts",
      "shared-browser-sessions-responsive.spec.ts",
      "browser-live-proof.spec.ts",
      "browser-recovery.spec.ts",
      "chat-sticky-speaker-clear.spec.ts",
      "conversation-surfaces.spec.ts",
      "suggestion-browser-menus.spec.ts",
      "queue-composer.spec.ts",
      "mobile-sidebar-safe-area.spec.ts",
      "mobile-sidebar-keyboard.spec.ts",
      "mobile-editor-dialogs.spec.ts",
      "mobile-thumb-navigation.spec.ts",
      "notification-preferences.spec.ts",
      "octo-hatchling.spec.ts",
      "organization-rail-reorder.spec.ts",
      "plan-chips.spec.ts",
      "preview-card-responsive.spec.ts",
      "run-failure-block.spec.ts",
      "run-stop-control.spec.ts",
      "studio-history-navigation.spec.ts",
      "settings-history-scroll.spec.ts",
      "segmented-control-responsive.spec.ts",
      "studio-history-controls.spec.ts",
      "thread-spine-surface.spec.ts",
      "turn-activity-line.spec.ts",
      "typing-agent-stack.spec.ts",
    ],
    titles: [
      "agent tabs are badged, listed and taken over in one press at 390px in light mode",
      "agent tabs are badged, listed and taken over in one press at 390px in dark mode",
      "agent tabs are badged, listed and taken over in one press at 1100px in light mode",
      "typing avatar stacks keep status text clear in light on desktop and phones",
      "typing avatar stacks keep status text clear in dark on desktop and phones",
      "Octo's hatchlings sit on Octo's light tile in one ink, clear of its corners at every size",
      "Octo's hatchlings sit on Octo's dark tile in one ink, clear of its corners at every size",
      "on a touch screen nothing you can see in a plan's row sits under Workstreams' or Cancel group's touch targets",
      "on a touch screen a tap anywhere on a plan chip opens its run trace and a long-press opens its menu",
      "with a mouse or keyboard a plan chip's menu button takes its status slot without moving anything",
      "in a job-thread preview no plan chip's focus ring or touch target is cut by the card's clip",
      "Skills import keeps its title and actions reachable across keyboard resize and rotation",
      "Agent editing keeps Save reachable above the keyboard without remounting the draft",
      "conversation views preserve mounted resources, drafts and split size across narrow layouts",
      "expanded Shared docked respects web safe areas",
      "expanded Shared docked respects macOS safe areas",
      "expanded Shared docked respects mobile safe areas",
      "expanded Shared modal respects web safe areas",
      "expanded Shared modal respects macOS safe areas",
      "expanded Shared modal respects mobile safe areas",
      "Shared sessions and saved status stay usable in portrait",
      "Shared sessions and saved status stay usable in short landscape",
      "keeps Unicode remote input out of a previously focused local editor",
      "reveals only a clipped focused editable without changing focus or values",
      "keeps focused sidebar search centered through visual keyboard resize and restores the drawer",
      "Escape returns from the mobile workspace drill-in before dismissing navigation",
      "restores exact visits and transcript positions through Back and Forward at 1280px",
      "restores exact visits and transcript positions through Back and Forward at 390px",
      "collapses mobile sidebar drill-ins before navigating without stale Back loops",
      "preserves rapid destinations, legacy tab clicks, jobs and unloaded deep links",
      "abandons pending old-space conversations while a new space is loading",
      "restores URL-driven settings categories and per-visit scroll with browser Back and Forward",
      "native history controls traverse Router entries with 44px targets and bounded forward state",
      "thumb navigation preserves history, selection and input at 375px",
      "thumb navigation preserves history, selection and input at 390px",
      "thumb navigation preserves history, selection and input at 844px",
      "segmented choices stay compact at narrow mouse widths and support keyboard selection",
      "segmented choices use compact targets on wide fine-pointer screens",
      "segmented choices retain 44px targets on 390px touch screens",
      "segmented choices retain 44px targets on 1280px touch screens",
      "notification settings keep current-channel controls compact and independent on phone",
      "notification settings keep current-channel controls compact and independent on desktop",
      "thread spine notches erase to the surface behind them in light at 390px",
      "thread spine notches erase to the surface behind them in light at 1280px",
      "thread spine notches erase to the surface behind them in dark at 390px",
      "thread spine notches erase to the surface behind them in dark at 1280px",
      "the transcript is fully clear behind the sticky speaker pill at 375px",
      "the transcript is fully clear behind the sticky speaker pill at 1280px",
      "one plain line opens Details by keyboard at 1280px (light)",
      "one plain line opens Details by keyboard at 390px (dark)",
      "gives the line and the step rows a 44px target on a coarse pointer",
      "a failed turn offers its actions by keyboard, in plain words, and is one quiet line while it is tried again, at 390px (dark)",
      "gives the failure block's actions a 44px target on a coarse pointer",
      "a browser prompt wraps under its sentence on a phone and keeps 44px buttons",
      "names the card, the lock and the status for screen readers",
      "opens on a press anywhere on the card and from the keyboard, rings the whole card on focus",
    ],
  },
  "shared-studio": {
    minimumTests: 1,
    files: ["shared-browser-studio-ci.spec.ts"],
    titles: ["signed-in Studio controls Shared Browser, restores its login, and clears project data"],
  },
});

/**
 * Coverage failures for the tests a lane ran, as `{ file, title }` items with
 * spec basenames: too few tests, or a required spec or case that did not run.
 */
export function requiredCoverageFailures(contract, tests) {
  const failures = [];
  const files = new Set(tests.map((test) => test.file));
  const titles = new Set(tests.map((test) => test.title));
  if (tests.length < contract.minimumTests) failures.push("Required tests are missing");
  for (const file of contract.files) {
    if (!files.has(file)) failures.push(`Required spec missing: ${file}`);
  }
  for (const title of contract.titles) {
    if (!titles.has(title)) failures.push(`Required case missing: ${title}`);
  }
  return failures;
}

const isRecord = (value) => value !== null && typeof value === "object" && !Array.isArray(value);

/**
 * A lane that CI runs in parts is complete only when every part passed on its
 * own and the tests of all parts together meet the lane's contract. `receipts`
 * are the parts' required-browser-result.json contents, in any order.
 */
export function combineRequiredBrowserParts(lane, receipts) {
  const contract = Object.hasOwn(REQUIRED_BROWSER_LANES, lane) ? REQUIRED_BROWSER_LANES[lane] : undefined;
  const failures = [];
  if (!contract?.parts) failures.push("Unknown required browser lane, or one that does not run in parts");
  if (!Array.isArray(receipts)) receipts = [];
  const parts = new Set();
  const ids = new Set();
  const tests = [];
  for (const receipt of receipts) {
    const part = isRecord(receipt) ? receipt.part : undefined;
    const valid = isRecord(part) && Number.isSafeInteger(part.current) && part.total === contract?.parts
      && part.current >= 1 && part.current <= part.total;
    if (!isRecord(receipt) || receipt.schemaVersion !== 1 || receipt.lane !== lane || !valid) {
      failures.push("A receipt is not a part of this lane");
      continue;
    }
    if (parts.has(part.current)) failures.push(`Part ${part.current} reported more than once`);
    parts.add(part.current);
    if (receipt.status !== "passed" || !Array.isArray(receipt.failures) || receipt.failures.length
      || !Array.isArray(receipt.tests) || !receipt.tests.length) {
      failures.push(`Part ${part.current} did not pass`);
      continue;
    }
    for (const test of receipt.tests) {
      if (!isRecord(test) || typeof test.id !== "string" || typeof test.file !== "string"
        || typeof test.title !== "string" || test.passed !== true) {
        failures.push(`Part ${part.current} did not pass`);
        continue;
      }
      if (ids.has(test.id)) failures.push("A test ran in more than one part");
      ids.add(test.id);
      tests.push(test);
    }
  }
  for (let current = 1; current <= (contract?.parts ?? 0); current += 1) {
    if (!parts.has(current)) failures.push(`Part ${current} of ${contract.parts} is missing`);
  }
  if (contract) failures.push(...requiredCoverageFailures(contract, tests));
  const unique = [...new Set(failures)];
  return {
    lane: contract ? lane : "unknown",
    status: unique.length ? "failed" : "passed",
    parts: parts.size,
    selected: tests.length,
    failures: unique,
  };
}

export default class RequiredBrowserReporter {
  constructor(options = {}) {
    this.lane = options.lane;
    this.contract = Object.hasOwn(REQUIRED_BROWSER_LANES, this.lane)
      ? REQUIRED_BROWSER_LANES[this.lane] : undefined;
    this.tests = [];
    this.attempts = new Map();
    this.globalErrors = 0;
  }

  onBegin(config, suite) {
    this.config = config;
    this.tests = suite.allTests();
  }

  onTestEnd(test, result) {
    const attempts = this.attempts.get(test.id) ?? [];
    attempts.push({ status: result.status, retry: result.retry });
    this.attempts.set(test.id, attempts);
  }

  onError() {
    // Never copy raw errors, auth values, page content or network payloads to
    // the machine-readable gate receipt. Playwright owns diagnostic artifacts.
    this.globalErrors += 1;
  }

  async onEnd(result) {
    const failures = [];
    if (!this.contract) failures.push("Unknown required browser lane");
    if (!this.config) failures.push("Test discovery did not complete");
    if (result.status !== "passed") failures.push(`Runner status: ${result.status}`);
    if (this.globalErrors) failures.push("Runner reported an infrastructure/global error");
    // Playwright's --shard runs one part of the lane; its config says which.
    const shard = this.config?.shard;
    const part = shard ? { current: shard.current, total: shard.total } : undefined;
    const tests = this.tests.map((test) => {
      const attempts = this.attempts.get(test.id) ?? [];
      const passed = test.expectedStatus === "passed" && attempts.length === 1
        && attempts[0].status === "passed" && attempts[0].retry === 0;
      return {
        id: test.id,
        file: path.basename(test.location.file),
        title: test.title,
        expectedStatus: test.expectedStatus,
        attempts,
        passed,
      };
    });
    if (this.contract && part) {
      // A part proves only its own tests. The lane's contract is checked on
      // all parts' receipts together, so a part of a lane that is not run in
      // exactly that many parts, or an empty part, can never pass.
      if (part.total !== this.contract.parts) failures.push("This lane does not run in that many parts");
      if (!tests.length) failures.push("Required tests are missing");
    } else if (this.contract) {
      failures.push(...requiredCoverageFailures(this.contract, tests));
    }
    if (tests.some((test) => !test.passed)) {
      failures.push("Every selected test must execute and pass once; skips, expected failures and retries are forbidden");
    }
    const summary = {
      schemaVersion: 1,
      lane: this.contract ? this.lane : "unknown",
      ...(part ? { part } : {}),
      status: failures.length ? "failed" : "passed",
      selected: tests.length,
      passed: tests.filter((test) => test.passed).length,
      skipped: tests.filter((test) => test.expectedStatus === "skipped"
        || test.attempts.some((attempt) => attempt.status === "skipped")).length,
      globalErrors: this.globalErrors,
      failures,
      tests,
    };
    try {
      const outputDir = this.config?.projects[0]?.outputDir;
      if (!outputDir) throw new Error("Missing test output directory");
      fs.mkdirSync(outputDir, { recursive: true });
      fs.writeFileSync(path.join(outputDir, "required-browser-result.json"),
        `${JSON.stringify(summary, null, 2)}\n`);
    } catch {
      failures.push("Could not write the required browser result receipt");
      summary.status = "failed";
    }
    const label = part ? `${summary.lane} part ${part.current} of ${part.total}` : summary.lane;
    process.stdout.write(`[required-browser] ${label}: ${summary.passed}/${summary.selected} passed; ${summary.skipped} skipped; ${summary.status}\n`);
    for (const failure of failures) process.stderr.write(`[required-browser] ${failure}\n`);
    return { status: summary.status };
  }
}
