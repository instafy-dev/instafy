use std::io;

const PARENT_DISPOSITION_ENV: &str = "INSTAFY_RUNTIME_PARENT_DISPOSITION";

#[cfg(windows)]
pub struct ParentOwnedProcessTreeGuard {
    job: windows_sys::Win32::Foundation::HANDLE,
}

#[cfg(not(windows))]
pub struct ParentOwnedProcessTreeGuard;

#[cfg(windows)]
impl Drop for ParentOwnedProcessTreeGuard {
    fn drop(&mut self) {
        // Closing the final non-inherited handle activates
        // JOB_OBJECT_LIMIT_KILL_ON_JOB_CLOSE for every descendant.
        unsafe {
            windows_sys::Win32::Foundation::CloseHandle(self.job);
        }
    }
}

fn parent_disposition_requested(value: Option<&std::ffi::OsStr>) -> bool {
    value.is_some_and(|value| {
        let value = value.to_string_lossy();
        value == "1" || value.eq_ignore_ascii_case("true")
    })
}

/// On Windows, bind an Electron-owned runtime and every process it spawns to
/// one OS-enforced lifetime before Codex can start. Setup failures are fatal:
/// continuing would let a root crash orphan a writer that Electron cannot
/// identify safely after parent PID reuse.
pub fn install_parent_owned_process_tree_guard() -> io::Result<Option<ParentOwnedProcessTreeGuard>>
{
    if !parent_disposition_requested(std::env::var_os(PARENT_DISPOSITION_ENV).as_deref()) {
        return Ok(None);
    }

    #[cfg(windows)]
    {
        use std::ffi::c_void;
        use std::mem::size_of;
        use std::ptr;
        use windows_sys::Win32::System::JobObjects::{
            AssignProcessToJobObject, CreateJobObjectW, JOB_OBJECT_LIMIT_KILL_ON_JOB_CLOSE,
            JOBOBJECT_EXTENDED_LIMIT_INFORMATION, JobObjectExtendedLimitInformation,
            SetInformationJobObject,
        };
        use windows_sys::Win32::System::Threading::GetCurrentProcess;

        let job = unsafe { CreateJobObjectW(ptr::null(), ptr::null()) };
        if job.is_null() {
            return Err(io::Error::last_os_error());
        }
        let guard = ParentOwnedProcessTreeGuard { job };
        let mut limits = JOBOBJECT_EXTENDED_LIMIT_INFORMATION::default();
        limits.BasicLimitInformation.LimitFlags = JOB_OBJECT_LIMIT_KILL_ON_JOB_CLOSE;
        let configured = unsafe {
            SetInformationJobObject(
                job,
                JobObjectExtendedLimitInformation,
                (&limits as *const JOBOBJECT_EXTENDED_LIMIT_INFORMATION).cast::<c_void>(),
                size_of::<JOBOBJECT_EXTENDED_LIMIT_INFORMATION>() as u32,
            )
        };
        if configured == 0 {
            return Err(io::Error::last_os_error());
        }
        if unsafe { AssignProcessToJobObject(job, GetCurrentProcess()) } == 0 {
            return Err(io::Error::last_os_error());
        }
        return Ok(Some(guard));
    }

    #[cfg(not(windows))]
    Ok(None)
}

#[cfg(target_os = "linux")]
const CAP_SYS_PTRACE_BIT: u32 = 19;

#[cfg(target_os = "linux")]
const REQUIRED_CAPABILITY_FIELDS: [&str; 3] = ["CapEff", "CapPrm", "CapBnd"];

#[cfg(target_os = "linux")]
const CAP_SETPCAP_BIT: u32 = 8;

#[cfg(target_os = "linux")]
const CAP_SETFCAP_BIT: u32 = 31;

