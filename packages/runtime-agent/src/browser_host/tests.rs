use super::mode::{
    self, ATTESTATION_KEY, LazyMode, ModeInputs, force_lazy_mode_for_tests, lazy_env_overrides,
    resolve_lazy_mode,
};
use super::*;
use serde_json::json;
use uuid::Uuid;

fn attested_inputs(lease: Uuid) -> ModeInputs {
    ModeInputs {
        is_linux: true,
        browser_session: Some("0".to_string()),
        metadata: Some(
            json!({
                "env": { "INSTAFY_ENABLE_BROWSER_SESSION": "0" },
                ATTESTATION_KEY: {
                    "version": 1,
                    "mode": "lazy",
                    "generation": lease.to_string(),
                },
            })
            .to_string(),
        ),
        lease_id: Some(lease.to_string()),
        persist: Some("1".to_string()),
        stack_present: true,
    }
}

#[test]
fn lazy_mode_needs_the_attestation_for_this_exact_lease() {
    let lease = Uuid::new_v4();
    assert_eq!(
        resolve_lazy_mode(&attested_inputs(lease)),
        Some(LazyMode { persist: true })
    );
    let mut no_persist = attested_inputs(lease);
    no_persist.persist = None;
    assert_eq!(
        resolve_lazy_mode(&no_persist),
        Some(LazyMode { persist: false })
    );

    let attestation = |value: serde_json::Value| {
        let mut inputs = attested_inputs(lease);
        inputs.metadata = Some(json!({ ATTESTATION_KEY: value }).to_string());
        inputs
    };
    let generation = lease.to_string();
    let refused = [
        (
            "wrong version",
            attestation(json!({"version": 2, "mode": "lazy", "generation": generation})),
        ),
        (
            "version as a string",
            attestation(json!({"version": "1", "mode": "lazy", "generation": generation})),
        ),
        (
            "wrong mode",
            attestation(json!({"version": 1, "mode": "eager", "generation": generation})),
        ),
        (
            "an earlier lease's generation",
            attestation(
                json!({"version": 1, "mode": "lazy", "generation": Uuid::new_v4().to_string()}),
            ),
        ),
        (
            "no generation",
            attestation(json!({"version": 1, "mode": "lazy"})),
        ),
        ("not an object", attestation(json!("lazy"))),
        ("missing lease id", {
            let mut inputs = attested_inputs(lease);
            inputs.lease_id = None;
            inputs
        }),
        ("unparseable lease id", {
            let mut inputs = attested_inputs(lease);
            inputs.lease_id = Some("lease".to_string());
            inputs
        }),
        ("no metadata", {
            let mut inputs = attested_inputs(lease);
            inputs.metadata = None;
            inputs
        }),
        ("invalid metadata", {
            let mut inputs = attested_inputs(lease);
            inputs.metadata = Some("{".to_string());
            inputs
        }),
        ("the boot-time browser session", {
            let mut inputs = attested_inputs(lease);
            inputs.browser_session = Some(" TRUE ".to_string());
            inputs
        }),
        ("the stack missing", {
            let mut inputs = attested_inputs(lease);
            inputs.stack_present = false;
            inputs
        }),
        ("not Linux", {
            let mut inputs = attested_inputs(lease);
            inputs.is_linux = false;
            inputs
        }),
    ];
    for (case, inputs) in refused {
        assert_eq!(resolve_lazy_mode(&inputs), None, "{case}");
    }
}

