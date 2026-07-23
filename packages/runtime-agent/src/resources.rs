use std::path::{Path, PathBuf};
use std::time::{Duration, Instant};

use serde::Serialize;
use sysinfo::{Disks, System};

const MAX_REASONABLE_DISK_BYTES: u64 = 20 * 1024 * 1024 * 1024 * 1024; // 20 TB
const CGROUP_V2_CPU_STAT: &str = "/sys/fs/cgroup/cpu.stat";
const CGROUP_V2_CPU_MAX: &str = "/sys/fs/cgroup/cpu.max";
const CGROUP_V1_CPU_QUOTA: &str = "/sys/fs/cgroup/cpu/cpu.cfs_quota_us";
const CGROUP_V1_CPU_PERIOD: &str = "/sys/fs/cgroup/cpu/cpu.cfs_period_us";
const CGROUP_V1_CPUACCT_USAGE: &str = "/sys/fs/cgroup/cpuacct/cpuacct.usage";
const CGROUP_V1_CPUACCT_USAGE_ALT: &str = "/sys/fs/cgroup/cpu,cpuacct/cpuacct.usage";

#[derive(Clone, Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct RuntimeResourceUsagePayload {
    #[serde(skip_serializing_if = "Option::is_none")]
    pub cpu_pct: Option<f64>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub cpu_limit_cores: Option<f64>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub memory_used_bytes: Option<u64>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub memory_limit_bytes: Option<u64>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub disk_used_bytes: Option<u64>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub disk_limit_bytes: Option<u64>,
}

pub struct ResourceSampler {
    system: System,
    disks: Disks,
    workspace_root: PathBuf,
    last_cpu_usage_usec: Option<u64>,
    last_cpu_sample_at: Option<Instant>,
}

impl ResourceSampler {
    pub fn new(workspace_root: PathBuf) -> Self {
        let mut system = System::new();
        system.refresh_cpu();
        system.refresh_memory();
        let disks = Disks::new_with_refreshed_list();

        Self {
            system,
            disks,
            workspace_root,
            last_cpu_usage_usec: None,
            last_cpu_sample_at: None,
        }
    }

    pub fn sample(&mut self) -> RuntimeResourceUsagePayload {
        let cpu_limit_cores = read_cpu_limit_cores();
        let cpu_pct = self
            .sample_cgroup_cpu_pct(cpu_limit_cores)
            .or_else(|| sample_sysinfo_cpu_pct(&mut self.system));
        self.system.refresh_memory();
        self.disks.refresh();

        let (memory_used_bytes, memory_limit_bytes) = match self
            .system
            .cgroup_limits()
            .filter(|limits| limits.total_memory > 0)
        {
            Some(limits) => {
                let used = limits.total_memory.saturating_sub(limits.free_memory);
                (Some(used), Some(limits.total_memory))
            }
            None => (
                Some(self.system.used_memory()),
                Some(self.system.total_memory()),
            ),
        };

        let (disk_used_bytes, disk_limit_bytes) =
            match best_disk_for_path(&self.disks, &self.workspace_root) {
                Some(disk) => {
                    let total = disk.total_space();
                    let available = disk.available_space();
                    (Some(total.saturating_sub(available)), Some(total))
                }
                None => (None, None),
            };

        RuntimeResourceUsagePayload {
            cpu_pct,
            cpu_limit_cores,
            memory_used_bytes,
            memory_limit_bytes,
            disk_used_bytes,
            disk_limit_bytes,
        }
    }

    fn sample_cgroup_cpu_pct(&mut self, cpu_limit_cores: Option<f64>) -> Option<f64> {
        let usage_usec = read_cgroup_cpu_usage_usec()?;
        let now = Instant::now();
        let previous_usage = self.last_cpu_usage_usec.replace(usage_usec);
        let previous_at = self.last_cpu_sample_at.replace(now);
        let (previous_usage, previous_at) = (previous_usage?, previous_at?);

        let elapsed_usec = now.duration_since(previous_at).as_micros() as f64;
        if elapsed_usec <= 0.0 {
            return None;
        }
        let delta_usage_usec = usage_usec.saturating_sub(previous_usage) as f64;

        let cores = cpu_limit_cores.or_else(|| {
            let count = self.system.cpus().len();
            if count == 0 { None } else { Some(count as f64) }
        })?;
        if !cores.is_finite() || cores <= 0.0 {
            return None;
        }

        let pct = (delta_usage_usec / (elapsed_usec * cores)) * 100.0;
        Some(pct.max(0.0).min(100.0))
    }
}