/// Protect the long-lived runtime-agent process before any model-controlled
/// subprocess can start.
///
/// On Linux, `/proc/<pid>/environ` is guarded by the ptrace access check. A
/// non-dumpable target fails that check even for the same UID, unless the
/// reader has `CAP_SYS_PTRACE`. Runtime containers must therefore continue to
/// drop that capability. The setting applies to this process for its lifetime;
/// a child `execve` may reset the child's own dumpable state, which is safe
/// because model subprocess environments are separately scrubbed.
pub fn harden_runtime_process() -> io::Result<()> {
    #[cfg(target_os = "linux")]
    {
        reject_ptrace_capability(&std::fs::read_to_string("/proc/self/status")?)?;
        codex_process_hardening::disable_process_dumping()?;
    }

    Ok(())
}

#[cfg(target_os = "linux")]
fn reject_ptrace_capability(status: &str) -> io::Result<()> {
    let mut masks = std::collections::HashMap::new();
    for field in REQUIRED_CAPABILITY_FIELDS {
        let encoded = status
            .lines()
            .find_map(|line| {
                let (name, value) = line.split_once(':')?;
                (name == field).then_some(value.trim())
            })
            .ok_or_else(|| {
                io::Error::new(
                    io::ErrorKind::InvalidData,
                    format!("/proc/self/status is missing {field}"),
                )
            })?;
        let capabilities = u64::from_str_radix(encoded, 16).map_err(|error| {
            io::Error::new(
                io::ErrorKind::InvalidData,
                format!("invalid {field} capability mask: {error}"),
            )
        })?;
        masks.insert(field, capabilities);
    }

    let effective = masks["CapEff"];
    let permitted = masks["CapPrm"];
    let bounding = masks["CapBnd"];
    for (field, capabilities) in [("CapEff", effective), ("CapPrm", permitted)] {
        if capabilities & (1_u64 << CAP_SYS_PTRACE_BIT) != 0 {
            return Err(io::Error::new(
                io::ErrorKind::PermissionDenied,
                format!(
                    "runtime process has CAP_SYS_PTRACE in {field}; remove privileged mode and drop SYS_PTRACE"
                ),
            ));
        }
    }

    let effective_uid = status
        .lines()
        .find_map(|line| line.strip_prefix("Uid:"))
        .and_then(|value| value.split_whitespace().nth(1))
        .ok_or_else(|| {
            io::Error::new(
                io::ErrorKind::InvalidData,
                "/proc/self/status is missing effective Uid",
            )
        })?
        .parse::<u32>()
        .map_err(|error| {
            io::Error::new(
                io::ErrorKind::InvalidData,
                format!("invalid effective Uid: {error}"),
            )
        })?;
    let can_plausibly_acquire_file_capability = effective_uid == 0
        || permitted & ((1_u64 << CAP_SETPCAP_BIT) | (1_u64 << CAP_SETFCAP_BIT)) != 0;
    if can_plausibly_acquire_file_capability && bounding & (1_u64 << CAP_SYS_PTRACE_BIT) != 0 {
        return Err(io::Error::new(
            io::ErrorKind::PermissionDenied,
            "runtime process can acquire CAP_SYS_PTRACE from CapBnd; drop SYS_PTRACE",
        ));
    }

    Ok(())
}

#[cfg(all(test, target_os = "linux"))]
mod tests {
    use std::io::{self, BufRead, BufReader, Write};
    use std::process::{Command, Stdio};
    use std::time::Duration;

    use super::{CAP_SYS_PTRACE_BIT, harden_runtime_process};

    const CHILD_PROBE_ENV: &str = "INSTAFY_PROCESS_HARDENING_CHILD_PROBE";
    const INITIAL_SECRET_ENV: &str = "INSTAFY_PROCESS_HARDENING_INITIAL_SECRET";
    const READY_MARKER: &str = "INSTAFY_PROCESS_HARDENING_READY";