#[test]
fn lazy_overrides_fix_ports_and_close_relay_and_unsafe_egress() {
    let overrides = lazy_env_overrides(|key| {
        (key == "INSTAFY_BROWSER_PREFERRED_VIEWER").then(|| "webrtc".to_string())
    });
    let value = |key: &str| {
        overrides
            .iter()
            .find(|(name, _)| *name == key)
            .map(|(_, value)| value.clone())
    };
    assert_eq!(
        value("INSTAFY_PLAYWRIGHT_CDP_PORT"),
        Some(Some("19223".into()))
    );
    assert_eq!(value("INSTAFY_PLAYWRIGHT_CDP_URL"), Some(None));
    assert_eq!(value("INSTAFY_VNC_HOST"), Some(Some("127.0.0.1".into())));
    assert_eq!(value("INSTAFY_VNC_PORT"), Some(Some("15900".into())));
    assert_eq!(
        value("INSTAFY_BROWSER_WEBRTC_ENABLED"),
        Some(Some("0".into()))
    );
    assert_eq!(value("INSTAFY_BROWSER_WEBRTC_REQUIRE_TURN"), Some(None));
    assert_eq!(value("INSTAFY_BROWSER_WEBRTC_ICE_SERVERS_JSON"), Some(None));
    assert_eq!(
        value("INSTAFY_BROWSER_EGRESS_ISOLATION"),
        Some(Some("1".into()))
    );
    assert_eq!(value("INSTAFY_BROWSER_EGRESS_ALLOW_UNSAFE_DEV"), Some(None));
    assert_eq!(
        value("INSTAFY_BROWSER_PREFERRED_VIEWER"),
        Some(Some("cdp-screencast".into()))
    );
    assert_eq!(
        value("INSTAFY_SHARED_BROWSER_NODE_BINARY"),
        Some(Some(mode::HOST_NODE_BINARY.into()))
    );

    let other_viewer = lazy_env_overrides(|key| {
        (key == "INSTAFY_BROWSER_PREFERRED_VIEWER").then(|| "rfb".to_string())
    });
    assert!(
        !other_viewer
            .iter()
            .any(|(key, _)| *key == "INSTAFY_BROWSER_PREFERRED_VIEWER")
    );
}

/// The capture mutates the process environment, so it runs in an isolated
/// test process that runs only this test, once lazy and once not.
#[test]
fn capture_sets_the_host_environment_only_in_lazy_mode() {
    const CHILD_MARKER: &str = "INSTAFY_BROWSER_HOST_MODE_TEST_CHILD";
    const TEST_NAME: &str =
        "browser_host::tests::capture_sets_the_host_environment_only_in_lazy_mode";
    let preset = [
        ("INSTAFY_PLAYWRIGHT_CDP_PORT", "9223"),
        ("INSTAFY_PLAYWRIGHT_CDP_URL", "http://127.0.0.1:9223"),
        ("INSTAFY_BROWSER_WEBRTC_ENABLED", "1"),
        ("INSTAFY_BROWSER_WEBRTC_REQUIRE_TURN", "1"),
        (
            "INSTAFY_BROWSER_WEBRTC_ICE_SERVERS_JSON",
            "[{\"urls\":\"turn:relay\"}]",
        ),
        ("INSTAFY_BROWSER_EGRESS_ISOLATION", "0"),
        ("INSTAFY_BROWSER_EGRESS_ALLOW_UNSAFE_DEV", "1"),
        ("INSTAFY_BROWSER_PREFERRED_VIEWER", "webrtc"),
    ];

    let Some(variant) = std::env::var_os(CHILD_MARKER) else {
        for variant in ["lazy", "off"] {
            let mut child = std::process::Command::new(
                std::env::current_exe().expect("resolve runtime-agent test executable"),
            );
            child.args(["--exact", TEST_NAME, "--nocapture"]);
            child.env(CHILD_MARKER, variant);
            child.envs(preset);
            child.env_remove("INSTAFY_ENABLE_BROWSER_SESSION");
            let output = child.output().expect("run isolated browser host mode test");
            assert!(
                output.status.success()
                    && String::from_utf8_lossy(&output.stdout)
                        .contains("test result: ok. 1 passed"),
                "isolated {variant} test failed or did not run exactly once\nstdout:\n{}\nstderr:\n{}",
                String::from_utf8_lossy(&output.stdout),
                String::from_utf8_lossy(&output.stderr)
            );
        }
        return;
    };

    let lease = Uuid::new_v4();
    let lazy = variant == "lazy";
    let mut inputs = attested_inputs(lease);
    inputs.stack_present = lazy;
    // SAFETY: this isolated process runs only this test.
    unsafe { mode::capture_with(inputs, "/usr/local/bin/runtime-entrypoint".into()) }
        .expect("capture the mode");
    assert_eq!(lazy_mode(), lazy);
    let env = |key: &str| std::env::var(key).ok();
    if lazy {
        assert_eq!(env("INSTAFY_PLAYWRIGHT_CDP_PORT").as_deref(), Some("19223"));
        assert_eq!(env("INSTAFY_PLAYWRIGHT_CDP_URL"), None);
        assert_eq!(env("INSTAFY_VNC_HOST").as_deref(), Some("127.0.0.1"));
        assert_eq!(env("INSTAFY_VNC_PORT").as_deref(), Some("15900"));
        assert_eq!(env("INSTAFY_BROWSER_WEBRTC_ENABLED").as_deref(), Some("0"));
        assert_eq!(env("INSTAFY_BROWSER_WEBRTC_REQUIRE_TURN"), None);
        assert_eq!(env("INSTAFY_BROWSER_WEBRTC_ICE_SERVERS_JSON"), None);
        assert_eq!(
            env("INSTAFY_BROWSER_EGRESS_ISOLATION").as_deref(),
            Some("1")
        );
        assert_eq!(env("INSTAFY_BROWSER_EGRESS_ALLOW_UNSAFE_DEV"), None);
        assert_eq!(
            env("INSTAFY_BROWSER_PREFERRED_VIEWER").as_deref(),
            Some("cdp-screencast")
        );
        assert_eq!(
            env("INSTAFY_PLAYWRIGHT_PROFILE_DIR").as_deref(),
            Some("/var/lib/instafy/browser-host/profile")
        );
        assert_eq!(
            env("INSTAFY_SHARED_BROWSER_PLAYWRIGHT_PATH").as_deref(),
            Some(mode::HOST_PLAYWRIGHT_PATH)
        );
        assert_eq!(
            env("INSTAFY_SHARED_BROWSER_TRUSTED_NODE_MODULES_ROOT").as_deref(),
            Some(mode::HOST_NODE_MODULES_ROOT)
        );
        assert_eq!(
            env("INSTAFY_SHARED_BROWSER_NODE_BINARY").as_deref(),
            Some(mode::HOST_NODE_BINARY)
        );
        assert!(shared_browser_capability_is_present());
        assert_eq!(
            registration_capability(),
            Some(json!({ "version": 1, "modes": ["lazy"] }))
        );
    } else {
        for (key, value) in preset {
            assert_eq!(env(key).as_deref(), Some(value), "{key} changed");
        }
        assert_eq!(env("INSTAFY_SHARED_BROWSER_NODE_BINARY"), None);
        assert!(!shared_browser_capability_is_present());
        assert_eq!(registration_capability(), None);
    }
    // SAFETY: as above.
    assert!(
        unsafe { mode::capture_with(attested_inputs(lease), "/entrypoint".into()) }.is_err(),
        "the mode is captured once"
    );
}