fn read_cgroup_cpu_usage_usec() -> Option<u64> {
    // cgroup v2: `cpu.stat` includes `usage_usec`.
    if let Ok(raw) = std::fs::read_to_string(CGROUP_V2_CPU_STAT) {
        for line in raw.lines() {
            let mut parts = line.split_whitespace();
            let key = parts.next().unwrap_or_default();
            if key == "usage_usec" {
                return parts.next()?.parse::<u64>().ok();
            }
            if key == "usage_nsec" {
                let nanos = parts.next()?.parse::<u64>().ok()?;
                return Some(nanos / 1_000);
            }
        }
    }

    // cgroup v1: `cpuacct.usage` is in nanoseconds.
    for path in [CGROUP_V1_CPUACCT_USAGE, CGROUP_V1_CPUACCT_USAGE_ALT] {
        if let Ok(raw) = std::fs::read_to_string(path) {
            let nanos = raw.trim().parse::<u64>().ok()?;
            return Some(nanos / 1_000);
        }
    }

    None
}

fn sample_sysinfo_cpu_pct(system: &mut System) -> Option<f64> {
    system.refresh_cpu();
    std::thread::sleep(Duration::from_millis(75));
    system.refresh_cpu();
    let usage = system.global_cpu_info().cpu_usage() as f64;
    Some(usage.max(0.0).min(100.0))
}

fn read_cpu_limit_cores() -> Option<f64> {
    // cgroup v2: "max 100000" or "<quota> <period>"
    if let Ok(raw) = std::fs::read_to_string(CGROUP_V2_CPU_MAX) {
        let mut parts = raw.split_whitespace();
        let quota = parts.next().unwrap_or_default();
        let period = parts.next().unwrap_or_default();
        if quota.eq_ignore_ascii_case("max") {
            return None;
        }
        let quota_us: f64 = quota.parse::<f64>().ok()?;
        let period_us: f64 = period.parse::<f64>().ok()?;
        if quota_us <= 0.0 || period_us <= 0.0 {
            return None;
        }
        let cores = quota_us / period_us;
        if cores.is_finite() && cores > 0.0 {
            return Some(cores);
        }
        return None;
    }

    // cgroup v1: cpu.cfs_quota_us and cpu.cfs_period_us
    let quota_raw = std::fs::read_to_string(CGROUP_V1_CPU_QUOTA).ok()?;
    let period_raw = std::fs::read_to_string(CGROUP_V1_CPU_PERIOD).ok()?;
    let quota_us = quota_raw.trim().parse::<f64>().ok()?;
    let period_us = period_raw.trim().parse::<f64>().ok()?;
    if quota_us <= 0.0 || period_us <= 0.0 {
        return None;
    }
    let cores = quota_us / period_us;
    if cores.is_finite() && cores > 0.0 {
        return Some(cores);
    }
    None
}

fn best_disk_for_path<'a>(disks: &'a Disks, target: &Path) -> Option<&'a sysinfo::Disk> {
    let mut best: Option<&sysinfo::Disk> = None;
    let mut best_len = 0usize;

    for disk in disks.list() {
        let mount = disk.mount_point();
        if !target.starts_with(mount) {
            continue;
        }

        let total = disk.total_space();
        let available = disk.available_space();
        if total == 0 || available > total || total > MAX_REASONABLE_DISK_BYTES {
            continue;
        }

        let len = mount.as_os_str().len();
        if len > best_len {
            best = Some(disk);
            best_len = len;
        }
    }

    best
}