    #[test]
    fn same_uid_process_cannot_read_hardened_initial_environment() {
        let test_binary = std::env::current_exe().expect("current test binary");
        let mut child = Command::new(test_binary)
            .args([
                "--exact",
                "process_hardening::tests::hardened_child_probe",
                "--nocapture",
            ])
            .env(CHILD_PROBE_ENV, "1")
            .env(INITIAL_SECRET_ENV, "must-not-be-readable")
            .stdout(Stdio::piped())
            .spawn()
            .expect("spawn hardened child probe");

        let stdout = child.stdout.take().expect("child stdout");
        let mut output = BufReader::new(stdout);
        let mut line = String::new();
        let mut ready = false;
        while output.read_line(&mut line).expect("read child output") != 0 {
            if line.contains(READY_MARKER) {
                ready = true;
                break;
            }
            line.clear();
        }
        assert!(ready, "hardened child exited before reporting readiness");

        let environ_path = format!("/proc/{}/environ", child.id());
        let read_result = std::fs::read(&environ_path);
        let has_ptrace_capability = effective_capabilities()
            .is_some_and(|capabilities| capabilities & (1_u64 << CAP_SYS_PTRACE_BIT) != 0);

        child.kill().expect("stop hardened child probe");
        child.wait().expect("reap hardened child probe");

        if !has_ptrace_capability {
            let error = read_result.expect_err(
                "a same-UID process without CAP_SYS_PTRACE read a non-dumpable process environ",
            );
            assert_eq!(
                error.kind(),
                io::ErrorKind::PermissionDenied,
                "unexpected error reading {environ_path}: {error}"
            );
        }
    }

    #[test]
    fn hardened_child_probe() {
        if std::env::var_os(CHILD_PROBE_ENV).is_none() {
            return;
        }

        harden_runtime_process().expect("harden child process");
        assert_eq!(
            unsafe { libc::prctl(libc::PR_GET_DUMPABLE) },
            0,
            "child process remained dumpable"
        );
        println!("{READY_MARKER}");
        std::io::stdout().flush().expect("flush ready marker");
        std::thread::sleep(Duration::from_secs(30));
    }

    fn effective_capabilities() -> Option<u64> {
        let status = std::fs::read_to_string("/proc/self/status").ok()?;
        let encoded = status
            .lines()
            .find_map(|line| line.strip_prefix("CapEff:\t"))?;
        u64::from_str_radix(encoded.trim(), 16).ok()
    }

    #[test]
    fn ptrace_capability_is_rejected_from_effective_permitted_or_bounding_sets() {
        let safe = "Uid:\t1000\t1000\t1000\t1000\nCapEff:\t0000000000000000\nCapPrm:\t0000000000000000\nCapBnd:\t00000000a80425fb\n";
        assert!(super::reject_ptrace_capability(safe).is_ok());

        for field in ["CapEff", "CapPrm"] {
            let status = format!(
                "Uid:\t1000\t1000\t1000\t1000\nCapEff:\t{}\nCapPrm:\t{}\nCapBnd:\t0\n",
                if field == "CapEff" {
                    "0000000000080000"
                } else {
                    "0"
                },
                if field == "CapPrm" {
                    "0000000000080000"
                } else {
                    "0"
                },
            );
            let error = super::reject_ptrace_capability(&status)
                .expect_err("CAP_SYS_PTRACE must fail closed");
            assert_eq!(error.kind(), io::ErrorKind::PermissionDenied);
        }

        let harmless_non_root_bounding =
            "Uid:\t1000\t1000\t1000\t1000\nCapEff:\t0\nCapPrm:\t0\nCapBnd:\t0000000000080000\n";
        assert!(super::reject_ptrace_capability(harmless_non_root_bounding).is_ok());

        for status in [
            "Uid:\t0\t0\t0\t0\nCapEff:\t0\nCapPrm:\t0\nCapBnd:\t0000000000080000\n",
            "Uid:\t1000\t1000\t1000\t1000\nCapEff:\t0\nCapPrm:\t0000000080000000\nCapBnd:\t0000000000080000\n",
        ] {
            let error = super::reject_ptrace_capability(status)
                .expect_err("acquirable CAP_SYS_PTRACE bounding bit must fail closed");
            assert_eq!(error.kind(), io::ErrorKind::PermissionDenied);
        }
    }

    #[test]
    fn missing_capability_metadata_fails_closed() {
        let error = super::reject_ptrace_capability(
            "Uid:\t1000\t1000\t1000\t1000\nCapEff:\t0\nCapPrm:\t0\n",
        )
        .expect_err("missing bounding set must fail closed");
        assert_eq!(error.kind(), io::ErrorKind::InvalidData);
    }
}
