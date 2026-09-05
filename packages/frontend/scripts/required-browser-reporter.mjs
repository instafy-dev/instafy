import fs from "node:fs";
import path from "node:path";

// Keep a concrete coverage contract: a typo/filter that selects one passing
// test must not turn the required lane green while omitting its main proof.
export const REQUIRED_BROWSER_LANES = Object.freeze({
  personal: {
    minimumTests: 4,
    files: ["electron-personal-browser.spec.ts"],
    titles: [
      "is enabled by default and rejects opening behind the explicit kill switch",
      "persists one local profile across restarts and isolates another profile",
      "keeps real login cookies per user across projects and restarts, then clears only that user",
      "revokes ownership and control when the Studio renderer reloads",
    ],
  },
  "browser-ui": {
    minimumTests: 11,
    files: [
      "browser-chrome-mobile-layout.spec.ts",
      "browser-cursor-overlay.spec.ts",
      "shared-browser-approval-responsive.spec.ts",
      "browser-live-proof.spec.ts",
    ],
    titles: [],
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