#[test]
fn the_capability_is_static_and_never_means_ready() {
    {
        let _lazy = force_lazy_mode_for_tests(Some(LazyMode { persist: true }));
        assert!(lazy_mode());
        assert!(shared_browser_capability_is_present());
        assert!(!is_ready(), "no host is installed, so nothing is Ready");
        assert_eq!(
            registration_capability(),
            Some(json!({ "version": 1, "modes": ["lazy"] }))
        );
    }
    let _off = force_lazy_mode_for_tests(None);
    assert!(!lazy_mode());
    assert_eq!(registration_capability(), None);
}

#[test]
fn without_a_host_every_entry_point_is_inert() {
    let _off = force_lazy_mode_for_tests(None);
    assert!(origin_handle().is_none());
    assert!(job_activity().is_none());
    assert!(!is_ready());
    poison();
    kill_now();
}

#[test]
fn the_job_gate_keeps_legacy_routing_and_refuses_a_closed_host() {
    // Ordinary turns are never gated.
    {
        let _lazy = force_lazy_mode_for_tests(Some(LazyMode { persist: false }));
        assert!(admit_shared_browser_job(false, false).unwrap().is_none());
    }
    // Legacy: a boot-time browser session admits; anything else keeps the old refusal.
    {
        let _off = force_lazy_mode_for_tests(None);
        assert!(admit_shared_browser_job(true, true).unwrap().is_none());
        let error = admit_shared_browser_job(true, false).unwrap_err();
        assert_eq!(
            error.to_string(),
            "Shared Browser job was routed to a runtime without INSTAFY_ENABLE_BROWSER_SESSION"
        );
    }
    // Lazy without a Ready host refuses with the person-facing text.
    let _lazy = force_lazy_mode_for_tests(Some(LazyMode { persist: false }));
    let error = admit_shared_browser_job(true, false).unwrap_err();
    assert_eq!(
        error.to_string(),
        "Instafy's browser is not open on this space's machine. Open it, then try again."
    );
}
