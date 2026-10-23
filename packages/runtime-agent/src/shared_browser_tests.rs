use std::path::PathBuf;
use std::process::{Command as StdCommand, Output};
use std::sync::Arc;
use std::sync::atomic::{AtomicUsize, Ordering as AtomicOrdering};

use serde_json::json;

use super::*;

const SNAPSHOT_ID: &str = "0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef";

fn strings(values: &[&str]) -> Vec<String> {
    values.iter().map(|value| (*value).to_string()).collect()
}

const FAKE_PLAYWRIGHT: &str = r#"
const fs = require("fs");
const mode = process.env.INSTAFY_SHARED_BROWSER_FAKE_MODE || "safe";
// Assembled at run time so the source holds no key-shaped literal.
const CANARY = ["sk", "live", "INSTAFYCANARY0123456789abcdef"].join("_");
const markPath = process.env.INSTAFY_SHARED_BROWSER_FAKE_MARK;
const cdpLogPath = process.env.INSTAFY_SHARED_BROWSER_FAKE_CDP_LOG;
// The loaded document's CDP loader id, kept in a file so it lasts across
// controller processes the way one Chromium document does.
const documentPath = process.env.INSTAFY_SHARED_BROWSER_FAKE_DOCUMENT;
const currentDocument = () => {
  try {
    return fs.readFileSync(documentPath, "utf8").trim() || "DOCUMENT1";
  } catch (_) {
    return "DOCUMENT1";
  }
};
const formButtonTypes = { "form-button": "button", "form-reset": "reset", "form-submit-button": "submit" };
const formInputTypes = { "form-submit-input": "submit", "form-image-input": "image" };
const isFormButton = Object.hasOwn(formButtonTypes, mode);
const hasForm = mode === "form-input" || isFormButton || Object.hasOwn(formInputTypes, mode);
const decoyLooksIdentical = mode === "identical-targets";
const approvalWasConsumed = () => {
  try {
    const state = JSON.parse(fs.readFileSync(
      `${process.env.INSTAFY_SHARED_BROWSER_APPROVAL_DIR}/state.json`,
      "utf8",
    ));
    return Array.isArray(state.consumedApprovalIds) && state.consumedApprovalIds.length > 0;
  } catch (_) {
    return false;
  }
};
// Structural facts as the page-side describer reports them.
const basePolicy = {
  href: "", linkSelf: false, download: false, formActionUrl: "", formName: "",
  formSubmitLabels: "", formHasPassword: false, formPasswordCount: 0, formFieldCount: 0,
  signInIdentifier: false, contentEditable: false, areas: "", menuOpener: false,
  credentialContext: false, row: false, nearMaskedText: false, iconHint: "",
};
const control = (text, extra = {}) => ({
  tag: "button", role: null, ariaLabel: "", labels: "", placeholder: "", inputType: "button",
  text, ...extra,
});
const special = {
  "invite-button": { description: control("Invite member") },
  "generate-key": { description: control("Generate API key") },
  "plain-button": { description: control("Show details") },
  // Script-driven save buttons: no form owner, only the commit word.
  "save-button": { description: control("Speichern") },
  "save-button-en": { description: control("Save changes") },
  "cross-site-link": {
    description: control("Pricing", { tag: "a", inputType: "", href: "https://other.example/pricing" }),
    policy: { href: "https://other.example/pricing", linkSelf: true },
  },
  "export-link": {
    description: control("Export CSV", { tag: "a", inputType: "", href: "https://example.test/reports/export.csv" }),
    policy: { href: "https://example.test/reports/export.csv", linkSelf: true },
  },
  "reveal-key": { description: control("Show"), policy: { credentialContext: true, row: true } },
  "credential-row": {
    description: control("Production key ••••••••", { tag: "tr", inputType: "" }),
    policy: { credentialContext: true, row: true, nearMaskedText: true },
  },
  "sign-in-email": {
    description: control("", {
      tag: "input", inputType: "email", ariaLabel: "Email", labels: "Email", autocomplete: "email",
      formMethod: "post", formAction: "https://example.test/session", formActionText: "form post Sign in",
    }),
    policy: { formHasPassword: true, formPasswordCount: 1, formFieldCount: 2, signInIdentifier: true },
  },
  "file-input": { description: control("", { tag: "input", inputType: "file", ariaLabel: "Receipt" }) },
  "canary-label": { description: control(`Copy ${CANARY}`) },
  "click-error-canary": { description: control("Show details") },
  "no-policy": { description: control("Show details"), policy: null },
  "url-label": {
    description: control(`Open https://github.com/instafy-dev/instafy/pull/615/files?token=${CANARY}`),
  },
};
// "long-label-<n>": an accessible name and a long visible text that differ,
// shifted by n characters so the label cut lands on every position of a
// space and a four-byte character.
if (mode.startsWith("long-label-")) {
  const shift = "x".repeat(Number(mode.slice("long-label-".length)));
  special[mode] = {
    description: control(`${shift}Quarterly ${"team \u{1F600} ".repeat(40)}`, {
      tag: "a", inputType: "", ariaLabel: "Open report", href: "https://example.test/reports/q3",
    }),
    policy: { href: "https://example.test/reports/q3", linkSelf: true },
  };
}
const descriptionFor = (targetId) => ({
  tag: isFormButton || mode === "localized-button" || mode === "icon-button" ? "button" : "input",
  role: mode === "icon-button" ? "button" : null,
  idAttribute:
    mode === "reordered" || (mode === "stale-after-allow" && approvalWasConsumed())
      ? "changed-target"
      : "search",
  ariaLabel:
    mode === "localized-button" ? "Eliminar elemento" :
    mode === "icon-button" ? "" :
    targetId === "decoy-target" && !decoyLooksIdentical ? "Decoy field" : "Search",
  ariaLabelledBy: mode.startsWith("aria-") ? "external-label" : "",
  ariaLabelledByText:
    mode === "aria-delete" ? "Delete account" :
    mode === "aria-sensitive" ? "One time verification code" : "",
  placeholder: mode === "localized-button" || mode === "icon-button" ? "" : "Search",
  nameAttribute: mode === "password-name" ? "password" : "query",
  titleAttribute: null,
  valueAttribute: mode === "delete-value" ? "Delete account" : null,
  href: null,
  inputType: formButtonTypes[mode] || formInputTypes[mode] || "text",
  autocomplete: mode === "credit-card" ? "section-checkout shipping cc-private-token" : "off",
  inputMode: "text",
  formAction: hasForm ? "https://example.test/search" : "",
  formMethod: hasForm ? "get" : "",
  formActionText: hasForm ? "Search form" : "",
  labels: mode === "localized-button" || mode === "icon-button" ? "" : "Search",
  text: mode === "localized-button" ? "Eliminar" : "",
  ...(special[mode]?.description || {}),
  policy: special[mode] && special[mode].policy === null
    ? null
    : { ...basePolicy, ...(special[mode]?.policy || {}) },
});
const signalsFor = () => mode === "secret-screen"
  ? { credentialContext: true, secretField: true, secretCode: false, maskedNearReveal: false }
  : mode === "signals-fail"
    ? null
    : { credentialContext: false, secretField: false, secretCode: false, maskedNearReveal: false };
const bodyTextFor = (currentUrl, targetId) => {
  if (currentUrl.includes("unapproved-secret")) return "Secret destination contents";
  if (targetId === "decoy-target" && !decoyLooksIdentical) return "Decoy page";
  // An about:blank document can hold script-written content; none of it may
  // reach an observation.
  if (currentUrl === "about:blank" || currentUrl.startsWith("chrome://")) {
    return `Script-written blank ${CANARY}`;
  }
  if (mode === "canary-text") return `Order note ${CANARY} for the fixture`;
  if (mode === "secret-screen") return `Production key ${CANARY}`;
  return "Fixture page";
};
let context;
const makePage = (targetId) => {
  let currentUrl = mode === "blank-page"
    ? "about:blank"
    : mode === "blank-fragment"
      ? "about:blank#instafy"
      : mode === "srcdoc-page"
        ? "about:srcdoc"
        : mode === "data-page"
          ? "data:text/html,fixture"
          : mode === "new-tab-page"
            ? "chrome://newtab/"
            : mode === "browser-internal"
              ? "chrome://settings/"
              : targetId === "decoy-target" && !decoyLooksIdentical
                ? "https://decoy.example.test/"
                : "https://example.test/";
  const handle = {
    isVisible: async () => true,
    boundingBox: async () => ({ x: 10, y: 20, width: 120, height: 32 }),
    evaluate: async () => {
      return descriptionFor(targetId);
    },
    click: async () => {
      if (mode === "new-origin-after-click") {
        currentUrl = "https://unapproved-secret.example/hidden?token=must-not-leak";
      }
      if (mode === "click-error-canary") {
        throw new Error(`element <button data-key="${CANARY}"> is not attached to the DOM`);
      }
    },
    focus: async () => {},
    fill: async () => {},
    press: async () => {},
  };
  return {
    targetId,
    context: () => context,
    // Page-side helpers identify themselves by their argument.
    evaluate: async (_fn, arg) => {
      if (arg && arg.kind === "page-policy") return signalsFor();
      if (arg && arg.kind === "withheld-read") return Boolean(markPath && fs.existsSync(markPath));
      if (arg && arg.kind === "withheld-mark") {
        if (markPath) fs.writeFileSync(markPath, "withheld");
        return Boolean(markPath);
      }
      return undefined;
    },
    url: () => currentUrl,
    title: async () => currentUrl.includes("unapproved-secret")
      ? "Secret destination title"
      : currentUrl === "about:blank" || currentUrl.startsWith("chrome://")
        ? "Script-written blank title"
      : targetId === "decoy-target" && !decoyLooksIdentical ? "Decoy" : "Fixture",
    bringToFront: async () => {},
    setDefaultTimeout: () => {},
    goto: async (url) => {
      currentUrl = String(url);
      // A new document drops the page's withheld mark.
      if (markPath) fs.rmSync(markPath, { force: true });
      if (documentPath) fs.writeFileSync(documentPath, `DOCUMENT${Date.now()}`);
    },
    waitForLoadState: async () => {},
    waitForTimeout: async () => {},
    viewportSize: () => ({ width: 800, height: 600 }),
    locator: (selector) => selector === "body"
      ? { innerText: async () => bodyTextFor(currentUrl, targetId) }
      : {
          count: async () => 1,
          nth: () => ({ elementHandle: async () => handle }),
        },
    mouse: { wheel: async () => {} },
    keyboard: { press: async () => {} },
  };
};
const expectedPage = makePage("page-target");
const pages = mode === "multi-target" || mode === "identical-targets"
  ? [makePage("decoy-target"), expectedPage]
  : [expectedPage];
context = {
  pages: () => pages,
  newCDPSession: async (page) => ({
    send: async (method) => method === "Target.getTargetInfo"
      ? { targetInfo: { targetId: page.targetId, type: "page" } }
      : method === "Page.getFrameTree"
        ? { frameTree: { frame: { id: "main", loaderId: currentDocument() } } }
        : {},
    detach: async () => {},
  }),
};
const browser = {
  contexts: () => [context],
  newBrowserCDPSession: async () => ({
    send: async (method, params) => {
      if (cdpLogPath) fs.appendFileSync(cdpLogPath, `${JSON.stringify({ method, params })}\n`);
      return {};
    },
    detach: async () => {},
  }),
  close: async () => {
    if (cdpLogPath) fs.appendFileSync(cdpLogPath, `${JSON.stringify({ method: "close" })}\n`);
  },
};
module.exports = { chromium: { connectOverCDP: async () => browser } };
"#;

/// Runs the embedded controller the way the runtime does: `node -` with the
/// script on stdin.
struct EmbeddedControllerCommand(StdCommand);

impl EmbeddedControllerCommand {
    fn spawn(mut self) -> std::io::Result<std::process::Child> {
        use std::process::Stdio;
        self.0
            .stdin(Stdio::piped())
            .stdout(Stdio::piped())
            .stderr(Stdio::piped());
        let mut child = self.0.spawn()?;
        let mut stdin = child.stdin.take().expect("controller stdin");
        stdin.write_all(embedded_shared_browser_script().as_bytes())?;
        drop(stdin);
        Ok(child)
    }

    fn output(self) -> std::io::Result<Output> {
        self.spawn()?.wait_with_output()
    }
}

struct EmbeddedControllerFixture {
    _tempdir: tempfile::TempDir,
    trusted_root: PathBuf,
    playwright_path: PathBuf,
    hostile_cwd: PathBuf,
    hostile_marker: PathBuf,
    authority_path: PathBuf,
    approval_dir: PathBuf,
    actions_path: PathBuf,
    document_mark: PathBuf,
    document_id: PathBuf,
    cdp_log: PathBuf,
    owner_id: Uuid,
    run_id: Uuid,
    initiator_user_id: Uuid,
}

impl EmbeddedControllerFixture {
    fn new() -> Self {
        let tempdir = tempfile::tempdir().expect("embedded controller tempdir");
        let trusted_root = tempdir.path().join("trusted-node-modules");
        let playwright_path = trusted_root.join("playwright");
        std::fs::create_dir_all(&playwright_path).expect("trusted playwright directory");
        std::fs::write(playwright_path.join("index.js"), FAKE_PLAYWRIGHT)
            .expect("fake trusted playwright module");

        let hostile_cwd = tempdir.path().join("workspace");
        let hostile_playwright = hostile_cwd.join("node_modules/playwright");
        std::fs::create_dir_all(&hostile_playwright).expect("hostile playwright directory");
        let hostile_marker = tempdir.path().join("hostile-module-loaded");
        std::fs::write(
                hostile_playwright.join("index.js"),
                r#"require("fs").writeFileSync(process.env.HOSTILE_MARKER, "loaded"); throw new Error("hostile module loaded");"#,
            )
            .expect("fake hostile playwright module");
        let authority_path = tempdir.path().join("agent-control.json");
        let approval_dir = tempdir.path().join("approvals");
        let actions_path = tempdir.path().join("actions.jsonl");
        let document_mark = tempdir.path().join("document-withheld");
        let document_id = tempdir.path().join("document-id");
        let cdp_log = tempdir.path().join("browser-cdp.jsonl");
        std::fs::create_dir_all(&approval_dir).expect("approval fixture directory");

        Self {
            _tempdir: tempdir,
            trusted_root,
            playwright_path,
            hostile_cwd,
            hostile_marker,
            authority_path,
            approval_dir,
            actions_path,
            document_mark,
            document_id,
            cdp_log,
            owner_id: Uuid::new_v4(),
            run_id: Uuid::new_v4(),
            initiator_user_id: Uuid::new_v4(),
        }
    }

    fn prepare_authority(&self, page_id: &str, approved_origins: &[&str]) {
        if self.actions_path.exists() {
            std::fs::remove_file(&self.actions_path).expect("clear approval fixture actions");
        }
        for file_name in APPROVAL_FIXED_FILES {
            let path = self.approval_dir.join(file_name);
            if path.exists() {
                std::fs::remove_file(path).expect("clear approval fixture file");
            }
        }
        let marker = json!({
            "version": 2,
            "ownerId": self.owner_id,
            "runId": self.run_id,
            "initiatorUserId": self.initiator_user_id,
            "browserPageId": page_id,
            "displayName": "Octo",
            "expiresAtMs": unix_time_millis() + 60_000,
        });
        std::fs::write(
            &self.authority_path,
            serde_json::to_vec(&marker).expect("marker JSON"),
        )
        .expect("write approval fixture marker");
        #[cfg(unix)]
        std::fs::set_permissions(&self.authority_path, std::fs::Permissions::from_mode(0o600))
            .expect("protect approval fixture marker");
        let state = json!({
            "version": 1,
            "ownerId": self.owner_id,
            "runId": self.run_id,
            "initiatorUserId": self.initiator_user_id,
            "browserPageId": page_id,
            "approvedOrigins": approved_origins,
            "consumedApprovalIds": [],
        });
        std::fs::write(
            self.approval_dir.join("state.json"),
            serde_json::to_vec(&state).expect("state JSON"),
        )
        .expect("write approval fixture state");
        #[cfg(unix)]
        std::fs::set_permissions(
            self.approval_dir.join("state.json"),
            std::fs::Permissions::from_mode(0o600),
        )
        .expect("protect approval fixture state");
    }

