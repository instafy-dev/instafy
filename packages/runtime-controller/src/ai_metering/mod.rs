//! Managed AI metering: the proxy reports the exact usage of every request it
//! makes on the platform key, and the controller prices it per job.

pub(crate) mod job_record;
// Nothing outside the tests prices a request until the settle endpoint lands.
#[cfg_attr(not(test), allow(dead_code))]
pub(crate) mod pricing;
