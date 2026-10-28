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
    minimumTests: 53,
    files: [
      "browser-agent-tabs.spec.ts",
      "browser-chrome-mobile-layout.spec.ts",
      "browser-cobrowsing-ui.spec.ts",
      "browser-cursor-overlay.spec.ts",
      "shared-browser-approval-responsive.spec.ts",
      "shared-browser-expanded-safe-area.spec.ts",
      "shared-browser-focused-editable.spec.ts",
      "shared-browser-sessions-responsive.spec.ts",
      "browser-live-proof.spec.ts",
      "conversation-surfaces.spec.ts",
      "queue-composer.spec.ts",
      "mobile-sidebar-safe-area.spec.ts",
      "mobile-sidebar-keyboard.spec.ts",
      "mobile-editor-dialogs.spec.ts",
      "mobile-thumb-navigation.spec.ts",
      "notification-preferences.spec.ts",
      "organization-rail-reorder.spec.ts",
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
      "one plain line opens Details by keyboard at 1280px (light)",
      "one plain line opens Details by keyboard at 390px (dark)",
      "gives the line and the step rows a 44px target on a coarse pointer",
      "a turn the AI never answered offers its actions by keyboard at 390px (dark)",
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
    const files = new Set(this.tests.map((test) => path.basename(test.location.file)));
    const titles = new Set(this.tests.map((test) => test.title));
    if (this.contract) {
      if (this.tests.length < this.contract.minimumTests) failures.push("Required tests are missing");
      for (const file of this.contract.files) {
        if (!files.has(file)) failures.push(`Required spec missing: ${file}`);
      }
      for (const title of this.contract.titles) {
        if (!titles.has(title)) failures.push(`Required case missing: ${title}`);
      }
    }
    const tests = this.tests.map((test) => {
      const attempts = this.attempts.get(test.id) ?? [];
      const passed = test.expectedStatus === "passed" && attempts.length === 1
        && attempts[0].status === "passed" && attempts[0].retry === 0;
      return {
        file: path.basename(test.location.file),
        title: test.title,
        expectedStatus: test.expectedStatus,
        attempts,
        passed,
      };
    });
    if (tests.some((test) => !test.passed)) {
      failures.push("Every selected test must execute and pass once; skips, expected failures and retries are forbidden");
    }
    const summary = {
      schemaVersion: 1,
      lane: this.contract ? this.lane : "unknown",
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
    process.stdout.write(`[required-browser] ${summary.lane}: ${summary.passed}/${summary.selected} passed; ${summary.skipped} skipped; ${summary.status}\n`);
    for (const failure of failures) process.stderr.write(`[required-browser] ${failure}\n`);
    return { status: summary.status };
  }
}