    fn command_for(
        &self,
        mode: &str,
        page_id: &str,
        method: &str,
        path: &str,
        body: Option<&str>,
    ) -> EmbeddedControllerCommand {
        // Decision-driven runs get a generous window: 250ms flaked on loaded
        // 2-core CI runners (approval file lands, poller misses the deadline).
        // Timeout-behavior tests override with a short window explicitly.
        self.command_for_with_timeout(mode, page_id, method, path, body, "5000")
    }

    fn command_for_with_timeout(
        &self,
        mode: &str,
        page_id: &str,
        method: &str,
        path: &str,
        body: Option<&str>,
        approval_timeout_ms: &str,
    ) -> EmbeddedControllerCommand {
        let mut command = StdCommand::new("node");
        command
            .arg("-")
            .arg(method)
            .arg(path)
            .current_dir(&self.hostile_cwd)
            .env(PLAYWRIGHT_MODULE_PATH_ENV, &self.playwright_path)
            .env(TRUSTED_NODE_MODULES_ROOT_ENV, &self.trusted_root)
            .env(PAGE_ID_ENV, page_id)
            .env(AGENT_CONTROL_FILE_ENV, &self.authority_path)
            .env(APPROVAL_DIR_ENV, &self.approval_dir)
            .env(APPROVAL_TIMEOUT_MS_ENV, approval_timeout_ms)
            .env(ACTIONS_FILE_ENV, &self.actions_path)
            .env("INSTAFY_SHARED_BROWSER_FAKE_MODE", mode)
            .env("INSTAFY_SHARED_BROWSER_FAKE_MARK", &self.document_mark)
            .env("INSTAFY_SHARED_BROWSER_FAKE_DOCUMENT", &self.document_id)
            .env("INSTAFY_SHARED_BROWSER_FAKE_CDP_LOG", &self.cdp_log)
            .env("HOSTILE_MARKER", &self.hostile_marker);
        if let Some(body) = body {
            command.arg(body);
        }
        EmbeddedControllerCommand(command)
    }

    fn run(&self, mode: &str, method: &str, path: &str, body: Option<&str>) -> Output {
        self.run_for_page(mode, "page-target", method, path, body)
    }

    fn run_for_page(
        &self,
        mode: &str,
        page_id: &str,
        method: &str,
        path: &str,
        body: Option<&str>,
    ) -> Output {
        self.prepare_authority(
            page_id,
            &["https://example.test", "https://decoy.example.test"],
        );
        self.command_for(mode, page_id, method, path, body)
            .output()
            .expect("run embedded Shared Browser controller")
    }

    fn run_with_decisions(
        &self,
        mode: &str,
        page_id: &str,
        method: &str,
        request_path: &str,
        body: Option<&str>,
        approved_origins: &[&str],
        decisions: &[&str],
    ) -> (Output, Vec<JsonValue>) {
        self.prepare_authority(page_id, approved_origins);
        self.decide_prepared(
            self.command_for(mode, page_id, method, request_path, body),
            decisions,
        )
    }

    /// Seeds the run's state the way the guard does on an attested browser
    /// host, after `prepare_authority` wrote the marker.
    fn prepare_routine_start(&self, page_id: &str) {
        self.prepare_authority(page_id, &[]);
        write_routine_approval_state(
            &self.approval_dir,
            &self.owner_id.to_string(),
            self.run_id,
            self.initiator_user_id,
            page_id,
        )
        .expect("seed routine start");
    }

    /// Runs `command` against the already prepared authority, answering each
    /// request it publishes with the next of `decisions` (then "deny").
    fn decide_prepared(
        &self,
        command: EmbeddedControllerCommand,
        decisions: &[&str],
    ) -> (Output, Vec<JsonValue>) {
        use std::time::{Duration, Instant};

        let mut child = command
            .spawn()
            .expect("spawn embedded Shared Browser controller");
        let started = Instant::now();
        let mut observed = Vec::new();
        let mut last_approval_id = String::new();
        while child
            .try_wait()
            .expect("poll embedded controller")
            .is_none()
        {
            if let Some(request) = self.pending_request()
                && request["approvalId"].as_str().unwrap_or_default() != last_approval_id
            {
                let decision = decisions.get(observed.len()).copied().unwrap_or("deny");
                self.answer(&request, decision);
                last_approval_id = request["approvalId"]
                    .as_str()
                    .unwrap_or_default()
                    .to_string();
                observed.push(request);
            }
            assert!(
                started.elapsed() < Duration::from_secs(5),
                "embedded approval fixture timed out"
            );
            std::thread::sleep(Duration::from_millis(5));
        }
        (
            child
                .wait_with_output()
                .expect("collect embedded controller output"),
            observed,
        )
    }

    fn pending_request(&self) -> Option<JsonValue> {
        let raw = std::fs::read(self.approval_dir.join("request.json")).ok()?;
        let request = serde_json::from_slice::<JsonValue>(&raw).ok()?;
        request["approvalId"]
            .as_str()
            .is_some_and(|id| !id.is_empty())
            .then_some(request)
    }

    /// Writes the initiating user's decision the way origin does.
    fn answer(&self, request: &JsonValue, decision: &str) {
        let response = json!({
            "version": 1,
            "approvalId": request["approvalId"],
            "requestFingerprint": request["requestFingerprint"],
            "decision": decision,
            "decidedByUserId": self.initiator_user_id,
            "decidedAtMs": unix_time_millis(),
            "expiresAtMs": request["expiresAtMs"],
        });
        let decision_path = self.approval_dir.join("decision.json");
        let decision_temp_path = self.approval_dir.join(".instafy-approval-fixture-decision");
        let mut options = OpenOptions::new();
        options.write(true).create_new(true);
        #[cfg(unix)]
        options.mode(0o600);
        let mut file = options
            .open(&decision_temp_path)
            .expect("create approval fixture decision");
        file.write_all(&serde_json::to_vec(&response).expect("decision JSON"))
            .expect("write approval fixture decision");
        file.sync_all().expect("sync approval fixture decision");
        drop(file);
        #[cfg(unix)]
        std::fs::set_permissions(&decision_temp_path, std::fs::Permissions::from_mode(0o600))
            .expect("protect approval fixture decision");
        std::fs::rename(&decision_temp_path, &decision_path)
            .expect("publish approval fixture decision");
    }

    fn snapshot_id(&self, mode: &str) -> String {
        let output = self.run(mode, "GET", "/v1/snapshot", None);
        assert!(
            output.status.success(),
            "snapshot failed: {}",
            String::from_utf8_lossy(&output.stderr)
        );
        let payload: JsonValue =
            serde_json::from_slice(&output.stdout).expect("snapshot JSON response");
        payload["snapshotId"]
            .as_str()
            .expect("snapshot id")
            .to_string()
    }
}

#[test]
fn parses_each_supported_high_level_request() {
    for (method, path, body) in [
        ("GET", "/v1/status", None),
        ("GET", "/v1/snapshot", None),
        (
            "POST",
            "/v1/navigate",
            Some(r#"{"url":"https://example.com"}"#),
        ),
        (
            "POST",
            "/v1/click",
            Some(
                r#"{"index":3,"snapshotId":"0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef"}"#,
            ),
        ),
        (
            "POST",
            "/v1/type",
            Some(
                r#"{"index":2,"snapshotId":"0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef","text":"hello"}"#,
            ),
        ),
        (
            "POST",
            "/v1/press",
            Some(
                r#"{"index":2,"snapshotId":"0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef","key":"Escape"}"#,
            ),
        ),
        ("POST", "/v1/scroll", Some(r#"{"x":0,"y":720}"#)),
    ] {
        let mut args = vec!["request", method, path];
        if let Some(body) = body {
            args.push(body);
        }
        let parsed = parse_request_args(&strings(&args)).expect("supported request");
        assert_eq!(parsed.path, path);
    }
}

#[test]
fn rejects_arbitrary_paths_methods_and_malformed_bodies() {
    assert!(parse_request_args(&strings(&["request", "DELETE", "/v1/status"])).is_err());
    assert!(parse_request_args(&strings(&["request", "GET", "https://example.com"])).is_err());
    assert!(parse_request_args(&strings(&["request", "POST", "/v1/navigate", "nope"])).is_err());
    assert!(parse_request_args(&strings(&["request", "POST", "/v1/unknown", "{}"])).is_err());
    assert!(
        parse_request_args(&strings(&[
            "request",
            "POST",
            "/v1/navigate",
            r#"{"url":"https://user:secret@example.com"}"#,
        ]))
        .is_err()
    );
    assert!(
        parse_request_args(&strings(&[
            "request",
            "POST",
            "/v1/press",
            r#"{"key":"Delete"}"#,
        ]))
        .is_err()
    );
    assert!(
        parse_request_args(&strings(&[
            "request",
            "POST",
            "/v1/navigate",
            r#"{"url":"https://example.com","evaluate":"process.env"}"#,
        ]))
        .is_err()
    );
    assert!(
        parse_request_args(&strings(&[
            "request",
            "POST",
            "/v1/press",
            r#"{"key":"Control+L"}"#,
        ]))
        .is_err()
    );
    assert!(
        parse_request_args(&strings(&[
            "request",
            "POST",
            "/v1/click",
            r#"{"index":1,"selector":"button"}"#,
        ]))
        .is_err()
    );
    assert!(
            parse_request_args(&strings(&[
                "request",
                "POST",
                "/v1/click",
                r#"{"index":1,"snapshotId":"0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef","selector":"button"}"#,
            ]))
            .is_err()
        );
    assert!(
        parse_request_args(&strings(&[
            "request",
            "POST",
            "/v1/click",
            r#"{"index":1,"snapshotId":"stale"}"#,
        ]))
        .is_err()
    );
}

#[test]
fn detects_only_explicit_shared_browser_transport_metadata() {
    assert!(payload_requests_shared_browser(&json!({
        "metadata": { "browserTransport": "shared" }
    })));
    assert!(payload_requests_shared_browser(&json!({
        "metadata": { "browser_transport": "SHARED" }
    })));
    assert!(!payload_requests_shared_browser(&json!({
        "metadata": { "browserTransport": "desktop-personal" }
    })));
    assert!(!payload_requests_shared_browser(&json!({})));
}

#[test]
fn shared_browser_payload_requires_exact_consent_protocol_version() {
    assert_eq!(
        consent_version_from_payload(&json!({
            "metadata": {
                "browserTransport": "shared",
                "browserConsentVersion": 1,
            }
        }))
        .expect("current consent protocol"),
        1
    );
    for metadata in [
        json!({ "browserTransport": "shared" }),
        json!({ "browserTransport": "shared", "browserConsentVersion": true }),
        json!({ "browserTransport": "shared", "browserConsentVersion": 0 }),
        json!({ "browserTransport": "shared", "browserConsentVersion": 2 }),
        json!({
            "browserTransport": "shared",
            "browserConsentVersion": 1,
            "browser_consent_version": 2,
        }),
    ] {
        assert!(
            consent_version_from_payload(&json!({ "metadata": metadata })).is_err(),
            "invalid consent metadata was accepted"
        );
    }
}

#[test]
fn shared_jobs_require_one_bounded_ui_selected_cdp_target() {
    assert_eq!(
        page_id_from_payload(&json!({
            "metadata": {
                "browserTransport": "shared",
                "browserPageId": " PAGE_target-1 "
            }
        }))
        .expect("valid browser page target"),
        "PAGE_target-1"
    );
    for payload in [
        json!({ "metadata": { "browserTransport": "shared" } }),
        json!({ "metadata": { "browserTransport": "shared", "browserPageId": "" } }),
        json!({ "metadata": { "browserTransport": "shared", "browserPageId": "page/other" } }),
        json!({ "metadata": { "browserTransport": "shared", "browserPageId": "x".repeat(257) } }),
    ] {
        assert!(page_id_from_payload(&payload).is_err());
    }
}

#[test]
fn shared_jobs_require_the_controller_authenticated_initiator_user() {
    let user_id = Uuid::new_v4();
    assert_eq!(
        initiator_user_id_from_payload(&json!({ "user_id": user_id.to_string() }))
            .expect("authenticated initiator"),
        user_id
    );
    for payload in [
        json!({}),
        json!({ "user_id": "" }),
        json!({ "user_id": "not-a-user" }),
        json!({ "user_id": 42 }),
    ] {
        assert!(initiator_user_id_from_payload(&payload).is_err());
    }
}

#[test]
fn controller_is_gated_to_browser_session_runtimes() {
    assert!(browser_session_enabled(Some("true")));
    assert!(browser_session_enabled(Some("1")));
    assert!(!browser_session_enabled(Some("false")));
    assert!(!browser_session_enabled(None));
}

#[test]
fn agent_control_marker_contains_only_bounded_runtime_authority() {
    let directory = tempfile::tempdir().expect("marker tempdir");
    let path = directory.path().join("agent-control.json");
    let owner_id = Uuid::new_v4();
    let run_id = Uuid::new_v4();
    let initiator_user_id = Uuid::new_v4();
    write_agent_control_marker(
        &path,
        &owner_id.to_string(),
        run_id,
        initiator_user_id,
        "page-target",
        "Octo",
    )
    .expect("write marker");
    let value: JsonValue =
        serde_json::from_slice(&std::fs::read(&path).expect("read marker")).expect("marker json");

    assert_eq!(value["version"], 2);
    assert_eq!(value["ownerId"], owner_id.to_string());
    assert_eq!(value["runId"], run_id.to_string());
    assert_eq!(value["initiatorUserId"], initiator_user_id.to_string());
    assert_eq!(value["browserPageId"], "page-target");
    assert_eq!(value["displayName"], "Octo");
    assert!(value["expiresAtMs"].as_u64().is_some());
    let keys = value
        .as_object()
        .expect("marker object")
        .keys()
        .map(String::as_str)
        .collect::<std::collections::HashSet<_>>();
    assert_eq!(
        keys,
        std::collections::HashSet::from([
            "version",
            "ownerId",
            "runId",
            "initiatorUserId",
            "browserPageId",
            "displayName",
            "expiresAtMs",
        ])
    );
    #[cfg(unix)]
    {
        assert_eq!(
            std::fs::metadata(directory.path())
                .expect("marker directory metadata")
                .permissions()
                .mode()
                & 0o777,
            0o700
        );
        assert_eq!(
            std::fs::metadata(&path)
                .expect("marker metadata")
                .permissions()
                .mode()
                & 0o777,
            0o600
        );
    }
}

#[test]
fn agent_control_marker_remove_failure_is_reported_and_preserves_authority() {
    let directory = tempfile::tempdir().expect("marker tempdir");
    let path = directory.path().join("agent-control.json");
    let owner_id = Uuid::new_v4().to_string();
    let run_id = Uuid::new_v4();
    let initiator_user_id = Uuid::new_v4();
    write_agent_control_marker(
        &path,
        &owner_id,
        run_id,
        initiator_user_id,
        "page-target",
        "Octo",
    )
    .expect("write marker");

    let error = remove_owned_agent_control_marker_with(
        &path,
        &owner_id,
        run_id,
        initiator_user_id,
        "page-target",
        |_| {
            Err(std::io::Error::new(
                std::io::ErrorKind::PermissionDenied,
                "injected remove failure",
            ))
        },
    )
    .expect_err("remove failure must not count as released authority");

    assert!(error.to_string().contains("failed to remove"));
    assert!(path.is_file(), "failed release must preserve the marker");
}

#[tokio::test]
async fn agent_control_guard_drop_removes_its_owned_marker() {
    let directory = tempfile::tempdir().expect("marker tempdir");
    let path = directory.path().join("agent-control.json");
    let cancel_signal = JobCancelSignal::new();
    let guard = SharedBrowserAgentControlGuard::acquire_with_path(
        path.clone(),
        directory.path().join("approvals"),
        ApprovalStart::Ask,
        Uuid::new_v4(),
        Uuid::new_v4(),
        "page-target",
        "Octo",
        cancel_signal.clone(),
        Duration::from_secs(60),
    )
    .expect("acquire marker");

    assert!(path.is_file());
    assert!(!cancel_signal.is_canceled());
    cancel_signal.confirm_shared_browser_shutdown();
    drop(guard);
    assert!(!path.exists());
}

#[tokio::test]
async fn confirmed_guard_drop_recycles_when_marker_cannot_be_verified() {
    RUNTIME_RECYCLE_REQUESTED.store(false, Ordering::SeqCst);
    let directory = tempfile::tempdir().expect("marker tempdir");
    let path = directory.path().join("agent-control.json");
    let cancel_signal = JobCancelSignal::new();
    let guard = SharedBrowserAgentControlGuard::acquire_with_path(
        path.clone(),
        directory.path().join("approvals"),
        ApprovalStart::Ask,
        Uuid::new_v4(),
        Uuid::new_v4(),
        "page-target",
        "Octo",
        cancel_signal.clone(),
        Duration::from_secs(60),
    )
    .expect("acquire marker");
    std::fs::write(&path, b"not-json").expect("corrupt marker");

    cancel_signal.confirm_shared_browser_shutdown();
    drop(guard);

    assert!(
        path.is_file(),
        "unverified authority must remain fail-closed"
    );
    assert!(RUNTIME_RECYCLE_REQUESTED.load(Ordering::SeqCst));
}

#[tokio::test]
async fn confirmed_guard_drop_recycles_when_approval_cleanup_is_not_bounded() {
    RUNTIME_RECYCLE_REQUESTED.store(false, Ordering::SeqCst);
    let directory = tempfile::tempdir().expect("marker tempdir");
    let path = directory.path().join("agent-control.json");
    let approval_dir = directory.path().join("approvals");
    let cancel_signal = JobCancelSignal::new();
    let guard = SharedBrowserAgentControlGuard::acquire_with_path(
        path.clone(),
        approval_dir.clone(),
        ApprovalStart::Ask,
        Uuid::new_v4(),
        Uuid::new_v4(),
        "page-target",
        "Octo",
        cancel_signal.clone(),
        Duration::from_secs(60),
    )
    .expect("acquire marker");
    std::fs::write(approval_dir.join("unexpected"), b"hostile")
        .expect("write unsupported approval entry");

    cancel_signal.confirm_shared_browser_shutdown();
    drop(guard);

    assert!(path.is_file(), "cleanup failure must preserve authority");
    assert!(RUNTIME_RECYCLE_REQUESTED.load(Ordering::SeqCst));
}

#[tokio::test]
async fn agent_control_heartbeat_failure_cancels_the_browser_turn() {
    let directory = tempfile::tempdir().expect("marker tempdir");
    let path = directory.path().join("agent-control.json");
    let cancel_signal = JobCancelSignal::new();
    let guard = SharedBrowserAgentControlGuard::acquire_with_path(
        path.clone(),
        directory.path().join("approvals"),
        ApprovalStart::Ask,
        Uuid::new_v4(),
        Uuid::new_v4(),
        "page-target",
        "Octo",
        cancel_signal.clone(),
        Duration::from_millis(10),
    )
    .expect("acquire marker");

    // Atomic refresh writes use this owner-specific temporary path. A
    // directory collision deterministically makes every refresh fail while
    // leaving the last valid authority marker readable.
    let heartbeat_temp_path = path.with_extension(format!("{}.tmp", guard.owner_id));
    std::fs::create_dir(&heartbeat_temp_path).expect("block heartbeat temp path");

    tokio::time::timeout(Duration::from_secs(1), cancel_signal.cancelled())
        .await
        .expect("heartbeat failure should cancel the turn");
    assert!(cancel_signal.is_canceled());
    assert!(path.is_file(), "last valid marker remains during teardown");

    cancel_signal.confirm_shared_browser_shutdown();
    drop(guard);
    assert!(!path.exists());
}

#[tokio::test]
async fn unconfirmed_guard_drop_preserves_marker_and_requests_runtime_recycle() {
    RUNTIME_RECYCLE_REQUESTED.store(false, Ordering::SeqCst);
    let directory = tempfile::tempdir().expect("marker tempdir");
    let path = directory.path().join("agent-control.json");
    let guard = SharedBrowserAgentControlGuard::acquire_with_path(
        path.clone(),
        directory.path().join("approvals"),
        ApprovalStart::Ask,
        Uuid::new_v4(),
        Uuid::new_v4(),
        "page-target",
        "Octo",
        JobCancelSignal::new(),
        Duration::from_secs(60),
    )
    .expect("acquire marker");

    drop(guard);

    assert!(
        path.is_file(),
        "unconfirmed authority must remain fail-closed"
    );
    assert!(RUNTIME_RECYCLE_REQUESTED.load(Ordering::SeqCst));
}

#[tokio::test]
async fn a_lazy_browser_host_is_poisoned_instead_of_recycling_the_runtime() {
    use crate::browser_host::mode::{LazyMode, force_lazy_mode_for_tests};
    use crate::browser_host::{BrowserHost, HostConfig, install_host_for_tests};
    use origin_http_server::browser_host::BrowserHostState;

    let _lazy = force_lazy_mode_for_tests(Some(LazyMode { persist: true }));
    let directory = tempfile::tempdir().expect("marker tempdir");
    let host = BrowserHost::spawn(HostConfig::inert_for_tests(directory.path()));
    let _installed = install_host_for_tests(host.clone());
    let path = directory.path().join("agent-control.json");
    let guard = SharedBrowserAgentControlGuard::acquire_with_path(
        path.clone(),
        directory.path().join("approvals"),
        ApprovalStart::Ask,
        Uuid::new_v4(),
        Uuid::new_v4(),
        "page-target",
        "Octo",
        JobCancelSignal::new(),
        Duration::from_secs(60),
    )
    .expect("acquire marker");

    drop(guard);

    assert!(
        path.is_file(),
        "unconfirmed authority must remain fail-closed"
    );
    assert_eq!(host.snapshot().state, BrowserHostState::Poisoned);
    assert!(host.request_start("user").is_err());
}

#[tokio::test]
async fn caller_abort_preserves_marker_and_requests_runtime_recycle() {
    RUNTIME_RECYCLE_REQUESTED.store(false, Ordering::SeqCst);
    let directory = tempfile::tempdir().expect("marker tempdir");
    let path = directory.path().join("agent-control.json");
    let path_for_task = path.clone();
    let approval_dir_for_task = directory.path().join("approvals");
    let (started_tx, started_rx) = tokio::sync::oneshot::channel();
    let task = tokio::spawn(async move {
        let _guard = SharedBrowserAgentControlGuard::acquire_with_path(
            path_for_task,
            approval_dir_for_task,
            ApprovalStart::Ask,
            Uuid::new_v4(),
            Uuid::new_v4(),
            "page-target",
            "Octo",
            JobCancelSignal::new(),
            Duration::from_secs(60),
        )
        .expect("acquire marker");
        let _ = started_tx.send(());
        std::future::pending::<()>().await;
    });
    started_rx.await.expect("guard task should start");

    task.abort();
    let error = task.await.expect_err("guard task should be cancelled");

    assert!(error.is_cancelled());
    assert!(path.is_file());
    assert!(RUNTIME_RECYCLE_REQUESTED.load(Ordering::SeqCst));
}

#[test]
fn runtime_startup_clears_only_a_leftover_agent_control_marker() {
    let directory = tempfile::tempdir().expect("marker tempdir");
    let path = directory.path().join("agent-control.json");
    std::fs::write(&path, b"leftover").expect("write leftover marker");

    clear_stale_agent_control_marker(&path).expect("clear leftover marker");
    assert!(!path.exists());
    clear_stale_agent_control_marker(&path).expect("missing marker is already clear");

    std::fs::create_dir(&path).expect("create non-file marker path");
    assert!(clear_stale_agent_control_marker(&path).is_err());
}

#[test]
fn a_lazy_browser_host_clears_a_leftover_marker_at_startup() {
    use crate::browser_host::mode::{LazyMode, force_lazy_mode_for_tests};
    {
        let _off = force_lazy_mode_for_tests(None);
        assert!(!runtime_runs_shared_browser_turns());
    }
    let _lazy = force_lazy_mode_for_tests(Some(LazyMode { persist: true }));
    assert!(runtime_runs_shared_browser_turns());

    let directory = tempfile::tempdir().expect("startup tempdir");
    let marker_path = directory.path().join("agent-control.json");
    let approval_path = directory.path().join("approvals");
    std::fs::write(&marker_path, b"leftover").expect("write leftover marker");
    clear_stale_agent_control_marker_on_startup_for_mode(
        runtime_runs_shared_browser_turns(),
        &marker_path,
        &approval_path,
    )
    .expect("clear leftover authority");
    assert!(!marker_path.exists());
    assert!(approval_path.is_dir());
}

#[test]
fn non_browser_runtime_startup_does_not_touch_shared_browser_storage() {
    let directory = tempfile::tempdir().expect("startup tempdir");
    let marker_path = directory.path().join("agent-control.json");
    let approval_path = directory.path().join("approvals-must-remain-a-file");
    std::fs::write(&marker_path, b"unrelated marker").expect("write marker sentinel");
    std::fs::write(&approval_path, b"unrelated approval sentinel")
        .expect("write approval sentinel");

    clear_stale_agent_control_marker_on_startup_for_mode(false, &marker_path, &approval_path)
        .expect("non-browser startup must not initialize Shared Browser storage");

    assert_eq!(
        std::fs::read(&marker_path).expect("marker sentinel remains"),
        b"unrelated marker"
    );
    assert_eq!(
        std::fs::read(&approval_path).expect("approval sentinel remains"),
        b"unrelated approval sentinel"
    );
}

#[test]
fn runtime_approval_directory_is_fixed_protected_and_cleaned() {
    let directory = tempfile::tempdir().expect("approval tempdir");
    let approval_dir = directory.path().join("approvals");
    std::fs::create_dir_all(&approval_dir).expect("create approvals");
    for file_name in APPROVAL_FIXED_FILES {
        std::fs::write(approval_dir.join(file_name), b"stale").expect("write stale approval file");
    }
    std::fs::write(
        approval_dir.join(".instafy-approval-leftover"),
        b"stale temp",
    )
    .expect("write stale approval temp");

    prepare_clean_approval_directory(&approval_dir).expect("clean approval directory");
    assert_eq!(
        std::fs::read_dir(&approval_dir)
            .expect("read cleaned approval directory")
            .count(),
        0
    );
    #[cfg(unix)]
    assert_eq!(
        std::fs::metadata(&approval_dir)
            .expect("approval directory metadata")
            .permissions()
            .mode()
            & 0o777,
        0o700
    );

    std::fs::write(approval_dir.join("unbounded-name"), b"no")
        .expect("write unsupported approval file");
    assert!(prepare_clean_approval_directory(&approval_dir).is_err());
}

#[cfg(unix)]
#[test]
fn runtime_approval_storage_rejects_directory_and_file_symlinks() {
    use std::os::unix::fs::symlink;

    let directory = tempfile::tempdir().expect("approval symlink tempdir");
    let real_approval_dir = directory.path().join("real-approvals");
    std::fs::create_dir_all(&real_approval_dir).expect("real approval directory");
    let linked_approval_dir = directory.path().join("linked-approvals");
    symlink(&real_approval_dir, &linked_approval_dir).expect("approval directory symlink");
    assert!(prepare_clean_approval_directory(&linked_approval_dir).is_err());

    let outside = directory.path().join("outside-request");
    std::fs::write(&outside, b"must remain untouched").expect("outside approval target");
    symlink(&outside, real_approval_dir.join("request.json")).expect("approval request symlink");
    assert!(prepare_clean_approval_directory(&real_approval_dir).is_err());
    assert_eq!(
        std::fs::read(&outside).expect("outside approval target remains"),
        b"must remain untouched"
    );
}

#[test]
fn agent_control_display_name_is_utf8_safe_and_bounded() {
    assert_eq!(
        normalized_agent_control_display_name("  Octo   Agent  "),
        "Octo Agent"
    );
    assert_eq!(normalized_agent_control_display_name("   "), "Assistant");
    let bounded = normalized_agent_control_display_name(&"å".repeat(80));
    assert!(bounded.len() <= AGENT_CONTROL_DISPLAY_NAME_MAX_BYTES);
    assert!(bounded.is_char_boundary(bounded.len()));
}

#[test]
fn embedded_controller_owns_action_telemetry() {
    assert!(SHARED_BROWSER_SCRIPT.contains("connectOverCDP"));
    assert!(SHARED_BROWSER_SCRIPT.contains("INSTAFY_BROWSER_ACTIONS_FILE"));
    assert!(SHARED_BROWSER_SCRIPT.contains("type: \"click\""));
    assert!(SHARED_BROWSER_SCRIPT.contains("type: \"nav_result\""));
}

#[test]
fn embedded_controller_binds_actions_to_a_fresh_snapshot_and_raw_target_metadata() {
    assert!(SHARED_BROWSER_SCRIPT.contains("snapshotId"));
    assert!(SHARED_BROWSER_SCRIPT.contains("snapshotFingerprint"));
    assert!(SHARED_BROWSER_SCRIPT.contains("elementHandle"));
    assert!(!SHARED_BROWSER_SCRIPT.contains("body.selector"));
    for raw_field in [
        "idAttribute",
        "nameAttribute",
        "ariaLabel",
        "ariaLabelledBy",
        "ariaLabelledByText",
        "placeholder",
        "titleAttribute",
        "valueAttribute",
        "labels",
        "text",
        "inputMode",
        "autocomplete",
        "formActionText",
    ] {
        assert!(
            SHARED_BROWSER_SCRIPT.contains(raw_field),
            "missing safety field {raw_field}"
        );
    }
    assert!(SHARED_BROWSER_SCRIPT.contains("ownerDocument?.getElementById"));
}

#[test]
fn embedded_controller_loads_only_the_image_installed_playwright_package() {
    assert!(!SHARED_BROWSER_SCRIPT.contains("require(\"playwright\")"));
    assert!(SHARED_BROWSER_SCRIPT.contains("INSTAFY_SHARED_BROWSER_PLAYWRIGHT_PATH"));
    assert!(SHARED_BROWSER_SCRIPT.contains("path.relative(trustedRoot, resolvedModule)"));
    assert!(Path::new(DEFAULT_SHARED_BROWSER_NODE_BINARY).is_absolute());
}

#[test]
fn the_controller_runs_only_an_allowed_node_binary() {
    assert_eq!(shared_browser_node_binary_from(None), "/usr/bin/node");
    assert_eq!(
        shared_browser_node_binary_from(Some("/opt/instafy/browser-host/bin/node")),
        "/opt/instafy/browser-host/bin/node"
    );
    for refused in [
        "",
        "node",
        "/workspace/node",
        "/usr/local/bin/node",
        "/opt/instafy/browser-host/bin/node/../../../../workspace/node",
    ] {
        assert_eq!(
            shared_browser_node_binary_from(Some(refused)),
            "/usr/bin/node",
            "{refused}"
        );
    }
    for allowed in ALLOWED_SHARED_BROWSER_NODE_BINARIES {
        assert!(Path::new(allowed).is_absolute());
    }
}

#[test]
fn embedded_controller_ignores_project_playwright_and_rejects_stale_snapshots() {
    let fixture = EmbeddedControllerFixture::new();
    let snapshot_id = fixture.snapshot_id("safe");
    assert!(
        !fixture.hostile_marker.exists(),
        "project-controlled Playwright module was loaded"
    );

    let body = json!({ "index": 0, "snapshotId": snapshot_id }).to_string();
    let output = fixture.run("reordered", "POST", "/v1/click", Some(&body));
    assert!(!output.status.success());
    assert!(
        String::from_utf8_lossy(&output.stderr).contains("snapshot is stale"),
        "unexpected stale-target error: {}",
        String::from_utf8_lossy(&output.stderr)
    );
    assert!(!fixture.hostile_marker.exists());
}

#[test]
fn embedded_controller_uses_only_the_job_bound_cdp_target() {
    let fixture = EmbeddedControllerFixture::new();
    let output = fixture.run("multi-target", "GET", "/v1/snapshot", None);
    assert!(
        output.status.success(),
        "bound snapshot failed: {}",
        String::from_utf8_lossy(&output.stderr)
    );
    let payload: JsonValue = serde_json::from_slice(&output.stdout).expect("bound snapshot JSON");
    assert_eq!(payload["browserPageId"], "page-target");
    assert_eq!(payload["url"], "https://example.test/");
    assert_eq!(payload["interactiveElements"][0]["label"], "Search");

    let first = fixture.run_for_page(
        "identical-targets",
        "page-target",
        "GET",
        "/v1/snapshot",
        None,
    );
    let second = fixture.run_for_page(
        "identical-targets",
        "decoy-target",
        "GET",
        "/v1/snapshot",
        None,
    );
    assert!(first.status.success() && second.status.success());
    let first_payload: JsonValue =
        serde_json::from_slice(&first.stdout).expect("first target snapshot");
    let second_payload: JsonValue =
        serde_json::from_slice(&second.stdout).expect("second target snapshot");
    assert_ne!(first_payload["snapshotId"], second_payload["snapshotId"]);

    let missing = fixture.run_for_page(
        "multi-target",
        "missing-target",
        "GET",
        "/v1/snapshot",
        None,
    );
    assert!(!missing.status.success());
    assert!(
        String::from_utf8_lossy(&missing.stderr)
            .contains("selected page missing-target is unavailable"),
        "unexpected missing-target error: {}",
        String::from_utf8_lossy(&missing.stderr)
    );
}

#[test]
fn embedded_controller_hard_blocks_hidden_sensitive_fields() {
    for mode in ["password-name", "credit-card", "aria-sensitive"] {
        let fixture = EmbeddedControllerFixture::new();
        let snapshot_id = fixture.snapshot_id(mode);
        let body = json!({
            "index": 0,
            "snapshotId": snapshot_id,
            "text": "must not be typed"
        })
        .to_string();
        let output = fixture.run(mode, "POST", "/v1/type", Some(&body));
        assert!(
            !output.status.success(),
            "sensitive mode {mode} was accepted"
        );
        assert!(
            String::from_utf8_lossy(&output.stderr).contains("refuses to type"),
            "unexpected sensitive-field error for {mode}: {}",
            String::from_utf8_lossy(&output.stderr)
        );
    }
}

#[test]
fn localized_and_icon_only_controls_require_allow_once_independent_of_label() {
    for mode in ["localized-button", "icon-button"] {
        let fixture = EmbeddedControllerFixture::new();
        let snapshot_id = fixture.snapshot_id(mode);
        let body = json!({ "index": 0, "snapshotId": snapshot_id }).to_string();
        let (output, requests) = fixture.run_with_decisions(
            mode,
            "page-target",
            "POST",
            "/v1/click",
            Some(&body),
            &["https://example.test"],
            &["allow_once"],
        );
        assert!(
            output.status.success(),
            "approved {mode} control failed: {}",
            String::from_utf8_lossy(&output.stderr)
        );
        assert_eq!(requests.len(), 1);
        assert_eq!(requests[0]["kind"], "action");
        assert_eq!(requests[0]["operation"], "click");
        assert_eq!(requests[0]["snapshotId"], snapshot_id);
        assert_eq!(
            requests[0]
                .as_object()
                .expect("approval request object")
                .keys()
                .map(String::as_str)
                .collect::<std::collections::HashSet<_>>(),
            std::collections::HashSet::from([
                "version",
                "approvalId",
                "kind",
                "ownerId",
                "runId",
                "initiatorUserId",
                "browserPageId",
                "operation",
                "sourceOrigin",
                "destinationOrigin",
                "destinationFingerprint",
                "snapshotId",
                "targetFingerprint",
                "payloadFingerprint",
                "requestedAtMs",
                "expiresAtMs",
                "requestFingerprint",
                "display",
            ])
        );
        assert!(valid_snapshot_id(
            requests[0]["targetFingerprint"]
                .as_str()
                .expect("target fingerprint")
        ));
        assert_eq!(
            requests[0]["initiatorUserId"],
            fixture.initiator_user_id.to_string()
        );
    }
}

#[test]
fn unchanged_page_snapshots_cannot_be_reused_after_a_new_run_or_control_lease() {
    for rotate_owner in [false, true] {
        let mut fixture = EmbeddedControllerFixture::new();
        let old_snapshot = fixture.snapshot_id("safe");
        if rotate_owner {
            fixture.owner_id = Uuid::new_v4();
        } else {
            fixture.run_id = Uuid::new_v4();
        }
        let stale_body = json!({"index": 0, "snapshotId": old_snapshot});
        let stale = fixture.run("safe", "POST", "/v1/click", Some(&stale_body.to_string()));
        assert!(!stale.status.success());
        assert!(String::from_utf8_lossy(&stale.stderr).contains("snapshot is stale"));
        let fresh_snapshot = fixture.snapshot_id("safe");
        assert_ne!(fresh_snapshot, old_snapshot);
        let fresh_body = json!({"index": 0, "snapshotId": fresh_snapshot});
        let (fresh, requests) = fixture.run_with_decisions(
            "safe",
            "page-target",
            "POST",
            "/v1/click",
            Some(&fresh_body.to_string()),
            &["https://example.test"],
            &["allow_once"],
        );
        assert!(
            fresh.status.success(),
            "{}",
            String::from_utf8_lossy(&fresh.stderr)
        );
        assert_eq!(requests.len(), 1);
        assert_eq!(requests[0]["kind"], "action");
    }
}

#[test]
fn explicit_routine_origin_grant_covers_new_sites_and_ordinary_actions_for_only_this_run() {
    let fixture = EmbeddedControllerFixture::new();
    let (snapshot, requests) = fixture.run_with_decisions(
        "safe",
        "page-target",
        "GET",
        "/v1/snapshot",
        None,
        &[],
        &["allow_routine"],
    );
    assert!(
        snapshot.status.success(),
        "{}",
        String::from_utf8_lossy(&snapshot.stderr)
    );
    assert_eq!(requests.len(), 1);
    let snapshot: JsonValue = serde_json::from_slice(&snapshot.stdout).expect("snapshot JSON");
    let snapshot_id = snapshot["snapshotId"].as_str().expect("snapshot id");
    let bodies = [
        (
            "/v1/navigate",
            json!({"url": "https://another.example/docs"}),
        ),
        ("/v1/click", json!({"index": 0, "snapshotId": snapshot_id})),
        (
            "/v1/type",
            json!({"index": 0, "snapshotId": snapshot_id, "text": "ordinary search"}),
        ),
        (
            "/v1/press",
            json!({"index": 0, "snapshotId": snapshot_id, "key": "Tab"}),
        ),
    ];
    for (path, body) in bodies {
        let output = fixture
            .command_for_with_timeout(
                "safe",
                "page-target",
                "POST",
                path,
                Some(&body.to_string()),
                "100",
            )
            .output()
            .expect("run granted routine action");
        assert!(
            output.status.success(),
            "{path}: {}",
            String::from_utf8_lossy(&output.stderr)
        );
        assert!(!fixture.approval_dir.join("request.json").exists());
    }
    let mut marker: JsonValue =
        serde_json::from_slice(&std::fs::read(&fixture.authority_path).expect("authority"))
            .expect("authority JSON");
    marker["runId"] = json!(Uuid::new_v4());
    std::fs::write(
        &fixture.authority_path,
        serde_json::to_vec(&marker).unwrap(),
    )
    .unwrap();
    let changed = fixture
        .command_for_with_timeout("safe", "page-target", "GET", "/v1/snapshot", None, "100")
        .output()
        .expect("run changed authority");
    assert!(!changed.status.success());
    assert!(String::from_utf8_lossy(&changed.stderr).contains("another run"));
}

#[test]
fn routine_form_buttons_preserve_one_shot_confirmation_for_submission_controls() {
    for (mode, needs_confirmation) in [
        ("form-button", false),
        ("form-reset", false),
        ("form-submit-button", true),
        ("form-submit-input", true),
        ("form-image-input", true),
    ] {
        let fixture = EmbeddedControllerFixture::new();
        let snapshot_id = fixture.snapshot_id(mode);
        let body = json!({"index": 0, "snapshotId": snapshot_id});
        let (output, requests) = fixture.run_with_decisions(
            mode,
            "page-target",
            "POST",
            "/v1/click",
            Some(&body.to_string()),
            &[],
            &["allow_routine", "allow_once"],
        );
        assert!(
            output.status.success(),
            "approved {mode} click failed: {}",
            String::from_utf8_lossy(&output.stderr)
        );
        assert_eq!(requests[0]["kind"], "origin");
        assert_eq!(
            requests.len(),
            if needs_confirmation { 2 } else { 1 },
            "{mode}"
        );
        if needs_confirmation {
            assert_eq!(requests[1]["kind"], "action");
            assert_eq!(requests[1]["operation"], "click");
        }
    }
}

#[test]
fn routine_policy_still_confirms_consequential_controls_submissions_and_activation_keys() {
    for (mode, path, extra) in [
        ("aria-delete", "/v1/click", json!({})),
        ("delete-value", "/v1/click", json!({})),
        (
            "safe",
            "/v1/type",
            json!({"text": "ordinary text", "submit": true}),
        ),
        ("safe", "/v1/press", json!({"key": "Enter"})),
        ("safe", "/v1/press", json!({"key": "Space"})),
    ] {
        let fixture = EmbeddedControllerFixture::new();
        let snapshot_id = fixture.snapshot_id(mode);
        let mut body = json!({"index": 0, "snapshotId": snapshot_id});
        body.as_object_mut()
            .unwrap()
            .extend(extra.as_object().unwrap().clone());
        let (output, requests) = fixture.run_with_decisions(
            mode,
            "page-target",
            "POST",
            path,
            Some(&body.to_string()),
            &[],
            &["allow_routine", "deny"],
        );
        assert!(
            !output.status.success(),
            "{mode} {path} bypassed confirmation"
        );
        assert_eq!(requests.len(), 2, "{mode} {path}");
        assert_eq!(requests[1]["kind"], "action");
        assert!(String::from_utf8_lossy(&output.stderr).contains("approval_denied"));
    }
    let fixture = EmbeddedControllerFixture::new();
    let (output, requests) = fixture.run_with_decisions(
        "safe",
        "page-target",
        "POST",
        "/v1/navigate",
        Some(r#"{"url":"https://example.test/delete-account"}"#),
        &[],
        &["allow_routine", "deny"],
    );
    assert!(!output.status.success());
    assert_eq!(requests.len(), 2);
}

#[test]
fn routine_policy_never_types_secrets_or_accepts_model_authored_grants() {
    for mode in ["password-name", "credit-card", "aria-sensitive"] {
        let fixture = EmbeddedControllerFixture::new();
        let snapshot_id = fixture.snapshot_id(mode);
        let body = json!({"index": 0, "snapshotId": snapshot_id, "text": "fixture-secret"});
        let (output, requests) = fixture.run_with_decisions(
            mode,
            "page-target",
            "POST",
            "/v1/type",
            Some(&body.to_string()),
            &[],
            &["allow_routine"],
        );
        assert!(!output.status.success());
        assert_eq!(requests.len(), 1);
        assert!(String::from_utf8_lossy(&output.stderr).contains("refuses to type"));
    }
    let fixture = EmbeddedControllerFixture::new();
    let body = json!({"url": "https://example.test/", "routine": true});
    let output = fixture.run("safe", "POST", "/v1/navigate", Some(&body.to_string()));
    assert!(!output.status.success());
    assert!(String::from_utf8_lossy(&output.stderr).contains("unsupported field routine"));
}

#[test]
fn origin_form_navigation_and_activation_each_use_the_bounded_consent_lane() {
    let fixture = EmbeddedControllerFixture::new();
    let (snapshot, origin_requests) = fixture.run_with_decisions(
        "safe",
        "page-target",
        "GET",
        "/v1/snapshot",
        None,
        &[],
        &["allow_origin"],
    );
    assert!(snapshot.status.success());
    assert_eq!(origin_requests.len(), 1);
    assert_eq!(origin_requests[0]["kind"], "origin");
    assert_eq!(origin_requests[0]["operation"], "approve-origin");

    let snapshot_id = fixture.snapshot_id("safe");
    let submit_body = json!({
        "index": 0,
        "snapshotId": snapshot_id,
        "text": "ordinary text",
        "submit": true
    })
    .to_string();
    let (submit, submit_requests) = fixture.run_with_decisions(
        "safe",
        "page-target",
        "POST",
        "/v1/type",
        Some(&submit_body),
        &["https://example.test"],
        &["allow_once"],
    );
    assert!(
        submit.status.success(),
        "approved form submit failed: {}",
        String::from_utf8_lossy(&submit.stderr)
    );
    assert_eq!(submit_requests[0]["operation"], "form-submit");

    let enter_body = json!({
        "index": 0,
        "snapshotId": snapshot_id,
        "key": "Enter"
    })
    .to_string();
    let (enter, enter_requests) = fixture.run_with_decisions(
        "safe",
        "page-target",
        "POST",
        "/v1/press",
        Some(&enter_body),
        &["https://example.test"],
        &["allow_once"],
    );
    assert!(enter.status.success());
    assert_eq!(enter_requests[0]["operation"], "press-enter");

    let (navigate, navigate_requests) = fixture.run_with_decisions(
        "safe",
        "page-target",
        "POST",
        "/v1/navigate",
        Some(r#"{"url":"https://destination.example/path"}"#),
        &["https://example.test"],
        &["allow_origin", "allow_once"],
    );
    assert!(
        navigate.status.success(),
        "approved navigation failed: {}",
        String::from_utf8_lossy(&navigate.stderr)
    );
    assert_eq!(navigate_requests.len(), 2);
    assert_eq!(navigate_requests[0]["kind"], "origin");
    assert_eq!(navigate_requests[1]["operation"], "navigate");
}

#[test]
fn ordinary_type_and_every_non_activation_press_use_exact_one_shot_consent() {
    let fixture = EmbeddedControllerFixture::new();
    let snapshot_id = fixture.snapshot_id("form-input");
    let private_text = "plain text must stay out of the approval request";
    let type_body = json!({
        "index": 0,
        "snapshotId": snapshot_id,
        "text": private_text,
        "submit": false
    })
    .to_string();
    let (typed, type_requests) = fixture.run_with_decisions(
        "form-input",
        "page-target",
        "POST",
        "/v1/type",
        Some(&type_body),
        &["https://example.test"],
        &["allow_once"],
    );
    assert!(
        typed.status.success(),
        "approved ordinary type failed: {}",
        String::from_utf8_lossy(&typed.stderr)
    );
    assert_eq!(type_requests.len(), 1);
    assert_eq!(type_requests[0]["kind"], "action");
    assert_eq!(type_requests[0]["operation"], "type");
    assert_eq!(type_requests[0]["destinationOrigin"], JsonValue::Null);
    assert_eq!(type_requests[0]["snapshotId"], snapshot_id);
    assert!(valid_snapshot_id(
        type_requests[0]["targetFingerprint"]
            .as_str()
            .expect("type target fingerprint")
    ));
    assert!(valid_snapshot_id(
        type_requests[0]["payloadFingerprint"]
            .as_str()
            .expect("type payload fingerprint")
    ));
    assert!(
        !serde_json::to_string(&type_requests[0])
            .expect("serialize type approval")
            .contains(private_text),
        "typed text leaked into the approval request"
    );

    for key in ["Delete", "Tab", "Escape"] {
        let press_body = json!({
            "index": 0,
            "snapshotId": snapshot_id,
            "key": key
        })
        .to_string();
        let (pressed, press_requests) = fixture.run_with_decisions(
            "form-input",
            "page-target",
            "POST",
            "/v1/press",
            Some(&press_body),
            &["https://example.test"],
            &["allow_once"],
        );
        assert!(
            pressed.status.success(),
            "approved {key} press failed: {}",
            String::from_utf8_lossy(&pressed.stderr)
        );
        assert_eq!(press_requests.len(), 1);
        assert_eq!(press_requests[0]["operation"], "press-key");
        assert_eq!(press_requests[0]["destinationOrigin"], JsonValue::Null);
        assert_eq!(press_requests[0]["snapshotId"], snapshot_id);
        assert!(valid_snapshot_id(
            press_requests[0]["targetFingerprint"]
                .as_str()
                .expect("press target fingerprint")
        ));
        assert!(valid_snapshot_id(
            press_requests[0]["payloadFingerprint"]
                .as_str()
                .expect("press payload fingerprint")
        ));
    }
}

#[test]
fn deny_timeout_replay_and_stale_target_fail_closed_without_action() {
    let fixture = EmbeddedControllerFixture::new();
    let snapshot_id = fixture.snapshot_id("safe");
    let body = json!({ "index": 0, "snapshotId": snapshot_id }).to_string();

    let (denied, requests) = fixture.run_with_decisions(
        "safe",
        "page-target",
        "POST",
        "/v1/click",
        Some(&body),
        &["https://example.test"],
        &["deny"],
    );
    assert_eq!(requests.len(), 1);
    assert!(!denied.status.success());
    assert!(String::from_utf8_lossy(&denied.stderr).contains("approval_denied_non_retryable"));

    let timed_out = fixture
        .command_for_with_timeout(
            "safe",
            "page-target",
            "POST",
            "/v1/click",
            Some(&body),
            "250",
        )
        .output()
        .expect("run embedded shared browser command");
    assert!(!timed_out.status.success());
    assert!(String::from_utf8_lossy(&timed_out.stderr).contains("approval_timeout_non_retryable"));

    fixture.prepare_authority("page-target", &["https://example.test"]);
    let now = unix_time_millis();
    let stale_decision = json!({
        "version": 1,
        "approvalId": Uuid::new_v4(),
        "requestFingerprint": SNAPSHOT_ID,
        "decision": "allow_once",
        "decidedByUserId": fixture.initiator_user_id,
        "decidedAtMs": now,
        "expiresAtMs": now + 200,
    });
    let stale_decision_path = fixture.approval_dir.join("decision.json");
    std::fs::write(
        &stale_decision_path,
        serde_json::to_vec(&stale_decision).expect("stale decision JSON"),
    )
    .expect("write stale decision");
    #[cfg(unix)]
    std::fs::set_permissions(&stale_decision_path, std::fs::Permissions::from_mode(0o600))
        .expect("protect stale decision");
    let replayed = fixture
        .command_for("safe", "page-target", "POST", "/v1/click", Some(&body))
        .output()
        .expect("run replay fixture");
    assert!(!replayed.status.success());
    assert!(
        String::from_utf8_lossy(&replayed.stderr)
            .contains("approval_stale_or_replayed_non_retryable")
    );

    let stale_snapshot_id = fixture.snapshot_id("stale-after-allow");
    let stale_body = json!({ "index": 0, "snapshotId": stale_snapshot_id }).to_string();
    let (stale, stale_requests) = fixture.run_with_decisions(
        "stale-after-allow",
        "page-target",
        "POST",
        "/v1/click",
        Some(&stale_body),
        &["https://example.test"],
        &["allow_once"],
    );
    assert_eq!(stale_requests.len(), 1);
    assert!(!stale.status.success());
    assert!(
        String::from_utf8_lossy(&stale.stderr).contains("approval_stale_non_retryable"),
        "unexpected stale-action error: {}",
        String::from_utf8_lossy(&stale.stderr)
    );

    let stale_type_body = json!({
        "index": 0,
        "snapshotId": stale_snapshot_id,
        "text": "must not be entered",
        "submit": false
    })
    .to_string();
    let (stale_type, stale_type_requests) = fixture.run_with_decisions(
        "stale-after-allow",
        "page-target",
        "POST",
        "/v1/type",
        Some(&stale_type_body),
        &["https://example.test"],
        &["allow_once"],
    );
    assert_eq!(stale_type_requests.len(), 1);
    assert_eq!(stale_type_requests[0]["operation"], "type");
    assert!(!stale_type.status.success());
    assert!(
        String::from_utf8_lossy(&stale_type.stderr).contains("approval_stale_non_retryable"),
        "unexpected stale-type error: {}",
        String::from_utf8_lossy(&stale_type.stderr)
    );

    let stale_press_body = json!({
        "index": 0,
        "snapshotId": stale_snapshot_id,
        "key": "Delete"
    })
    .to_string();
    let (stale_press, stale_press_requests) = fixture.run_with_decisions(
        "stale-after-allow",
        "page-target",
        "POST",
        "/v1/press",
        Some(&stale_press_body),
        &["https://example.test"],
        &["allow_once"],
    );
    assert_eq!(stale_press_requests.len(), 1);
    assert_eq!(stale_press_requests[0]["operation"], "press-key");
    assert!(!stale_press.status.success());
    assert!(
        String::from_utf8_lossy(&stale_press.stderr).contains("approval_stale_non_retryable"),
        "unexpected stale-press error: {}",
        String::from_utf8_lossy(&stale_press.stderr)
    );
}

#[test]
fn blank_page_is_observed_as_blank_without_any_approval_or_page_content() {
    // A browser that has just started sits on about:blank. Observing it must
    // succeed so the agent can navigate, but it grants and reads nothing.
    let fixture = EmbeddedControllerFixture::new();
    let (output, requests) = fixture.run_with_decisions(
        "blank-page",
        "page-target",
        "GET",
        "/v1/snapshot",
        None,
        &[],
        &[],
    );
    let payload = payload_of(&output);
    assert!(requests.is_empty(), "a blank page asked for approval");
    assert_eq!(payload["blank"], true);
    assert_eq!(payload["url"], "about:blank");
    assert_eq!(payload["title"], "");
    assert_eq!(payload["visibleText"], "");
    assert_eq!(payload["originApproved"], false);
    assert_eq!(payload["interactiveElements"], json!([]));
    assert!(payload["message"].as_str().unwrap().contains("navigate"));
    let raw = String::from_utf8_lossy(&output.stdout);
    assert!(!raw.contains("Script-written"));
    assert_no_canary("blank snapshot", &raw);
    let state: JsonValue = serde_json::from_slice(
        &std::fs::read(fixture.approval_dir.join("state.json")).expect("approval state"),
    )
    .expect("approval state JSON");
    assert_eq!(state["approvedOrigins"], json!([]));
    assert_ne!(state["routineBrowsingAllowed"], true);
    // A blank observation is not action evidence, so a turn that stops on it
    // is retried with the instruction to navigate.
    assert_eq!(
        fixture.action_log(),
        "",
        "a blank snapshot was logged as action"
    );

    let status = fixture
        .command_for("blank-page", "page-target", "GET", "/v1/status", None)
        .output()
        .expect("blank status");
    let status = payload_of(&status);
    assert_eq!(status["blank"], true);
    assert_eq!(status["ready"], true);
    assert!(!status.to_string().contains("Script-written"));
    assert!(!status.to_string().contains("request access"));

    // Nothing on a blank page can be acted on, even with its snapshot id.
    let snapshot_id = payload["snapshotId"].as_str().expect("blank snapshot id");
    let click = json!({"index": 0, "snapshotId": snapshot_id}).to_string();
    let (clicked, click_requests) = fixture.run_with_decisions(
        "blank-page",
        "page-target",
        "POST",
        "/v1/click",
        Some(&click),
        &[],
        &[],
    );
    assert!(!clicked.status.success());
    assert!(click_requests.is_empty());
    let click_error = String::from_utf8_lossy(&clicked.stderr);
    assert!(
        click_error.contains("[origin_not_approvable]"),
        "{click_error}"
    );
    assert!(!click_error.contains("_non_retryable"), "{click_error}");

    // Navigating away still asks for the destination site and the step.
    let (navigated, navigate_requests) = fixture.run_with_decisions(
        "blank-page",
        "page-target",
        "POST",
        "/v1/navigate",
        Some(r#"{"url":"https://example.test/"}"#),
        &[],
        &["allow_origin", "allow_once"],
    );
    let navigated = payload_of(&navigated);
    assert_eq!(navigate_requests.len(), 2);
    assert_eq!(navigate_requests[0]["kind"], "origin");
    assert_eq!(navigate_requests[1]["kind"], "action");
    assert_eq!(navigated["url"], "https://example.test/");
    assert_eq!(navigated["visibleText"], "Fixture page");
}

#[test]
fn new_tab_page_is_observed_as_blank_without_any_page_content() {
    // A tab opened in the viewer shows the new-tab page, which is just as
    // empty as about:blank.
    let fixture = EmbeddedControllerFixture::new();
    let (output, requests) = fixture.run_with_decisions(
        "new-tab-page",
        "page-target",
        "GET",
        "/v1/snapshot",
        None,
        &[],
        &[],
    );
    let payload = payload_of(&output);
    assert!(requests.is_empty(), "a new-tab page asked for approval");
    assert_eq!(payload["blank"], true);
    assert_eq!(payload["url"], "chrome://newtab/");
    assert_eq!(payload["visibleText"], "");
    assert_eq!(payload["interactiveElements"], json!([]));
    let raw = String::from_utf8_lossy(&output.stdout);
    assert!(!raw.contains("Script-written"));
    assert_no_canary("new-tab snapshot", &raw);
    assert_eq!(fixture.action_log(), "");
}

#[test]
fn only_empty_tabs_are_observed_without_an_origin() {
    // Other origin-less pages still fail closed. The error is not a consent
    // decision, so it points at navigating instead of ending the run.
    for mode in [
        "blank-fragment",
        "srcdoc-page",
        "data-page",
        "browser-internal",
    ] {
        let fixture = EmbeddedControllerFixture::new();
        let (output, requests) =
            fixture.run_with_decisions(mode, "page-target", "GET", "/v1/snapshot", None, &[], &[]);
        assert!(!output.status.success(), "{mode} was observed");
        assert!(requests.is_empty(), "{mode}");
        let stderr = String::from_utf8_lossy(&output.stderr);
        assert!(
            stderr.contains("[origin_not_approvable]"),
            "{mode}: {stderr}"
        );
        assert!(
            stderr.contains("navigate to the address"),
            "{mode}: {stderr}"
        );
        assert!(!stderr.contains("_non_retryable"), "{mode}: {stderr}");
        assert!(!stderr.contains("Script-written"), "{mode}: {stderr}");
        assert!(String::from_utf8_lossy(&output.stdout).is_empty(), "{mode}");
        assert_eq!(fixture.action_log(), "", "{mode}");
    }
}

#[test]
fn post_action_new_origin_is_redacted_until_separately_approved() {
    let fixture = EmbeddedControllerFixture::new();
    let snapshot_id = fixture.snapshot_id("new-origin-after-click");
    let body = json!({ "index": 0, "snapshotId": snapshot_id }).to_string();
    let (output, requests) = fixture.run_with_decisions(
        "new-origin-after-click",
        "page-target",
        "POST",
        "/v1/click",
        Some(&body),
        &["https://example.test"],
        &["allow_once"],
    );
    assert!(
        output.status.success(),
        "approved click failed: {}",
        String::from_utf8_lossy(&output.stderr)
    );
    assert_eq!(requests.len(), 1);
    let payload: JsonValue = serde_json::from_slice(&output.stdout).expect("redacted action JSON");
    assert_eq!(payload["redacted"], true);
    assert_eq!(payload["originApproved"], false);
    assert!(payload["url"].is_null());
    assert!(payload["title"].is_null());
    let raw = String::from_utf8_lossy(&output.stdout);
    assert!(!raw.contains("unapproved-secret"));
    assert!(!raw.contains("must-not-leak"));
    assert!(!raw.contains("Secret destination"));
    let action_log = std::fs::read_to_string(&fixture.actions_path).expect("redacted action log");
    assert!(!action_log.contains("unapproved-secret"));
    assert!(!action_log.contains("must-not-leak"));
    assert!(!action_log.contains("Secret destination"));
    let navigation_event: JsonValue = serde_json::from_str(
        action_log
            .lines()
            .last()
            .expect("redacted navigation action event"),
    )
    .expect("redacted navigation action JSON");
    assert_eq!(navigation_event["type"], "nav_result");
    assert_eq!(navigation_event["url"], JsonValue::Null);
}

#[test]
fn embedded_controller_binds_every_press_to_a_fresh_classified_target() {
    let fixture = EmbeddedControllerFixture::new();
    let safe_snapshot = fixture.snapshot_id("safe");
    let safe_press = json!({
        "index": 0,
        "snapshotId": safe_snapshot,
        "key": "Delete"
    })
    .to_string();
    let (safe, safe_requests) = fixture.run_with_decisions(
        "safe",
        "page-target",
        "POST",
        "/v1/press",
        Some(&safe_press),
        &["https://example.test"],
        &["allow_once"],
    );
    assert!(
        safe.status.success(),
        "safe target-bound press failed: {}",
        String::from_utf8_lossy(&safe.stderr)
    );
    assert_eq!(safe_requests.len(), 1);
    assert_eq!(safe_requests[0]["operation"], "press-key");

    let stale = fixture.run("reordered", "POST", "/v1/press", Some(&safe_press));
    assert!(!stale.status.success());
    assert!(String::from_utf8_lossy(&stale.stderr).contains("snapshot is stale"));

    for (mode, key, expected_error) in [("aria-sensitive", "Backspace", "refuses to type")] {
        let snapshot_id = fixture.snapshot_id(mode);
        let body = json!({
            "index": 0,
            "snapshotId": snapshot_id,
            "key": key
        })
        .to_string();
        let output = fixture.run(mode, "POST", "/v1/press", Some(&body));
        assert!(
            !output.status.success(),
            "unsafe press {mode}/{key} was accepted"
        );
        assert!(
            String::from_utf8_lossy(&output.stderr).contains(expected_error),
            "unexpected unsafe press error for {mode}/{key}: {}",
            String::from_utf8_lossy(&output.stderr)
        );
    }
}

#[test]
fn execution_evidence_requires_the_action_log_to_advance() {
    assert!(!execution_evidence_missing(None, 0));
    assert!(execution_evidence_missing(Some(12), 12));
    assert!(execution_evidence_missing(Some(12), 4));
    assert!(!execution_evidence_missing(Some(12), 13));
}

#[tokio::test]
async fn terminal_consent_failure_latches_mutations_and_keeps_status_redacted() {
    let server = SharedBrowserMcpServer::new();
    let calls = Arc::new(AtomicUsize::new(0));
    let mutation = SharedBrowserRequest {
        method: "POST".to_string(),
        path: "/v1/click".to_string(),
        body: Some(json!({ "index": 0, "snapshotId": SNAPSHOT_ID })),
    };

    let first_calls = Arc::clone(&calls);
    let first = server
        .execute_with_failure_latch(&mutation, || async move {
            first_calls.fetch_add(1, AtomicOrdering::SeqCst);
            Err(anyhow::anyhow!(
                "user denied this action [approval_denied_non_retryable]"
            ))
        })
        .await;
    assert!(matches!(
        first,
        Err(SharedBrowserMcpExecutionFailure::TerminalConsent(
            "approval_denied"
        ))
    ));

    let second_calls = Arc::clone(&calls);
    let second = server
        .execute_with_failure_latch(&mutation, || async move {
            second_calls.fetch_add(1, AtomicOrdering::SeqCst);
            Ok(json!({ "unexpected": "mutation executed" }))
        })
        .await;
    assert!(matches!(
        second,
        Err(SharedBrowserMcpExecutionFailure::TerminalConsent(
            "approval_denied"
        ))
    ));
    assert_eq!(
        calls.load(AtomicOrdering::SeqCst),
        1,
        "latched mutation executed or requested approval again"
    );

    let status = SharedBrowserRequest {
        method: "GET".to_string(),
        path: "/v1/status".to_string(),
        body: None,
    };
    let status_calls = Arc::clone(&calls);
    let status_payload = server
        .execute_with_failure_latch(&status, || async move {
            status_calls.fetch_add(1, AtomicOrdering::SeqCst);
            Ok(json!({ "unexpected": "status reached controller" }))
        })
        .await
        .expect("latched status remains readable");
    assert_eq!(status_payload["ready"], true);
    assert_eq!(status_payload["redacted"], true);
    assert_eq!(status_payload["url"], JsonValue::Null);
    assert_eq!(status_payload["terminalConsent"]["code"], "approval_denied");
    assert_eq!(calls.load(AtomicOrdering::SeqCst), 1);

    let snapshot = SharedBrowserRequest {
        method: "GET".to_string(),
        path: "/v1/snapshot".to_string(),
        body: None,
    };
    let snapshot_calls = Arc::clone(&calls);
    let snapshot_result = server
        .execute_with_failure_latch(&snapshot, || async move {
            snapshot_calls.fetch_add(1, AtomicOrdering::SeqCst);
            Ok(json!({ "unexpected": "snapshot requested approval again" }))
        })
        .await;
    assert!(matches!(
        snapshot_result,
        Err(SharedBrowserMcpExecutionFailure::TerminalConsent(
            "approval_denied"
        ))
    ));
    assert_eq!(calls.load(AtomicOrdering::SeqCst), 1);

    let tool_result = terminal_consent_call_result("approval_denied");
    assert_eq!(tool_result.is_error, Some(true));
    assert_eq!(
        tool_result
            .structured_content
            .expect("terminal consent structured signal")["terminalConsent"]["retryable"],
        false
    );
}

#[test]
fn only_explicit_terminal_approval_codes_are_latched() {
    for code in TERMINAL_APPROVAL_FAILURE_CODES {
        let error = anyhow::anyhow!("bounded approval failure [{code}_non_retryable]");
        assert_eq!(terminal_consent_failure_code_from_error(&error), Some(code));
        assert_eq!(canonical_terminal_consent_failure_code(code), Some(code));
    }

    for retryable in [
        "Shared Browser snapshot is stale; take a fresh snapshot before acting",
        "selected page is temporarily unavailable",
        "site origin cannot be approved [origin_not_approvable_non_retryable]",
        "site origin cannot be approved; navigate to the address the task names first [origin_not_approvable]",
        "unrelated browser failure",
    ] {
        assert_eq!(
            terminal_consent_failure_code_from_error(&anyhow::anyhow!(retryable)),
            None
        );
    }
    assert_eq!(
        canonical_terminal_consent_failure_code("approval_fake"),
        None
    );
}

#[test]
fn mcp_exposes_only_the_bounded_shared_browser_operations() {
    let tools = shared_browser_mcp_tools();
    assert_eq!(
        tools
            .iter()
            .map(|tool| tool.name.as_ref())
            .collect::<Vec<_>>(),
        [
            "request_human_input",
            "status",
            "snapshot",
            "navigate",
            "click",
            "type",
            "press",
            "scroll"
        ]
    );
    assert!(tools.iter().all(|tool| {
        tool.input_schema
            .get("additionalProperties")
            .and_then(JsonValue::as_bool)
            == Some(false)
    }));
    let press = tools
        .iter()
        .find(|tool| tool.name.as_ref() == "press")
        .expect("press tool");
    assert_eq!(
        press.input_schema.get("required"),
        Some(&json!(["index", "snapshotId", "key"]))
    );
}

#[test]
fn mcp_requests_reuse_strict_controller_validation() {
    let request = mcp_tool_request(
        "click",
        Some(JsonMap::from_iter([
            ("index".to_string(), json!(2)),
            ("snapshotId".to_string(), json!(SNAPSHOT_ID)),
        ])),
    )
    .expect("bounded click");
    assert_eq!(request.method, "POST");
    assert_eq!(request.path, "/v1/click");

    assert!(
        mcp_tool_request(
            "snapshot",
            Some(JsonMap::from_iter([(
                "evaluate".to_string(),
                json!("process.env"),
            )]))
        )
        .is_err()
    );
    assert!(
        mcp_tool_request(
            "press",
            Some(JsonMap::from_iter([(
                "key".to_string(),
                json!("Control+L"),
            )]))
        )
        .is_err()
    );
    assert!(
        mcp_tool_request(
            "press",
            Some(JsonMap::from_iter([("key".to_string(), json!("Delete"),)]))
        )
        .is_err()
    );
    assert!(
        mcp_tool_request(
            "press",
            Some(JsonMap::from_iter([
                ("index".to_string(), json!(0)),
                ("snapshotId".to_string(), json!(SNAPSHOT_ID)),
                ("key".to_string(), json!("Delete")),
            ]))
        )
        .is_ok()
    );
    assert!(mcp_tool_request("evaluate", None).is_err());
}
#[test]
fn human_input_tool_accepts_only_bounded_fresh_indices() {
    let valid = json!({ "indices": [0, 2], "snapshotId": "a".repeat(64) });
    assert!(mcp_tool_request("request_human_input", valid.as_object().cloned()).is_ok());
    for invalid in [
        json!({ "indices": [], "snapshotId": "a".repeat(64) }),
        json!({ "indices": [0, 0], "snapshotId": "a".repeat(64) }),
        json!({ "indices": [200], "snapshotId": "a".repeat(64) }),
        json!({ "indices": [0], "snapshotId": "stale" }),
        json!({ "indices": [0], "snapshotId": "a".repeat(64), "value": "must-not-be-accepted" }),
    ] {
        assert!(mcp_tool_request("request_human_input", invalid.as_object().cloned()).is_err());
    }
}

#[tokio::test]
async fn human_input_latch_blocks_every_later_observation_or_action() {
    let server = SharedBrowserMcpServer::new();
    let request = mcp_tool_request(
        "request_human_input",
        json!({
            "indices": [0], "snapshotId": "a".repeat(64)
        })
        .as_object()
        .cloned(),
    )
    .unwrap();
    let outcome = server
        .execute_with_failure_latch(&request, || async {
            Err(anyhow::anyhow!(
                "User input needed [human_input_required_non_retryable]"
            ))
        })
        .await;
    assert!(matches!(
        outcome,
        Err(SharedBrowserMcpExecutionFailure::TerminalConsent(
            "human_input_required"
        ))
    ));
    let snapshot = mcp_tool_request("snapshot", None).unwrap();
    let denied = server
        .execute_with_failure_latch(&snapshot, || async {
            panic!("human-input latch must not read page content")
        })
        .await;
    assert!(matches!(
        denied,
        Err(SharedBrowserMcpExecutionFailure::TerminalConsent(
            "human_input_required"
        ))
    ));
    let result = terminal_consent_call_result("human_input_required");
    assert_ne!(result.is_error, Some(true));
    assert_eq!(
        result.structured_content.unwrap()["terminalConsent"]["retryable"],
        false
    );
}

const CANARY_MARKER: &str = "INSTAFYCANARY";

fn payload_of(output: &Output) -> JsonValue {
    assert!(
        output.status.success(),
        "controller failed: {}",
        String::from_utf8_lossy(&output.stderr)
    );
    serde_json::from_slice(&output.stdout).expect("controller JSON")
}

fn assert_no_canary(label: &str, text: &str) {
    assert!(
        !text.contains(CANARY_MARKER),
        "{label} carried the canary: {text}"
    );
}

impl EmbeddedControllerFixture {
    fn action_log(&self) -> String {
        std::fs::read_to_string(&self.actions_path).unwrap_or_default()
    }

    /// Grants routine browsing at the first site prompt and returns the
    /// snapshot taken under it. Later `command_for` runs keep the grant.
    fn routine_snapshot(&self, mode: &str) -> JsonValue {
        let (output, requests) = self.run_with_decisions(
            mode,
            "page-target",
            "GET",
            "/v1/snapshot",
            None,
            &[],
            &["allow_routine"],
        );
        assert_eq!(requests.len(), 1);
        assert_eq!(requests[0]["kind"], "origin");
        payload_of(&output)
    }
}

#[test]
fn embedded_policy_modules_publish_their_api_without_commonjs() {
    use std::process::Stdio;
    let script = format!(
        "{}\n{}\nprocess.stdout.write(JSON.stringify([typeof module, typeof globalThis.__instafyBrowserRedaction.redactPageObservation, typeof globalThis.__instafyBrowserActionPolicy.classifyStep]));",
        embedded_plain_script(BROWSER_REDACTION_SCRIPT),
        embedded_plain_script(BROWSER_ACTION_POLICY_SCRIPT),
    );
    let mut child = StdCommand::new("node")
        .arg("-")
        .stdin(Stdio::piped())
        .stdout(Stdio::piped())
        .stderr(Stdio::piped())
        .spawn()
        .expect("spawn node");
    child
        .stdin
        .take()
        .expect("node stdin")
        .write_all(script.as_bytes())
        .expect("write script");
    let output = child.wait_with_output().expect("node output");
    assert!(
        output.status.success(),
        "{}",
        String::from_utf8_lossy(&output.stderr)
    );
    // `node -` defines `module`; the wrapper is what keeps the package
    // scripts on their global path.
    assert_eq!(
        String::from_utf8_lossy(&output.stdout),
        r#"["object","function","function"]"#
    );
    let embedded = embedded_shared_browser_script();
    assert!(
        embedded.find("__instafyBrowserRedaction") < embedded.find("__instafyBrowserActionPolicy")
    );
    // Larger than one Linux argv string may be, which is why it travels on stdin.
    assert!(embedded.len() > 64 * 1024);
}

#[test]
fn snapshots_mask_secrets_on_every_site_in_ask_and_routine() {
    // Ask mode: the site is approved, every action still asks.
    let fixture = EmbeddedControllerFixture::new();
    let output = fixture.run("canary-text", "GET", "/v1/snapshot", None);
    let payload = payload_of(&output);
    assert_no_canary(
        "ask-mode snapshot",
        &String::from_utf8_lossy(&output.stdout),
    );
    assert_eq!(payload["secretScreen"], false);
    assert!(
        payload["visibleText"]
            .as_str()
            .unwrap()
            .contains("[redacted secret]")
    );

    // Routine browsing, on the first site and on a site opened by address.
    let fixture = EmbeddedControllerFixture::new();
    let payload = fixture.routine_snapshot("canary-text");
    assert_no_canary("routine snapshot", &payload.to_string());
    assert!(
        payload["visibleText"]
            .as_str()
            .unwrap()
            .contains("[redacted secret]")
    );
    let navigate = json!({"url": "https://another-site.example/notes?session=INSTAFYCANARY9f8e7d6c5b4a3f2e1d"});
    let output = fixture
        .command_for(
            "canary-text",
            "page-target",
            "POST",
            "/v1/navigate",
            Some(&navigate.to_string()),
        )
        .output()
        .expect("navigate under routine");
    let payload = payload_of(&output);
    assert!(!fixture.approval_dir.join("request.json").exists());
    assert_no_canary("navigation result", &payload.to_string());
    assert!(
        payload["url"]
            .as_str()
            .unwrap()
            .contains("session=REDACTED")
    );
    assert!(
        payload["visibleText"]
            .as_str()
            .unwrap()
            .contains("[redacted secret]")
    );
    assert_no_canary("action log", &fixture.action_log());
    assert!(fixture.action_log().contains("session=REDACTED"));

    let status = fixture
        .command_for("canary-text", "page-target", "GET", "/v1/status", None)
        .output()
        .expect("status");
    assert_no_canary("status", &payload_of(&status).to_string());
}

#[test]
fn secret_screens_withhold_text_and_stay_withheld_until_a_new_page() {
    let fixture = EmbeddedControllerFixture::new();
    let output = fixture.run("secret-screen", "GET", "/v1/snapshot", None);
    let payload = payload_of(&output);
    assert_no_canary("secret screen", &String::from_utf8_lossy(&output.stdout));
    assert_eq!(payload["secretScreen"], true);
    assert_eq!(payload["visibleText"], "");
    assert!(
        payload["message"]
            .as_str()
            .unwrap()
            .contains("tell the user in words which control")
    );
    // Control names stay so the agent can name the control.
    assert_eq!(payload["interactiveElements"][0]["label"], "Search");
    assert!(fixture.document_mark.exists());

    // The same document stays withheld even when nothing on it matches now.
    let payload = payload_of(&fixture.run("safe", "GET", "/v1/snapshot", None));
    assert_eq!(payload["secretScreen"], true);
    assert_eq!(payload["visibleText"], "");

    // A new page lifts it.
    let (output, requests) = fixture.run_with_decisions(
        "safe",
        "page-target",
        "POST",
        "/v1/navigate",
        Some(r#"{"url":"https://example.test/next"}"#),
        &["https://example.test"],
        &["allow_once"],
    );
    assert_eq!(requests.len(), 1);
    let payload = payload_of(&output);
    assert_eq!(payload["secretScreen"], false);
    assert_eq!(payload["visibleText"], "Fixture page");

    // Missing page answers withhold that observation, but do not mark the
    // document: a page caught mid-navigation is read normally next time.
    let fixture = EmbeddedControllerFixture::new();
    let payload = payload_of(&fixture.run("signals-fail", "GET", "/v1/snapshot", None));
    assert_eq!(payload["secretScreen"], true);
    assert_eq!(payload["visibleText"], "");
    assert!(!fixture.document_mark.exists());
    let payload = payload_of(&fixture.run("safe", "GET", "/v1/snapshot", None));
    assert_eq!(payload["secretScreen"], false);
    assert_eq!(payload["visibleText"], "Fixture page");
}

#[test]
fn routine_asks_for_named_categories_with_the_category_in_the_label() {
    for (mode, label) in [
        ("invite-button", "Sharing or access change: Invite member"),
        ("export-link", "Download or export: Export CSV"),
        ("generate-key", "Key or password change: Generate API key"),
    ] {
        let fixture = EmbeddedControllerFixture::new();
        let snapshot_id = fixture.snapshot_id(mode);
        let body = json!({"index": 0, "snapshotId": snapshot_id});
        let (output, requests) = fixture.run_with_decisions(
            mode,
            "page-target",
            "POST",
            "/v1/click",
            Some(&body.to_string()),
            &[],
            &["allow_routine", "deny"],
        );
        assert!(!output.status.success(), "{mode} ran without asking");
        assert_eq!(requests.len(), 2, "{mode}");
        assert_eq!(requests[1]["kind"], "action");
        assert_eq!(requests[1]["display"]["label"], label);
        assert!(String::from_utf8_lossy(&output.stderr).contains("approval_denied"));
        assert!(!fixture.action_log().contains("\"type\":\"click\""));
    }

    // An ordinary control stays free under routine, and so does typing an
    // address for a site the run has not used yet.
    let fixture = EmbeddedControllerFixture::new();
    let snapshot = fixture.routine_snapshot("plain-button");
    let body = json!({"index": 0, "snapshotId": snapshot["snapshotId"]});
    let output = fixture
        .command_for(
            "plain-button",
            "page-target",
            "POST",
            "/v1/click",
            Some(&body.to_string()),
        )
        .output()
        .expect("routine click");
    payload_of(&output);
    let output = fixture
        .command_for(
            "plain-button",
            "page-target",
            "POST",
            "/v1/navigate",
            Some(r#"{"url":"https://never-used.example/start"}"#),
        )
        .output()
        .expect("routine navigation to a new site");
    payload_of(&output);
    assert!(!fixture.approval_dir.join("request.json").exists());

    // A risky address asks under routine, by its address alone.
    let fixture = EmbeddedControllerFixture::new();
    let (output, requests) = fixture.run_with_decisions(
        "safe",
        "page-target",
        "POST",
        "/v1/navigate",
        Some(r#"{"url":"https://example.test/reports/export.csv"}"#),
        &[],
        &["allow_routine", "deny"],
    );
    assert!(!output.status.success());
    assert_eq!(requests.len(), 2);
    assert_eq!(
        requests[1]["display"]["label"],
        "Download or export: Navigate the Shared Browser"
    );

    // Without the page's structural facts nothing is assumed safe.
    let fixture = EmbeddedControllerFixture::new();
    let snapshot_id = fixture.snapshot_id("no-policy");
    let body = json!({"index": 0, "snapshotId": snapshot_id});
    let (output, requests) = fixture.run_with_decisions(
        "no-policy",
        "page-target",
        "POST",
        "/v1/click",
        Some(&body.to_string()),
        &[],
        &["allow_routine", "deny"],
    );
    assert!(!output.status.success());
    assert_eq!(requests.len(), 2);
}

#[test]
fn reveal_sign_in_and_upload_steps_are_refused_without_a_prompt_in_every_mode() {
    for (mode, path, extra, code) in [
        ("reveal-key", "/v1/click", json!({}), "step_refused_secret"),
        (
            "sign-in-email",
            "/v1/type",
            json!({"text": "person@example.test"}),
            "step_refused_sign_in",
        ),
        ("file-input", "/v1/click", json!({}), "step_refused_upload"),
    ] {
        // Ask mode.
        let fixture = EmbeddedControllerFixture::new();
        let snapshot_id = fixture.snapshot_id(mode);
        let mut body = json!({"index": 0, "snapshotId": snapshot_id});
        body.as_object_mut()
            .unwrap()
            .extend(extra.as_object().unwrap().clone());
        let (output, requests) = fixture.run_with_decisions(
            mode,
            "page-target",
            "POST",
            path,
            Some(&body.to_string()),
            &["https://example.test"],
            &["allow_once"],
        );
        assert!(!output.status.success(), "{mode} ask mode");
        assert!(requests.is_empty(), "{mode} prompted in ask mode");
        assert!(
            String::from_utf8_lossy(&output.stderr).contains(code),
            "{mode}: {}",
            String::from_utf8_lossy(&output.stderr)
        );

        // Routine browsing.
        let fixture = EmbeddedControllerFixture::new();
        let snapshot = fixture.routine_snapshot(mode);
        let mut body = json!({"index": 0, "snapshotId": snapshot["snapshotId"]});
        body.as_object_mut()
            .unwrap()
            .extend(extra.as_object().unwrap().clone());
        let output = fixture
            .command_for(mode, "page-target", "POST", path, Some(&body.to_string()))
            .output()
            .expect("refused routine step");
        assert!(!output.status.success(), "{mode} routine");
        assert!(String::from_utf8_lossy(&output.stderr).contains(code));
        assert!(!fixture.approval_dir.join("request.json").exists());
        let log = fixture.action_log();
        assert!(!log.contains("\"type\":\"click\"") && !log.contains("\"type\":\"type\""));
    }
}

#[test]
fn credential_steps_withhold_the_page_before_they_run() {
    let fixture = EmbeddedControllerFixture::new();
    let snapshot_id = fixture.snapshot_id("credential-row");
    let body = json!({"index": 0, "snapshotId": snapshot_id});
    let (output, requests) = fixture.run_with_decisions(
        "credential-row",
        "page-target",
        "POST",
        "/v1/click",
        Some(&body.to_string()),
        &[],
        &["allow_routine", "allow_once"],
    );
    assert_eq!(requests.len(), 2);
    assert_eq!(
        requests[1]["display"]["label"],
        "May show a secret: Production key ••••••••"
    );
    let payload = payload_of(&output);
    assert_eq!(payload["secretScreen"], true);
    assert_eq!(payload["visibleText"], "");
    assert!(fixture.document_mark.exists());
    let payload = payload_of(&fixture.run("safe", "GET", "/v1/snapshot", None));
    assert_eq!(payload["secretScreen"], true);
}

#[test]
fn credential_steps_withhold_the_page_they_open_even_when_it_loads_late() {
    let fixture = EmbeddedControllerFixture::new();
    let snapshot = fixture.routine_snapshot("credential-row");
    let body = json!({"index": 0, "snapshotId": snapshot["snapshotId"]});
    let (output, requests) = fixture.run_with_decisions(
        "credential-row",
        "page-target",
        "POST",
        "/v1/click",
        Some(&body.to_string()),
        &[],
        &["allow_routine", "allow_once"],
    );
    assert_eq!(requests.len(), 2);
    assert_eq!(payload_of(&output)["secretScreen"], true);
    let record_path = fixture.approval_dir.join("withhold-next.json");
    let record: JsonValue =
        serde_json::from_slice(&std::fs::read(&record_path).expect("withheld-document record"))
            .expect("record JSON");
    assert_eq!(record["afterDocument"], "DOCUMENT1");
    assert_eq!(record["runId"], fixture.run_id.to_string());

    // The step's page navigates after the click returned: a new document
    // without the in-page mark, on the same address, showing nothing the
    // page checks recognize.
    std::fs::remove_file(&fixture.document_mark).expect("new document drops the mark");
    std::fs::write(&fixture.document_id, "DOCUMENT2").expect("late navigation");
    let snapshot_now = || {
        payload_of(
            &fixture
                .command_for("safe", "page-target", "GET", "/v1/snapshot", None)
                .output()
                .expect("snapshot after a late navigation"),
        )
    };
    let payload = snapshot_now();
    assert_eq!(payload["secretScreen"], true);
    assert_eq!(payload["visibleText"], "");
    assert!(fixture.document_mark.exists());
    assert!(!record_path.exists());
    // It stays withheld as long as that document does.
    assert_eq!(snapshot_now()["secretScreen"], true);

    // An address the agent opens itself is read normally, and clears a record
    // that no document consumed yet.
    std::fs::write(
        &record_path,
        serde_json::to_vec(&record).expect("record bytes"),
    )
    .expect("restore record");
    #[cfg(unix)]
    std::fs::set_permissions(&record_path, std::fs::Permissions::from_mode(0o600))
        .expect("protect record");
    let output = fixture
        .command_for(
            "safe",
            "page-target",
            "POST",
            "/v1/navigate",
            Some(r#"{"url":"https://example.test/next"}"#),
        )
        .output()
        .expect("routine navigation");
    let payload = payload_of(&output);
    assert_eq!(payload["secretScreen"], false);
    assert_eq!(payload["visibleText"], "Fixture page");
    assert!(!record_path.exists());
}

#[test]
fn long_approval_labels_stay_valid_for_the_origin() {
    for shift in 0..=10 {
        let mode = format!("long-label-{shift}");
        let fixture = EmbeddedControllerFixture::new();
        let snapshot_id = fixture.snapshot_id(&mode);
        let body = json!({"index": 0, "snapshotId": snapshot_id});
        let (output, requests) = fixture.run_with_decisions(
            &mode,
            "page-target",
            "POST",
            "/v1/click",
            Some(&body.to_string()),
            &["https://example.test"],
            &["allow_once"],
        );
        payload_of(&output);
        assert_eq!(requests.len(), 1, "{mode}");
        let label = requests[0]["display"]["label"].as_str().expect("label");
        // The origin's own check: non-empty, bounded, and equal to its
        // whitespace-joined form.
        assert!(!label.is_empty() && label.len() <= 240, "{mode}: {label}");
        assert_eq!(
            label.split_whitespace().collect::<Vec<_>>().join(" "),
            label,
            "{mode}"
        );
        assert!(label.contains("Open report (shown as"), "{mode}: {label}");
        assert!(!label.contains('\u{FFFD}'), "{mode}: {label}");
    }
}

#[test]
fn masked_display_text_keeps_ordinary_addresses() {
    let fixture = EmbeddedControllerFixture::new();
    let snapshot_id = fixture.snapshot_id("url-label");
    let body = json!({"index": 0, "snapshotId": snapshot_id});
    let (output, requests) = fixture.run_with_decisions(
        "url-label",
        "page-target",
        "POST",
        "/v1/click",
        Some(&body.to_string()),
        &["https://example.test"],
        &["allow_once"],
    );
    payload_of(&output);
    assert_eq!(requests.len(), 1);
    let label = requests[0]["display"]["label"].as_str().expect("label");
    assert!(
        label.contains("https://github.com/instafy-dev/instafy/pull/615/files?token=REDACTED"),
        "{label}"
    );
    assert_no_canary("approval label", label);
    let log = fixture.action_log();
    assert!(
        log.contains("https://github.com/instafy-dev/instafy/pull/615/files?token=REDACTED"),
        "{log}"
    );
    assert_no_canary("action log", &log);
}

#[test]
fn stderr_approval_labels_and_action_log_never_carry_page_secrets() {
    let fixture = EmbeddedControllerFixture::new();
    let snapshot_id = fixture.snapshot_id("click-error-canary");
    let body = json!({"index": 0, "snapshotId": snapshot_id});
    let (output, _) = fixture.run_with_decisions(
        "click-error-canary",
        "page-target",
        "POST",
        "/v1/click",
        Some(&body.to_string()),
        &["https://example.test"],
        &["allow_once"],
    );
    assert!(!output.status.success());
    let stderr = String::from_utf8_lossy(&output.stderr);
    assert_no_canary("stderr", &stderr);
    assert!(stderr.contains("[redacted secret]"), "{stderr}");

    let fixture = EmbeddedControllerFixture::new();
    let snapshot = payload_of(&fixture.run("canary-label", "GET", "/v1/snapshot", None));
    assert_no_canary("snapshot names", &snapshot.to_string());
    let body = json!({"index": 0, "snapshotId": snapshot["snapshotId"]});
    let (output, requests) = fixture.run_with_decisions(
        "canary-label",
        "page-target",
        "POST",
        "/v1/click",
        Some(&body.to_string()),
        &["https://example.test"],
        &["allow_once"],
    );
    payload_of(&output);
    assert_eq!(requests.len(), 1);
    assert_no_canary("approval request", &requests[0].to_string());
    assert!(
        requests[0]["display"]["label"]
            .as_str()
            .unwrap()
            .contains("[redacted secret]")
    );
    let log = fixture.action_log();
    assert!(log.contains("\"type\":\"click\""));
    assert_no_canary("action log", &log);
}

#[test]
fn every_controller_connection_denies_downloads() {
    let fixture = EmbeddedControllerFixture::new();
    payload_of(&fixture.run("safe", "GET", "/v1/snapshot", None));
    payload_of(&fixture.run("safe", "GET", "/v1/status", None));
    let calls: Vec<JsonValue> = std::fs::read_to_string(&fixture.cdp_log)
        .expect("browser CDP log")
        .lines()
        .map(|line| serde_json::from_str(line).expect("CDP log line"))
        .collect();
    // Each connection denies downloads first and closes at the end, which
    // removes Playwright's temporary download folder.
    assert_eq!(calls.len(), 4);
    for pair in calls.chunks(2) {
        assert_eq!(pair[0]["method"], "Browser.setDownloadBehavior");
        assert_eq!(pair[0]["params"], json!({"behavior": "deny"}));
        assert_eq!(pair[1]["method"], "close");
    }
}

#[test]
fn only_an_attested_browser_host_starts_runs_in_routine_browsing() {
    use crate::browser_host::mode::{LazyMode, force_lazy_mode_for_tests};

    {
        let _boot_time_or_no_browser = force_lazy_mode_for_tests(None);
        assert_eq!(run_approval_start(), ApprovalStart::Ask);
    }
    for persist in [false, true] {
        let _host = force_lazy_mode_for_tests(Some(LazyMode { persist }));
        assert_eq!(run_approval_start(), ApprovalStart::Routine);
    }
}

#[tokio::test]
async fn a_routine_start_writes_bound_private_state_that_the_run_end_revokes() {
    let directory = tempfile::tempdir().expect("marker tempdir");
    let path = directory.path().join("agent-control.json");
    let approval_dir = directory.path().join("approvals");
    let run_id = Uuid::new_v4();
    let initiator_user_id = Uuid::new_v4();
    let cancel_signal = JobCancelSignal::new();
    let guard = SharedBrowserAgentControlGuard::acquire_with_path(
        path.clone(),
        approval_dir.clone(),
        ApprovalStart::Routine,
        run_id,
        initiator_user_id,
        "page-target",
        "Octo",
        cancel_signal.clone(),
        Duration::from_secs(60),
    )
    .expect("acquire routine run");

    let marker: JsonValue =
        serde_json::from_slice(&std::fs::read(&path).expect("marker")).expect("marker JSON");
    let state_path = approval_dir.join("state.json");
    let state: JsonValue =
        serde_json::from_slice(&std::fs::read(&state_path).expect("state")).expect("state JSON");
    assert_eq!(
        state,
        json!({
            "version": 1,
            "ownerId": marker["ownerId"],
            "runId": run_id.to_string(),
            "initiatorUserId": initiator_user_id.to_string(),
            "browserPageId": "page-target",
            "approvedOrigins": [],
            "consumedApprovalIds": [],
            "routineBrowsingAllowed": true,
        })
    );
    for key in ["ownerId", "runId", "initiatorUserId", "browserPageId"] {
        assert_eq!(state[key], marker[key], "{key}");
    }
    assert_eq!(state["ownerId"], guard.owner_id.to_lowercase());
    #[cfg(unix)]
    assert_eq!(
        std::fs::metadata(&state_path)
            .expect("state metadata")
            .permissions()
            .mode()
            & 0o777,
        0o600
    );
    let entries = std::fs::read_dir(&approval_dir)
        .expect("approval directory")
        .map(|entry| entry.expect("entry").file_name())
        .collect::<Vec<_>>();
    assert_eq!(entries, vec![std::ffi::OsString::from("state.json")]);

    cancel_signal.confirm_shared_browser_shutdown();
    drop(guard);
    assert!(!state_path.exists(), "the run's grant ends with the run");
    assert!(!path.exists());

    // Ask writes no state: the scripts start from their empty Ask state.
    let cancel_signal = JobCancelSignal::new();
    let guard = SharedBrowserAgentControlGuard::acquire_with_path(
        path.clone(),
        approval_dir.clone(),
        ApprovalStart::Ask,
        Uuid::new_v4(),
        Uuid::new_v4(),
        "page-target",
        "Octo",
        cancel_signal.clone(),
        Duration::from_secs(60),
    )
    .expect("acquire ask run");
    assert_eq!(
        std::fs::read_dir(&approval_dir)
            .expect("approval directory")
            .count(),
        0
    );
    cancel_signal.confirm_shared_browser_shutdown();
    drop(guard);
}

#[test]
fn a_routine_start_that_cannot_be_written_publishes_no_state() {
    let directory = tempfile::tempdir().expect("approval tempdir");
    let owner_id = Uuid::new_v4().to_string();
    // The temporary file's place is taken, so the write fails.
    std::fs::create_dir(
        directory
            .path()
            .join(format!(".instafy-approval-{owner_id}")),
    )
    .expect("block the temporary file");
    let error = write_routine_approval_state(
        directory.path(),
        &owner_id,
        Uuid::new_v4(),
        Uuid::new_v4(),
        "page-target",
    )
    .expect_err("a blocked write fails");
    assert!(format!("{error:#}").contains("Shared Browser approval state"));
    assert!(!directory.path().join("state.json").exists());
}

#[test]
fn a_routine_start_reads_navigates_and_follows_links_to_new_sites_without_a_prompt() {
    let fixture = EmbeddedControllerFixture::new();
    // "100" fails any prompt this run would publish as unanswered.
    let run = |mode: &str, method: &str, path: &str, body: Option<&str>| {
        fixture.prepare_routine_start("page-target");
        let output = fixture
            .command_for_with_timeout(mode, "page-target", method, path, body, "100")
            .output()
            .expect("run routine step");
        assert!(
            !fixture.approval_dir.join("request.json").exists(),
            "{method} {path} asked"
        );
        payload_of(&output)
    };

    // From the blank page to a site the run has not used, then reading there.
    let navigated = run(
        "blank-page",
        "POST",
        "/v1/navigate",
        Some(r#"{"url":"https://new.example/x"}"#),
    );
    assert_eq!(navigated["url"], "https://new.example/x");
    assert_ne!(navigated["redacted"], true);
    let snapshot = run("safe", "GET", "/v1/snapshot", None);
    assert_eq!(snapshot["url"], "https://example.test/");
    assert_ne!(snapshot["redacted"], true);

    // A second site, by address and by a plain cross-site link.
    let navigated = run(
        "safe",
        "POST",
        "/v1/navigate",
        Some(r#"{"url":"https://another.example/docs"}"#),
    );
    assert_eq!(navigated["url"], "https://another.example/docs");
    let snapshot = run("cross-site-link", "GET", "/v1/snapshot", None);
    let body = json!({"index": 0, "snapshotId": snapshot["snapshotId"]}).to_string();
    run("cross-site-link", "POST", "/v1/click", Some(&body));
    assert!(fixture.action_log().contains("\"type\":\"click\""));

    // Ordinary clicks, typing that does not submit and non-activation keys.
    for (mode, path, extra) in [
        ("plain-button", "/v1/click", json!({})),
        ("safe", "/v1/type", json!({"text": "ordinary search"})),
        ("safe", "/v1/press", json!({"key": "Tab"})),
    ] {
        let snapshot = run(mode, "GET", "/v1/snapshot", None);
        let mut body = json!({"index": 0, "snapshotId": snapshot["snapshotId"]});
        body.as_object_mut()
            .unwrap()
            .extend(extra.as_object().unwrap().clone());
        run(mode, "POST", path, Some(&body.to_string()));
    }
}

#[test]
fn a_routine_start_still_asks_for_every_risky_step() {
    let clicks = [
        ("invite-button", "Sharing or access change: Invite member"),
        ("export-link", "Download or export: Export CSV"),
        ("generate-key", "Key or password change: Generate API key"),
        ("aria-delete", ""),
        ("form-submit-button", ""),
        // Script-driven save buttons have no form to check.
        ("save-button", "Change something: Speichern"),
        ("save-button-en", "Change something: Save changes"),
    ];
    for (mode, label) in clicks {
        let fixture = EmbeddedControllerFixture::new();
        let snapshot_id = fixture.snapshot_id(mode);
        fixture.prepare_routine_start("page-target");
        let body = json!({"index": 0, "snapshotId": snapshot_id}).to_string();
        let (output, requests) = fixture.decide_prepared(
            fixture.command_for(mode, "page-target", "POST", "/v1/click", Some(&body)),
            &["deny"],
        );
        assert!(!output.status.success(), "{mode} ran without asking");
        assert_eq!(requests.len(), 1, "{mode}");
        assert_eq!(requests[0]["kind"], "action", "{mode}");
        if !label.is_empty() {
            assert_eq!(requests[0]["display"]["label"], label, "{mode}");
        }
        assert!(String::from_utf8_lossy(&output.stderr).contains("approval_denied"));
        assert!(
            !fixture.action_log().contains("\"type\":\"click\""),
            "{mode}"
        );
    }

    for (path, extra) in [
        ("/v1/type", json!({"text": "ordinary text", "submit": true})),
        ("/v1/press", json!({"key": "Enter"})),
        ("/v1/press", json!({"key": "Space"})),
    ] {
        let fixture = EmbeddedControllerFixture::new();
        let snapshot_id = fixture.snapshot_id("safe");
        fixture.prepare_routine_start("page-target");
        let mut body = json!({"index": 0, "snapshotId": snapshot_id});
        body.as_object_mut()
            .unwrap()
            .extend(extra.as_object().unwrap().clone());
        let (output, requests) = fixture.decide_prepared(
            fixture.command_for("safe", "page-target", "POST", path, Some(&body.to_string())),
            &["deny"],
        );
        assert!(
            !output.status.success(),
            "{path} {extra} ran without asking"
        );
        assert_eq!(requests.len(), 1, "{path} {extra}");
        assert_eq!(requests[0]["kind"], "action");
    }

    for url in [
        "https://example.test/logout",
        "https://example.test/reports/export?format=csv",
    ] {
        let fixture = EmbeddedControllerFixture::new();
        fixture.prepare_routine_start("page-target");
        let body = json!({ "url": url }).to_string();
        let (output, requests) = fixture.decide_prepared(
            fixture.command_for("safe", "page-target", "POST", "/v1/navigate", Some(&body)),
            &["deny"],
        );
        assert!(!output.status.success(), "{url} opened without asking");
        assert_eq!(requests.len(), 1, "{url}");
        assert_eq!(requests[0]["operation"], "navigate");
        assert!(!fixture.action_log().contains("\"type\":\"navigate\""));
    }

    // Unanswered, a risky step fails as unanswered and does nothing.
    let fixture = EmbeddedControllerFixture::new();
    let snapshot_id = fixture.snapshot_id("save-button");
    fixture.prepare_routine_start("page-target");
    let body = json!({"index": 0, "snapshotId": snapshot_id}).to_string();
    let output = fixture
        .command_for_with_timeout(
            "save-button",
            "page-target",
            "POST",
            "/v1/click",
            Some(&body),
            "100",
        )
        .output()
        .expect("unanswered routine step");
    assert!(!output.status.success());
    assert!(String::from_utf8_lossy(&output.stderr).contains("approval_timeout_non_retryable"));
    assert!(!fixture.action_log().contains("\"type\":\"click\""));

    // An allowed risky step runs once, and the run stays in routine browsing.
    let fixture = EmbeddedControllerFixture::new();
    let snapshot_id = fixture.snapshot_id("save-button");
    fixture.prepare_routine_start("page-target");
    let body = json!({"index": 0, "snapshotId": snapshot_id}).to_string();
    let (output, requests) = fixture.decide_prepared(
        fixture.command_for(
            "save-button",
            "page-target",
            "POST",
            "/v1/click",
            Some(&body),
        ),
        &["allow_once"],
    );
    payload_of(&output);
    assert_eq!(requests.len(), 1);
    assert!(fixture.action_log().contains("\"type\":\"click\""));
    let output = fixture
        .command_for_with_timeout(
            "save-button",
            "page-target",
            "POST",
            "/v1/navigate",
            Some(r#"{"url":"https://later.example/next"}"#),
            "100",
        )
        .output()
        .expect("routine navigation after an answered prompt");
    payload_of(&output);
}

#[test]
fn a_routine_start_still_refuses_the_users_own_steps_without_a_prompt() {
    for (mode, path, extra, code) in [
        ("reveal-key", "/v1/click", json!({}), "step_refused_secret"),
        (
            "sign-in-email",
            "/v1/type",
            json!({"text": "person@example.test"}),
            "step_refused_sign_in",
        ),
        ("file-input", "/v1/click", json!({}), "step_refused_upload"),
    ] {
        let fixture = EmbeddedControllerFixture::new();
        let snapshot_id = fixture.snapshot_id(mode);
        fixture.prepare_routine_start("page-target");
        let mut body = json!({"index": 0, "snapshotId": snapshot_id});
        body.as_object_mut()
            .unwrap()
            .extend(extra.as_object().unwrap().clone());
        let (output, requests) = fixture.decide_prepared(
            fixture.command_for(mode, "page-target", "POST", path, Some(&body.to_string())),
            &["allow_once"],
        );
        assert!(!output.status.success(), "{mode}");
        assert!(requests.is_empty(), "{mode} prompted");
        assert!(
            String::from_utf8_lossy(&output.stderr).contains(code),
            "{mode}"
        );
    }
}

#[test]
fn a_routine_start_bound_to_another_run_fails_closed() {
    let fixture = EmbeddedControllerFixture::new();
    for (owner_id, run_id) in [
        (Uuid::new_v4(), fixture.run_id),
        (fixture.owner_id, Uuid::new_v4()),
    ] {
        fixture.prepare_authority("page-target", &[]);
        write_routine_approval_state(
            &fixture.approval_dir,
            &owner_id.to_string(),
            run_id,
            fixture.initiator_user_id,
            "page-target",
        )
        .expect("seed a foreign routine start");
        let output = fixture
            .command_for_with_timeout("safe", "page-target", "GET", "/v1/snapshot", None, "100")
            .output()
            .expect("snapshot under a foreign state");
        assert!(!output.status.success());
        assert!(String::from_utf8_lossy(&output.stderr).contains("belongs to another run"));
    }
}

#[test]
fn the_approval_window_agrees_across_the_script_the_tool_and_the_origin() {
    let script_constant = |name: &str| -> u128 {
        let declaration = format!("const {name} = ");
        let line = SHARED_BROWSER_APPROVAL_SCRIPT
            .lines()
            .map(str::trim)
            .find(|line| line.starts_with(&declaration))
            .unwrap_or_else(|| panic!("{name} is declared"));
        line[declaration.len()..]
            .trim_end_matches(';')
            .replace('_', "")
            .parse()
            .unwrap_or_else(|_| panic!("{name} is a number"))
    };
    assert_eq!(
        script_constant("DEFAULT_APPROVAL_WAIT_MS"),
        DEFAULT_APPROVAL_WAIT.as_millis()
    );
    assert_eq!(
        script_constant("MAX_APPROVAL_WAIT_MS"),
        MAX_APPROVAL_WAIT.as_millis()
    );
    // A shorter origin cap would refuse the script's requests unseen.
    assert_eq!(
        u128::from(origin_http_server::SHARED_BROWSER_MAX_APPROVAL_LIFETIME_MS),
        MAX_APPROVAL_WAIT.as_millis()
    );
    assert_eq!(DEFAULT_APPROVAL_WAIT, Duration::from_secs(120));
    assert_eq!(MAX_APPROVAL_WAIT, Duration::from_secs(300));

    assert_eq!(approval_wait_budget(None), DEFAULT_APPROVAL_WAIT);
    assert_eq!(
        approval_wait_budget(Some(" 5000 ")),
        Duration::from_millis(5000)
    );
    assert_eq!(approval_wait_budget(Some("10")), Duration::from_millis(100));
    assert_eq!(approval_wait_budget(Some("900000")), MAX_APPROVAL_WAIT);
    assert_eq!(approval_wait_budget(Some("NaN")), DEFAULT_APPROVAL_WAIT);
    // A value this side cannot read never sizes the tool below the script.
    assert_eq!(approval_wait_budget(Some("soon")), MAX_APPROVAL_WAIT);
}

#[test]
fn a_person_gets_the_full_default_window_to_answer() {
    let fixture = EmbeddedControllerFixture::new();
    fixture.prepare_authority("page-target", &[]);
    let mut command = fixture.command_for("safe", "page-target", "GET", "/v1/snapshot", None);
    command.0.env_remove(APPROVAL_TIMEOUT_MS_ENV);
    let (output, requests) = fixture.decide_prepared(command, &["deny"]);
    assert!(!output.status.success());
    assert_eq!(requests.len(), 1);
    let lifetime = requests[0]["expiresAtMs"].as_u64().unwrap()
        - requests[0]["requestedAtMs"].as_u64().unwrap();
    // Measured from the call's start, so a few milliseconds already passed.
    assert!(
        lifetime <= 120_000 && lifetime > 119_000,
        "lifetime {lifetime}"
    );
}

#[test]
fn a_site_prompt_and_its_step_prompt_share_one_deadline() {
    use std::time::{Duration, Instant};

    let fixture = EmbeddedControllerFixture::new();
    fixture.prepare_authority("page-target", &[]);
    let mut child = fixture
        .command_for(
            "safe",
            "page-target",
            "POST",
            "/v1/navigate",
            Some(r#"{"url":"https://new.example/x"}"#),
        )
        .spawn()
        .expect("spawn Ask-mode navigation");
    let started = Instant::now();
    let mut requests: Vec<JsonValue> = Vec::new();
    while child.try_wait().expect("poll controller").is_none() {
        if let Some(request) = fixture.pending_request()
            && requests
                .last()
                .is_none_or(|last| last["approvalId"] != request["approvalId"])
        {
            if requests.is_empty() {
                // The person takes a while with the site prompt.
                std::thread::sleep(Duration::from_millis(400));
                fixture.answer(&request, "allow_origin");
            } else {
                fixture.answer(&request, "deny");
            }
            requests.push(request);
        }
        assert!(
            started.elapsed() < Duration::from_secs(5),
            "fixture timed out"
        );
        std::thread::sleep(Duration::from_millis(5));
    }
    let output = child.wait_with_output().expect("controller output");
    assert!(String::from_utf8_lossy(&output.stderr).contains("approval_denied"));
    assert_eq!(requests.len(), 2);
    assert_eq!(requests[0]["kind"], "origin");
    assert_eq!(requests[1]["kind"], "action");
    // The step prompt ends when the site prompt would have: the late answer
    // did not buy the call a second full window.
    assert_eq!(requests[1]["expiresAtMs"], requests[0]["expiresAtMs"]);
    let step_window = requests[1]["expiresAtMs"].as_u64().unwrap()
        - requests[1]["requestedAtMs"].as_u64().unwrap();
    assert!(step_window <= 5_000 - 400, "step window {step_window}");
}

#[test]
fn an_unanswered_prompt_ends_the_turn_without_reading_as_a_denial() {
    let unanswered = terminal_consent_call_result("approval_timeout");
    assert_ne!(unanswered.is_error, Some(true));
    let text = serde_json::to_string(&unanswered.content).expect("content JSON");
    assert!(text.contains("has not answered"), "{text}");
    assert!(text.contains("End this turn now"), "{text}");
    assert!(text.contains("do not retry"), "{text}");
    let signal = unanswered
        .structured_content
        .expect("terminal consent signal")["terminalConsent"]
        .clone();
    assert_eq!(
        signal,
        json!({
            "state": "blocked",
            "terminal": true,
            "retryable": false,
            "code": "approval_timeout",
        })
    );

    let denied = terminal_consent_call_result("approval_denied");
    assert_eq!(denied.is_error, Some(true));
    assert_eq!(
        denied.structured_content.expect("terminal consent signal")["terminalConsent"]["code"],
        "approval_denied"
    );
}

#[tokio::test]
async fn an_unanswered_prompt_still_blocks_every_later_browser_call() {
    let server = SharedBrowserMcpServer::new();
    let click = mcp_tool_request(
        "click",
        json!({ "index": 0, "snapshotId": SNAPSHOT_ID })
            .as_object()
            .cloned(),
    )
    .unwrap();
    let first = server
        .execute_with_failure_latch(&click, || async {
            Err(anyhow::anyhow!(
                "Shared Browser approval timed out [approval_timeout_non_retryable]"
            ))
        })
        .await;
    assert!(matches!(
        first,
        Err(SharedBrowserMcpExecutionFailure::TerminalConsent(
            "approval_timeout"
        ))
    ));
    let navigate = mcp_tool_request(
        "navigate",
        json!({ "url": "https://example.test/" })
            .as_object()
            .cloned(),
    )
    .unwrap();
    let later = server
        .execute_with_failure_latch(&navigate, || async {
            panic!("an unanswered prompt must not open another one in this turn")
        })
        .await;
    assert!(matches!(
        later,
        Err(SharedBrowserMcpExecutionFailure::TerminalConsent(
            "approval_timeout"
        ))
    ));
}
