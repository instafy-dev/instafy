//! The networks the controller reaches a self-hosted runtime's origin on.
//!
//! A private self-hosted runtime (a person's own computer: Desktop,
//! `instafy runtime`, a runtime container they run themselves) registers its
//! origin's endpoint itself, and the controller then sends requests there:
//! the `/origin/*` relays, GitHub imports and the project memory bootstrap.
//! Unless the operator says the controller shares a network with those
//! runtimes (`SELF_HOSTED_ORIGIN_NETWORKS=private`), the controller connects to
//! such an endpoint only at public addresses, never on its own machine or
//! network: loopback, private (RFC 1918, IPv6 unique local), link-local,
//! carrier-grade NAT, unspecified, multicast, documentation, benchmarking and
//! other reserved addresses are refused. The IPv4 ranges are the browser
//! egress proxy's (`packages/browser-egress-proxy/policy.go`); IPv6 must also
//! be global unicast (`2000::/3`).
//!
//! The check is made where the connection is made. The client of
//! [`PublicOriginNetwork`] resolves every host name through
//! [`PublicAddressResolver`], which refuses the whole answer when any address
//! in it is not public, and hyper connects only to the addresses that resolver
//! returned. An IP literal never reaches a resolver, so callers check it first,
//! with [`check_literal`] or with [`PublicOriginNetwork::check`]. The latter
//! also resolves a name once, to give the requester a clear refusal and to
//! fail a name that does not resolve within the connect timeout before
//! anything is sent; the connection is checked again. A WebSocket relay
//! connects to the [`CheckedAddresses`] it was given before the upgrade. A
//! later DNS answer cannot change what the controller connects to after a
//! check.

use std::fmt;
use std::future::Future;
use std::io;
use std::net::{IpAddr, Ipv4Addr, Ipv6Addr, SocketAddr};
use std::pin::Pin;
use std::sync::Arc;
use std::time::Duration;

use reqwest::dns::{Addrs, Resolve, Resolving};
use tokio::net::TcpStream;
use url::{Host, Url};

use crate::proxy_read::ORIGIN_PROXY_CONNECT_TIMEOUT;

/// How long origin registration waits for an endpoint's name to resolve.
const REGISTRATION_LOOKUP_TIMEOUT: Duration = Duration::from_secs(3);

/// IPv4 ranges that are not public.
const NON_PUBLIC_IPV4: [(Ipv4Addr, u8); 15] = [
    (Ipv4Addr::new(0, 0, 0, 0), 8), // "this network", the unspecified address
    (Ipv4Addr::new(10, 0, 0, 0), 8), // private (RFC 1918)
    (Ipv4Addr::new(100, 64, 0, 0), 10), // carrier-grade NAT (RFC 6598)
    (Ipv4Addr::new(127, 0, 0, 0), 8), // loopback
    (Ipv4Addr::new(169, 254, 0, 0), 16), // link-local, cloud metadata
    (Ipv4Addr::new(172, 16, 0, 0), 12), // private (RFC 1918)
    (Ipv4Addr::new(192, 0, 0, 0), 24), // IETF protocol assignments
    (Ipv4Addr::new(192, 0, 2, 0), 24), // documentation
    (Ipv4Addr::new(192, 88, 99, 0), 24), // 6to4 relay anycast
    (Ipv4Addr::new(192, 168, 0, 0), 16), // private (RFC 1918)
    (Ipv4Addr::new(198, 18, 0, 0), 15), // benchmarking
    (Ipv4Addr::new(198, 51, 100, 0), 24), // documentation
    (Ipv4Addr::new(203, 0, 113, 0), 24), // documentation
    (Ipv4Addr::new(224, 0, 0, 0), 4), // multicast
    (Ipv4Addr::new(240, 0, 0, 0), 4), // reserved, limited broadcast
];

/// IPv6 global unicast. Everything outside it is refused on that ground
/// alone: unspecified, loopback, IPv4-compatible, NAT64, discard-only, unique
/// local, link-local, site-local and multicast.
const GLOBAL_UNICAST_IPV6: (Ipv6Addr, u8) = (Ipv6Addr::new(0x2000, 0, 0, 0, 0, 0, 0, 0), 3);

/// Ranges inside IPv6 global unicast that are not public.
const NON_PUBLIC_GLOBAL_IPV6: [(Ipv6Addr, u8); 4] = [
    // IETF protocol assignments: Teredo, benchmarking, ORCHID and the rest.
    (Ipv6Addr::new(0x2001, 0, 0, 0, 0, 0, 0, 0), 23),
    (Ipv6Addr::new(0x2001, 0xdb8, 0, 0, 0, 0, 0, 0), 32), // documentation
    (Ipv6Addr::new(0x2002, 0, 0, 0, 0, 0, 0, 0), 16),     // 6to4
    (Ipv6Addr::new(0x3fff, 0, 0, 0, 0, 0, 0, 0), 20),     // documentation (RFC 9637)
];

fn in_ipv4_range(address: Ipv4Addr, (network, prefix): (Ipv4Addr, u8)) -> bool {
    let mask = u32::MAX.checked_shl(32 - u32::from(prefix)).unwrap_or(0);
    u32::from(address) & mask == u32::from(network) & mask
}

fn in_ipv6_range(address: Ipv6Addr, (network, prefix): (Ipv6Addr, u8)) -> bool {
    let mask = u128::MAX.checked_shl(128 - u32::from(prefix)).unwrap_or(0);
    u128::from(address) & mask == u128::from(network) & mask
}

/// An IPv4-mapped IPv6 address (`::ffff:a.b.c.d`) as the IPv4 address it
/// stands for, so it cannot pass the IPv4 ranges in IPv6 form.
fn unmapped(address: IpAddr) -> IpAddr {
    match address {
        IpAddr::V6(v6) => v6.to_ipv4_mapped().map_or(IpAddr::V6(v6), IpAddr::V4),
        v4 => v4,
    }
}

/// Whether `address` is an ordinary public unicast address.
pub(crate) fn is_public_address(address: IpAddr) -> bool {
    match unmapped(address) {
        IpAddr::V4(v4) => !NON_PUBLIC_IPV4
            .iter()
            .any(|range| in_ipv4_range(v4, *range)),
        IpAddr::V6(v6) => {
            in_ipv6_range(v6, GLOBAL_UNICAST_IPV6)
                && !NON_PUBLIC_GLOBAL_IPV6
                    .iter()
                    .any(|range| in_ipv6_range(v6, *range))
        }
    }
}

fn is_loopback_address(address: IpAddr) -> bool {
    unmapped(address).is_loopback()
}

/// Why the controller will not accept or connect to an origin's address.
#[derive(Debug)]
pub(crate) enum OriginAddressError {
    /// The host is, or resolves to, an address that is not public.
    NonPublic { host: String, address: IpAddr },
    /// The host has no address to check.
    Unresolved { host: String, source: io::Error },
}

impl fmt::Display for OriginAddressError {
    fn fmt(&self, formatter: &mut fmt::Formatter<'_>) -> fmt::Result {
        match self {
            // The address stays out of the message, which can reach the
            // requester: what the controller's resolver answers is its own.
            Self::NonPublic { host, .. } => {
                write!(formatter, "{host} is not at a public address")
            }
            Self::Unresolved { host, source } => {
                write!(formatter, "failed to resolve {host}: {source}")
            }
        }
    }
}

impl OriginAddressError {
    /// The address that is not public, when that is the reason. It belongs in
    /// the controller's log, never in an answer.
    pub(crate) fn address(&self) -> Option<IpAddr> {
        match self {
            Self::NonPublic { address, .. } => Some(*address),
            Self::Unresolved { .. } => None,
        }
    }
}

impl std::error::Error for OriginAddressError {
    fn source(&self) -> Option<&(dyn std::error::Error + 'static)> {
        match self {
            Self::NonPublic { .. } => None,
            Self::Unresolved { source, .. } => Some(source),
        }
    }
}

/// The address refused for not being public, when `error` or an error it was
/// caused by is such a refusal, as a request through [`PublicOriginNetwork::client`]
/// reports one.
pub(crate) fn refused_non_public_address(
    error: &(dyn std::error::Error + 'static),
) -> Option<IpAddr> {
    let mut current = Some(error);
    while let Some(error) = current {
        if let Some(address) = error
            .downcast_ref::<OriginAddressError>()
            .and_then(OriginAddressError::address)
        {
            return Some(address);
        }
        current = error.source();
    }
    None
}

type LookupFuture = Pin<Box<dyn Future<Output = io::Result<Vec<IpAddr>>> + Send>>;

/// Resolves host names: the system resolver in production, a script in tests.
pub(crate) trait HostLookup: Send + Sync {
    fn lookup(&self, host: &str) -> LookupFuture;
}

/// The system resolver (`getaddrinfo`), which reqwest's own resolver uses too.
pub(crate) struct SystemLookup;

impl HostLookup for SystemLookup {
    fn lookup(&self, host: &str) -> LookupFuture {
        let host = host.to_string();
        Box::pin(async move {
            Ok(tokio::net::lookup_host((host.as_str(), 0))
                .await?
                .map(|address| address.ip())
                .collect())
        })
    }
}

/// `addresses` for `host`, provided every one of them is public: one that is
/// not refuses them all, so a mixed answer cannot pass on its public half.
fn all_public(host: &str, addresses: Vec<IpAddr>) -> Result<Vec<IpAddr>, OriginAddressError> {
    if addresses.is_empty() {
        return Err(OriginAddressError::Unresolved {
            host: host.to_string(),
            source: io::Error::new(io::ErrorKind::NotFound, "no addresses"),
        });
    }
    match addresses
        .iter()
        .copied()
        .find(|address| !is_public_address(*address))
    {
        Some(address) => Err(OriginAddressError::NonPublic {
            host: host.to_string(),
            address,
        }),
        None => Ok(addresses),
    }
}

async fn resolve_public(
    lookup: &dyn HostLookup,
    host: &str,
) -> Result<Vec<IpAddr>, OriginAddressError> {
    let addresses = lookup
        .lookup(host)
        .await
        .map_err(|source| OriginAddressError::Unresolved {
            host: host.to_string(),
            source,
        })?;
    all_public(host, addresses)
}

/// A reqwest resolver that answers only with public addresses. hyper asks it
/// once for every new connection and connects only to what it returns.
pub(crate) struct PublicAddressResolver {
    lookup: Arc<dyn HostLookup>,
}

impl Resolve for PublicAddressResolver {
    fn resolve(&self, name: hyper014::client::connect::dns::Name) -> Resolving {
        let lookup = Arc::clone(&self.lookup);
        let host = name.as_str().to_string();
        Box::pin(async move {
            let addresses = resolve_public(lookup.as_ref(), &host).await?;
            let addrs: Addrs = Box::new(
                addresses
                    .into_iter()
                    .map(|address| SocketAddr::new(address, 0)),
            );
            Ok(addrs)
        })
    }
}

/// How the controller reaches a self-hosted origin when only public addresses
/// are allowed: the resolver it checks host names with, and a client whose
/// every connection goes through that resolver.
#[derive(Clone)]
pub(crate) struct PublicOriginNetwork {
    lookup: Arc<dyn HostLookup>,
    client: reqwest::Client,
}

impl PublicOriginNetwork {
    /// With the system resolver.
    pub(crate) fn system() -> reqwest::Result<Self> {
        Self::with_lookup(Arc::new(SystemLookup))
    }

    pub(crate) fn with_lookup(lookup: Arc<dyn HostLookup>) -> reqwest::Result<Self> {
        let client = reqwest::Client::builder()
            .user_agent("instafy-runtime-controller-origin-proxy")
            .redirect(reqwest::redirect::Policy::none())
            .no_proxy()
            .connect_timeout(ORIGIN_PROXY_CONNECT_TIMEOUT)
            .dns_resolver(Arc::new(PublicAddressResolver {
                lookup: Arc::clone(&lookup),
            }))
            .build()?;
        Ok(Self { lookup, client })
    }

    /// The client. It ignores proxy settings in the environment (a proxy
    /// would connect on the controller's behalf, past the check) and follows
    /// no redirect (an IP-literal location would skip the resolver). An IP
    /// literal reaches no resolver, so check the URL with [`Self::check`] or
    /// [`check_literal`] before sending.
    pub(crate) fn client(&self) -> &reqwest::Client {
        &self.client
    }

    pub(crate) fn lookup(&self) -> &dyn HostLookup {
        self.lookup.as_ref()
    }

    /// The addresses to connect to `url` at, every one of them public.
    pub(crate) async fn addresses(
        &self,
        url: &Url,
    ) -> Result<CheckedAddresses, PublicConnectError> {
        public_socket_addresses(self.lookup.as_ref(), url).await
    }

    /// Checks `url` once before a request, so the requester gets a clear
    /// answer: a host that is, or resolves to, an address that is not public
    /// is refused, and a name that does not resolve, or not within the
    /// connect timeout, fails here instead of being looked up again by the
    /// client. The client checks each connection it opens.
    pub(crate) async fn check(&self, url: &Url) -> Result<(), PublicConnectError> {
        self.addresses(url).await.map(|_| ())
    }
}

/// Refuses `url` before a request when its host is an IP literal that is not
/// public, and looks nothing up. A literal reaches no resolver, so only this
/// check stands before a connection to it; a name is left to the client,
/// whose resolver checks each connection it opens and refuses the same
/// addresses.
pub(crate) fn check_literal(url: &Url) -> Result<(), PublicConnectError> {
    let address = match url.host() {
        Some(Host::Ipv4(v4)) => IpAddr::V4(v4),
        Some(Host::Ipv6(v6)) => IpAddr::V6(v6),
        Some(Host::Domain(_)) | None => return Ok(()),
    };
    all_public(url.host_str().unwrap_or_default(), vec![address])
        .map(drop)
        .map_err(PublicConnectError::Refused)
}

/// Socket addresses that were public when they were checked. Only
/// [`PublicOriginNetwork::addresses`] makes them, so a connection to them
/// needs no second lookup that could answer differently.
#[derive(Clone, Debug)]
pub(crate) struct CheckedAddresses(Vec<SocketAddr>);

impl CheckedAddresses {
    #[cfg(test)]
    pub(crate) fn as_slice(&self) -> &[SocketAddr] {
        &self.0
    }

    /// A TCP connection to one of them, made the way the public-address
    /// client's connector (hyper's) makes one: see [`connect_to_first`].
    pub(crate) async fn connect(&self) -> Result<TcpStream, PublicConnectError> {
        connect_to_first(
            &self.0,
            ORIGIN_PROXY_CONNECT_TIMEOUT,
            OTHER_FAMILY_DELAY,
            TcpStream::connect::<SocketAddr>,
        )
        .await
    }
}

/// How long the addresses of the first address's family have before the
/// other family's are tried as well, as in hyper's connector.
const OTHER_FAMILY_DELAY: Duration = Duration::from_millis(300);

/// Connects to the first of `addresses` that answers, through `connect`, and
/// to no other address, within `timeout` in all. The addresses of the first
/// one's family are tried in turn, each with an equal share of `timeout`, so
/// one that never answers does not use up the rest's time. The other
/// family's are tried the same way from `other_family_delay` on, or as soon
/// as the first family's have all failed, and the first connection made is
/// used. This is how hyper's connector, and so the public-address client,
/// connects.
async fn connect_to_first<S, F, Fut>(
    addresses: &[SocketAddr],
    timeout: Duration,
    other_family_delay: Duration,
    connect: F,
) -> Result<S, PublicConnectError>
where
    F: Fn(SocketAddr) -> Fut,
    Fut: Future<Output = io::Result<S>>,
{
    let first_is_v6 = addresses.first().is_some_and(SocketAddr::is_ipv6);
    let (first_family, other_family): (Vec<SocketAddr>, Vec<SocketAddr>) = addresses
        .iter()
        .partition(|address| address.is_ipv6() == first_is_v6);
    let attempt = async {
        let first = connect_in_turn(&first_family, timeout, &connect);
        if other_family.is_empty() {
            return first.await;
        }
        let other = connect_in_turn(&other_family, timeout, &connect);
        let delay = tokio::time::sleep(other_family_delay);
        tokio::pin!(first, other, delay);
        tokio::select! {
            result = &mut first => match result {
                Ok(stream) => Ok(stream),
                Err(_) => other.await,
            },
            () = &mut delay => tokio::select! {
                result = &mut first => match result {
                    Ok(stream) => Ok(stream),
                    Err(_) => other.await,
                },
                result = &mut other => match result {
                    Ok(stream) => Ok(stream),
                    Err(_) => first.await,
                },
            },
        }
    };
    tokio::time::timeout(timeout, attempt)
        .await
        .unwrap_or(Err(PublicConnectError::TimedOut))
}

/// Connects to `addresses` one after another, each with an equal share of
/// `timeout`, and gives the first connection made or the last failure.
async fn connect_in_turn<S, F, Fut>(
    addresses: &[SocketAddr],
    timeout: Duration,
    connect: &F,
) -> Result<S, PublicConnectError>
where
    F: Fn(SocketAddr) -> Fut,
    Fut: Future<Output = io::Result<S>>,
{
    let share = timeout / u32::try_from(addresses.len()).unwrap_or(u32::MAX).max(1);
    let mut failure = PublicConnectError::Connect(io::Error::new(
        io::ErrorKind::NotConnected,
        "no address to connect to",
    ));
    for &address in addresses {
        match tokio::time::timeout(share, connect(address)).await {
            Ok(Ok(stream)) => return Ok(stream),
            Ok(Err(error)) => failure = PublicConnectError::Connect(error),
            Err(_) => failure = PublicConnectError::TimedOut,
        }
    }
    Err(failure)
}

/// Why the controller did not connect to an origin held to public addresses.
#[derive(Debug)]
pub(crate) enum PublicConnectError {
    Refused(OriginAddressError),
    Connect(io::Error),
    TimedOut,
}

impl fmt::Display for PublicConnectError {
    fn fmt(&self, formatter: &mut fmt::Formatter<'_>) -> fmt::Result {
        match self {
            Self::Refused(error) => write!(formatter, "{error}"),
            Self::Connect(error) => write!(formatter, "failed to connect: {error}"),
            Self::TimedOut => formatter.write_str("timed out connecting"),
        }
    }
}

impl std::error::Error for PublicConnectError {
    fn source(&self) -> Option<&(dyn std::error::Error + 'static)> {
        match self {
            Self::Refused(error) => Some(error),
            Self::Connect(error) => Some(error),
            Self::TimedOut => None,
        }
    }
}

/// The socket addresses for `url` when they are all public: its IP literal,
/// or every address its name resolves to, at its port.
async fn public_socket_addresses(
    lookup: &dyn HostLookup,
    url: &Url,
) -> Result<CheckedAddresses, PublicConnectError> {
    let host = url.host_str().unwrap_or_default();
    let unresolved = |reason: &str| {
        PublicConnectError::Refused(OriginAddressError::Unresolved {
            host: host.to_string(),
            source: io::Error::new(io::ErrorKind::InvalidInput, reason.to_string()),
        })
    };
    let port = url
        .port_or_known_default()
        .ok_or_else(|| unresolved("no port"))?;
    let addresses = match url.host() {
        Some(Host::Ipv4(v4)) => all_public(host, vec![IpAddr::V4(v4)]),
        Some(Host::Ipv6(v6)) => all_public(host, vec![IpAddr::V6(v6)]),
        Some(Host::Domain(name)) => {
            match tokio::time::timeout(ORIGIN_PROXY_CONNECT_TIMEOUT, resolve_public(lookup, name))
                .await
            {
                Ok(addresses) => addresses,
                Err(_) => return Err(PublicConnectError::TimedOut),
            }
        }
        None => return Err(unresolved("no host")),
    }
    .map_err(PublicConnectError::Refused)?;
    Ok(CheckedAddresses(
        addresses
            .into_iter()
            .map(|address| SocketAddr::new(address, port))
            .collect(),
    ))
}

/// Whether a private self-hosted runtime may register `endpoint` when only
/// public addresses are allowed. An address that is neither public nor
/// loopback refuses it, whether the endpoint names it or its name resolves to
/// it. Loopback is accepted: it is the runtime's own machine (Desktop
/// registers `http://127.0.0.1:<port>`), which the controller never connects
/// to. A name that does not resolve here is accepted too, since a browser may
/// still reach it directly; every connection the controller makes is checked
/// again.
pub(crate) async fn check_registration_endpoint(
    lookup: &dyn HostLookup,
    endpoint: &Url,
) -> Result<(), OriginAddressError> {
    let addresses = match endpoint.host() {
        Some(Host::Ipv4(v4)) => vec![IpAddr::V4(v4)],
        Some(Host::Ipv6(v6)) => vec![IpAddr::V6(v6)],
        Some(Host::Domain(name)) => {
            match tokio::time::timeout(REGISTRATION_LOOKUP_TIMEOUT, lookup.lookup(name)).await {
                Ok(Ok(addresses)) => addresses,
                Ok(Err(_)) | Err(_) => return Ok(()),
            }
        }
        None => return Ok(()),
    };
    match addresses
        .into_iter()
        .find(|address| !is_public_address(*address) && !is_loopback_address(*address))
    {
        Some(address) => Err(OriginAddressError::NonPublic {
            host: endpoint.host_str().unwrap_or_default().to_string(),
            address,
        }),
        None => Ok(()),
    }
}

/// Scripted name lookups and a counting listener, for the tests here and the
/// controller's tests of the call sites.
#[cfg(test)]
pub(crate) mod test_support {
    use super::*;
    use std::collections::HashMap;
    use std::sync::atomic::{AtomicUsize, Ordering};
    use std::sync::Mutex;

    use tokio::io::AsyncWriteExt;
    use tokio::net::TcpListener;

    /// Answers each name with the next answer scripted for it, and with the
    /// last one once the others are used; an unknown name does not resolve.
    #[derive(Default)]
    pub(crate) struct ScriptedLookup {
        answers: Mutex<HashMap<String, Vec<io::Result<Vec<IpAddr>>>>>,
        pub(crate) calls: AtomicUsize,
    }

    impl ScriptedLookup {
        pub(crate) fn answering(host: &str, answers: Vec<io::Result<Vec<IpAddr>>>) -> Arc<Self> {
            let lookup = Self::default();
            lookup
                .answers
                .lock()
                .unwrap()
                .insert(host.to_string(), answers);
            Arc::new(lookup)
        }

        pub(crate) fn always(host: &str, addresses: &[&str]) -> Arc<Self> {
            Self::answering(host, vec![Ok(ips(addresses))])
        }

        /// Also answers `host` with `addresses`, always.
        pub(crate) fn and(self: Arc<Self>, host: &str, addresses: &[&str]) -> Arc<Self> {
            self.answers
                .lock()
                .unwrap()
                .insert(host.to_string(), vec![Ok(ips(addresses))]);
            self
        }

        /// A network whose names resolve through this lookup.
        pub(crate) fn network(self: &Arc<Self>) -> PublicOriginNetwork {
            PublicOriginNetwork::with_lookup(Arc::clone(self) as Arc<dyn HostLookup>)
                .expect("public origin network")
        }
    }

    impl HostLookup for ScriptedLookup {
        fn lookup(&self, host: &str) -> LookupFuture {
            self.calls.fetch_add(1, Ordering::SeqCst);
            let mut answers = self.answers.lock().unwrap();
            let answer = match answers.get_mut(host) {
                Some(queue) if queue.len() > 1 => queue.remove(0),
                Some(queue) => match queue.first() {
                    Some(Ok(addresses)) => Ok(addresses.clone()),
                    Some(Err(error)) => Err(io::Error::new(error.kind(), error.to_string())),
                    None => Err(io::Error::new(io::ErrorKind::NotFound, "no answer")),
                },
                None => Err(io::Error::new(io::ErrorKind::NotFound, "unknown host")),
            };
            Box::pin(async move { answer })
        }
    }

    /// A lookup that never answers.
    #[derive(Default)]
    pub(crate) struct HangingLookup {
        pub(crate) calls: AtomicUsize,
    }

    impl HangingLookup {
        /// A network whose names resolve through this lookup.
        pub(crate) fn network(self: &Arc<Self>) -> PublicOriginNetwork {
            PublicOriginNetwork::with_lookup(Arc::clone(self) as Arc<dyn HostLookup>)
                .expect("public origin network")
        }
    }

    impl HostLookup for HangingLookup {
        fn lookup(&self, _host: &str) -> LookupFuture {
            self.calls.fetch_add(1, Ordering::SeqCst);
            Box::pin(std::future::pending())
        }
    }

    /// `addresses` as if they had been checked, for tests of what is done
    /// with checked addresses.
    pub(crate) fn checked_addresses(addresses: Vec<SocketAddr>) -> CheckedAddresses {
        CheckedAddresses(addresses)
    }

    pub(crate) fn ips(values: &[&str]) -> Vec<IpAddr> {
        values.iter().map(|value| value.parse().unwrap()).collect()
    }

    /// A listener on 127.0.0.1 that counts the connections it accepts and
    /// answers each with an empty 204.
    pub(crate) async fn counting_listener() -> (u16, Arc<AtomicUsize>) {
        let listener = TcpListener::bind("127.0.0.1:0").await.unwrap();
        let port = listener.local_addr().unwrap().port();
        let accepted = Arc::new(AtomicUsize::new(0));
        let counter = Arc::clone(&accepted);
        tokio::spawn(async move {
            while let Ok((mut stream, _)) = listener.accept().await {
                counter.fetch_add(1, Ordering::SeqCst);
                let _ = stream
                    .write_all(b"HTTP/1.1 204 No Content\r\ncontent-length: 0\r\n\r\n")
                    .await;
            }
        });
        (port, accepted)
    }
}

#[cfg(test)]
mod tests {
    use super::test_support::{counting_listener, ips, HangingLookup, ScriptedLookup};
    use super::*;
    use std::str::FromStr;
    use std::sync::atomic::Ordering;

    use hyper014::client::connect::dns::Name;

    fn ip(value: &str) -> IpAddr {
        value.parse().unwrap()
    }

    fn url(value: &str) -> Url {
        Url::parse(value).unwrap()
    }

    #[test]
    fn every_non_public_ipv4_class_is_refused() {
        for (class, addresses) in [
            ("this network", &["0.0.0.0", "0.1.2.3"][..]),
            ("private 10/8", &["10.0.0.1", "10.255.255.255"][..]),
            ("carrier-grade NAT", &["100.64.0.1", "100.127.255.255"][..]),
            ("loopback", &["127.0.0.1", "127.255.255.254"][..]),
            ("link-local", &["169.254.0.1", "169.254.169.254"][..]),
            ("private 172.16/12", &["172.16.0.1", "172.31.255.255"][..]),
            ("IETF protocol assignments", &["192.0.0.8"][..]),
            (
                "documentation",
                &["192.0.2.1", "198.51.100.7", "203.0.113.9"][..],
            ),
            ("6to4 relay anycast", &["192.88.99.1"][..]),
            (
                "private 192.168/16",
                &["192.168.0.1", "192.168.255.255"][..],
            ),
            ("benchmarking", &["198.18.0.1", "198.19.255.255"][..]),
            ("multicast", &["224.0.0.1", "239.255.255.250"][..]),
            (
                "reserved and broadcast",
                &["240.0.0.1", "255.255.255.255"][..],
            ),
        ] {
            for address in addresses {
                assert!(!is_public_address(ip(address)), "{class}: {address}");
                // The same address written as IPv4-mapped IPv6.
                assert!(
                    !is_public_address(ip(&format!("::ffff:{address}"))),
                    "{class}: ::ffff:{address}"
                );
            }
        }
    }

    #[test]
    fn public_ipv4_addresses_pass_including_the_edges_of_each_range() {
        for address in [
            "1.1.1.1",
            "8.8.8.8",
            "9.255.255.255",
            "11.0.0.0",
            "100.63.255.255",
            "100.128.0.0",
            "126.255.255.255",
            "128.0.0.0",
            "169.253.255.255",
            "169.255.0.0",
            "172.15.255.255",
            "172.32.0.0",
            "192.0.1.1",
            "192.0.3.0",
            "192.167.255.255",
            "192.169.0.0",
            "198.17.255.255",
            "198.20.0.0",
            "223.255.255.255",
        ] {
            assert!(is_public_address(ip(address)), "{address}");
            assert!(
                is_public_address(ip(&format!("::ffff:{address}"))),
                "::ffff:{address}"
            );
        }
    }

    #[test]
    fn every_non_public_ipv6_class_is_refused() {
        for (class, address) in [
            ("unspecified", "::"),
            ("loopback", "::1"),
            ("IPv4-compatible", "::7f00:1"),
            ("IPv4-translated", "::ffff:0:a00:1"),
            ("NAT64", "64:ff9b::a00:1"),
            ("NAT64 of a public address", "64:ff9b::808:808"),
            ("local-use NAT64", "64:ff9b:1::1"),
            ("discard-only", "100::1"),
            ("Teredo", "2001::1"),
            ("benchmarking", "2001:2::1"),
            ("ORCHIDv2", "2001:20::1"),
            ("documentation", "2001:db8::1"),
            ("documentation (RFC 9637)", "3fff::1"),
            ("6to4", "2002:c0a8:101::1"),
            ("unique local", "fc00::1"),
            ("unique local", "fd12:3456:789a::1"),
            ("link-local", "fe80::1"),
            ("site-local", "fec0::1"),
            ("multicast", "ff02::1"),
            ("outside global unicast", "4000::1"),
        ] {
            assert!(!is_public_address(ip(address)), "{class}: {address}");
        }
    }

    #[test]
    fn public_ipv6_addresses_pass() {
        for address in [
            "2606:4700:4700::1111",
            "2001:4860:4860::8888",
            "2001:200::1",
            "2a00:1450:4001:80b::200e",
            "3ffe::1",
        ] {
            assert!(is_public_address(ip(address)), "{address}");
        }
    }

    #[tokio::test]
    async fn a_host_that_is_not_public_is_refused_before_any_request() {
        let lookup = ScriptedLookup::always("origin.test", &["10.0.0.5"]);
        let network = lookup.network();
        for refused in [
            "http://127.0.0.1:54332",
            "http://10.0.0.5:8080/origin",
            "https://169.254.169.254/latest",
            "http://[::1]:54332",
            "http://[::ffff:127.0.0.1]:54332",
            "http://[fd00::1]/",
            "ws://0.0.0.0:9000/browser/vnc",
            // Shorthand IPv4 forms are parsed to the address they stand for.
            "http://2130706433/",
            "http://0x7f.1/",
            "http://origin.test:54332/entries",
        ] {
            let error = network.check(&url(refused)).await.unwrap_err();
            assert!(
                matches!(
                    error,
                    PublicConnectError::Refused(OriginAddressError::NonPublic { .. })
                ),
                "{refused}"
            );
            assert!(refused_non_public_address(&error).is_some(), "{refused}");
        }
        assert_eq!(
            lookup.calls.load(Ordering::SeqCst),
            1,
            "only the name is looked up"
        );
        let public = ScriptedLookup::always("origin.test", &["203.0.114.10"]).network();
        for passed in [
            "https://8.8.8.8/",
            "http://[2606:4700:4700::1111]:8080/",
            "https://origin.test/files",
        ] {
            assert!(public.check(&url(passed)).await.is_ok(), "{passed}");
        }
        // A name that does not resolve fails the check, and is not refused as
        // a non-public address.
        let unresolved = public
            .check(&url("http://missing.test:54332"))
            .await
            .unwrap_err();
        assert!(
            matches!(
                unresolved,
                PublicConnectError::Refused(OriginAddressError::Unresolved { .. })
            ),
            "{unresolved}"
        );
        assert_eq!(refused_non_public_address(&unresolved), None);
    }

    #[tokio::test(start_paused = true)]
    async fn a_name_that_does_not_resolve_within_the_connect_timeout_fails_the_check() {
        let lookup = Arc::new(HangingLookup::default());
        let network = lookup.network();
        let started = tokio::time::Instant::now();
        let error = network
            .check(&url("http://origin.test:54332/entries"))
            .await
            .unwrap_err();
        assert!(matches!(error, PublicConnectError::TimedOut), "{error}");
        assert_eq!(refused_non_public_address(&error), None);
        assert_eq!(started.elapsed(), ORIGIN_PROXY_CONNECT_TIMEOUT);
        assert_eq!(lookup.calls.load(Ordering::SeqCst), 1);
    }

    #[test]
    fn only_an_ip_literal_is_checked_without_a_lookup() {
        for refused in [
            "http://127.0.0.1:54332",
            "http://10.0.0.5:8080/origin",
            "http://[::1]:54332",
            "http://[::ffff:127.0.0.1]:54332",
            "http://[fd00::1]/",
            "http://0x7f.1/",
        ] {
            let error = check_literal(&url(refused)).unwrap_err();
            assert!(
                matches!(
                    error,
                    PublicConnectError::Refused(OriginAddressError::NonPublic { .. })
                ),
                "{refused}"
            );
            assert!(refused_non_public_address(&error).is_some(), "{refused}");
        }
        // A name, even one that resolves to loopback, is left to the
        // connection, whose resolver refuses it.
        for passed in [
            "https://8.8.8.8/",
            "http://[2606:4700:4700::1111]:8080/",
            "http://origin.test:54332",
            "http://localhost:54332",
        ] {
            assert!(check_literal(&url(passed)).is_ok(), "{passed}");
        }
    }

    #[tokio::test]
    async fn the_resolver_refuses_an_answer_with_any_non_public_address() {
        let resolver = PublicAddressResolver {
            lookup: ScriptedLookup::always("origin.test", &["203.0.114.10", "10.1.2.3"]),
        };
        let error = match resolver
            .resolve(Name::from_str("origin.test").unwrap())
            .await
        {
            Ok(_) => panic!("a mixed answer must be refused"),
            Err(error) => error,
        };
        assert!(
            refused_non_public_address(error.as_ref()).is_some(),
            "{error}"
        );
        assert_eq!(error.to_string(), "origin.test is not at a public address");

        let resolver = PublicAddressResolver {
            lookup: ScriptedLookup::always("origin.test", &["203.0.114.10", "2606:4700::1"]),
        };
        let addresses: Vec<SocketAddr> = match resolver
            .resolve(Name::from_str("origin.test").unwrap())
            .await
        {
            Ok(addrs) => addrs.collect(),
            Err(error) => panic!("public answer refused: {error}"),
        };
        assert_eq!(
            addresses,
            vec![
                SocketAddr::new(ip("203.0.114.10"), 0),
                SocketAddr::new(ip("2606:4700::1"), 0)
            ]
        );
    }

    #[tokio::test]
    async fn the_resolver_checks_every_resolution_afresh() {
        // A name that answers publicly first and with loopback next must not
        // reuse the first verdict.
        let lookup = ScriptedLookup::answering(
            "origin.test",
            vec![Ok(ips(&["203.0.114.10"])), Ok(ips(&["127.0.0.1"]))],
        );
        let resolver = PublicAddressResolver {
            lookup: lookup.clone(),
        };
        assert!(resolver
            .resolve(Name::from_str("origin.test").unwrap())
            .await
            .is_ok());
        let second = resolver
            .resolve(Name::from_str("origin.test").unwrap())
            .await;
        assert!(
            matches!(second, Err(ref error) if refused_non_public_address(error.as_ref()).is_some())
        );
        assert_eq!(lookup.calls.load(Ordering::SeqCst), 2);
    }

    #[tokio::test]
    async fn the_resolver_reports_an_empty_or_failed_lookup_as_unresolved() {
        for lookup in [
            ScriptedLookup::always("origin.test", &[]),
            ScriptedLookup::answering(
                "origin.test",
                vec![Err(io::Error::new(io::ErrorKind::NotFound, "nxdomain"))],
            ),
        ] {
            let resolver = PublicAddressResolver { lookup };
            match resolver
                .resolve(Name::from_str("origin.test").unwrap())
                .await
            {
                Ok(_) => panic!("nothing to connect to"),
                Err(error) => {
                    assert!(
                        refused_non_public_address(error.as_ref()).is_none(),
                        "{error}"
                    );
                    assert!(error
                        .to_string()
                        .starts_with("failed to resolve origin.test"));
                }
            }
        }
    }

    #[tokio::test]
    async fn the_public_client_never_connects_to_a_name_that_resolves_to_loopback() {
        let (port, accepted) = counting_listener().await;
        let lookup = ScriptedLookup::always("origin.test", &["127.0.0.1"]);
        let client = lookup.network().client().clone();

        let error = client
            .get(format!("http://origin.test:{port}/files"))
            .send()
            .await
            .unwrap_err();
        assert_eq!(
            refused_non_public_address(&error),
            Some(ip("127.0.0.1")),
            "{error:?}"
        );
        assert!(error.is_connect(), "{error:?}");
        assert_eq!(lookup.calls.load(Ordering::SeqCst), 1);

        // A mapped or private answer is refused the same way.
        for addresses in [&["::ffff:127.0.0.1"][..], &["192.168.1.20"][..]] {
            let client = ScriptedLookup::always("origin.test", addresses)
                .network()
                .client()
                .clone();
            let error = client
                .get(format!("http://origin.test:{port}/"))
                .send()
                .await
                .unwrap_err();
            assert!(
                refused_non_public_address(&error).is_some(),
                "{addresses:?}: {error:?}"
            );
        }
        assert_eq!(accepted.load(Ordering::SeqCst), 0);

        // The listener does count what reaches it.
        let answer = reqwest::Client::new()
            .get(format!("http://127.0.0.1:{port}/"))
            .send()
            .await
            .unwrap();
        assert_eq!(answer.status(), reqwest::StatusCode::NO_CONTENT);
        assert_eq!(accepted.load(Ordering::SeqCst), 1);
    }

    #[tokio::test]
    async fn the_public_client_resolves_localhost_like_any_other_name() {
        let (port, accepted) = counting_listener().await;
        let client = PublicOriginNetwork::system().unwrap().client().clone();
        let error = client
            .get(format!("http://localhost:{port}/"))
            .send()
            .await
            .unwrap_err();
        assert!(refused_non_public_address(&error).is_some(), "{error:?}");
        assert_eq!(accepted.load(Ordering::SeqCst), 0);
    }

    #[tokio::test]
    async fn a_websocket_relay_gets_only_public_addresses_to_connect_to() {
        let (port, accepted) = counting_listener().await;
        let network = ScriptedLookup::always("origin.test", &["127.0.0.1"]).network();
        for target in [
            format!("ws://origin.test:{port}/browser/vnc"),
            format!("ws://127.0.0.1:{port}/browser/vnc"),
            format!("ws://[::ffff:127.0.0.1]:{port}/browser/vnc"),
        ] {
            let error = network.addresses(&url(&target)).await.unwrap_err();
            assert!(
                matches!(
                    error,
                    PublicConnectError::Refused(OriginAddressError::NonPublic { .. })
                ),
                "{target}: {error}"
            );
            assert!(refused_non_public_address(&error).is_some(), "{target}");
        }
        assert_eq!(accepted.load(Ordering::SeqCst), 0);

        // A public answer gives every address at the URL's port, looked up
        // once; connecting needs no second lookup.
        let public = ScriptedLookup::always("origin.test", &["203.0.114.10", "2606:4700::1"]);
        let addresses = public
            .network()
            .addresses(&url("wss://origin.test/browser/vnc"))
            .await
            .unwrap();
        assert_eq!(
            addresses.as_slice(),
            &[
                SocketAddr::new(ip("203.0.114.10"), 443),
                SocketAddr::new(ip("2606:4700::1"), 443)
            ]
        );
        assert_eq!(public.calls.load(Ordering::SeqCst), 1);

        let unresolved = Arc::new(ScriptedLookup::default())
            .network()
            .addresses(&url("wss://missing.test/browser/vnc"))
            .await
            .unwrap_err();
        assert!(
            refused_non_public_address(&unresolved).is_none(),
            "{unresolved}"
        );
    }

    #[tokio::test]
    async fn checked_addresses_connect_to_exactly_those_addresses() {
        let (port, accepted) = counting_listener().await;
        let checked = CheckedAddresses(vec![SocketAddr::new(ip("127.0.0.1"), port)]);
        let mut stream = checked.connect().await.unwrap();
        // The listener answers only after it has counted the connection.
        let mut answer = [0u8; 12];
        tokio::io::AsyncReadExt::read_exact(&mut stream, &mut answer)
            .await
            .unwrap();
        assert_eq!(&answer, b"HTTP/1.1 204");
        assert_eq!(accepted.load(Ordering::SeqCst), 1);
    }

    fn socket(value: &str) -> SocketAddr {
        value.parse().unwrap()
    }

    type FakeConnect = Pin<Box<dyn Future<Output = io::Result<SocketAddr>> + Send>>;
    type Attempts = Arc<std::sync::Mutex<Vec<(SocketAddr, Duration)>>>;

    /// Stands in for the network in tests of [`connect_to_first`]: a
    /// connection to an address in `answering` is made at once, one to an
    /// address in `refusing` fails at once, and one to any other address
    /// never finishes. Each attempt is recorded with when it began.
    fn fake_network(
        answering: &[SocketAddr],
        refusing: &[SocketAddr],
    ) -> (impl Fn(SocketAddr) -> FakeConnect, Attempts) {
        let at_once = |addresses: &[SocketAddr]| -> Vec<(SocketAddr, Duration)> {
            addresses
                .iter()
                .map(|&address| (address, Duration::ZERO))
                .collect()
        };
        timed_fake_network(&at_once(answering), &at_once(refusing))
    }

    /// [`fake_network`] whose connections end only after the time given
    /// with each address, counted from when the connection was begun.
    fn timed_fake_network(
        answering: &[(SocketAddr, Duration)],
        refusing: &[(SocketAddr, Duration)],
    ) -> (impl Fn(SocketAddr) -> FakeConnect, Attempts) {
        let started = tokio::time::Instant::now();
        let attempts = Attempts::default();
        let log = Arc::clone(&attempts);
        let (answering, refusing) = (answering.to_vec(), refusing.to_vec());
        let connect = move |address: SocketAddr| -> FakeConnect {
            log.lock().unwrap().push((address, started.elapsed()));
            let scripted = |script: &[(SocketAddr, Duration)]| {
                script
                    .iter()
                    .find(|(candidate, _)| *candidate == address)
                    .map(|&(_, after)| after)
            };
            let (after, outcome) = if let Some(after) = scripted(&answering) {
                (after, Ok(address))
            } else if let Some(after) = scripted(&refusing) {
                (
                    after,
                    Err(io::Error::from(io::ErrorKind::ConnectionRefused)),
                )
            } else {
                return Box::pin(std::future::pending());
            };
            if after.is_zero() {
                Box::pin(std::future::ready(outcome))
            } else {
                Box::pin(async move {
                    tokio::time::sleep(after).await;
                    outcome
                })
            }
        };
        (connect, attempts)
    }

    #[tokio::test(start_paused = true)]
    async fn an_address_that_never_answers_gets_only_its_share_of_the_connect_timeout() {
        let (silent, live) = (socket("203.0.114.10:443"), socket("203.0.114.11:443"));
        let (connect, attempts) = fake_network(&[live], &[]);
        let connected = connect_to_first(
            &[silent, live],
            ORIGIN_PROXY_CONNECT_TIMEOUT,
            OTHER_FAMILY_DELAY,
            connect,
        )
        .await
        .unwrap();
        assert_eq!(connected, live);
        assert_eq!(
            *attempts.lock().unwrap(),
            [
                (silent, Duration::ZERO),
                (live, ORIGIN_PROXY_CONNECT_TIMEOUT / 2)
            ]
        );
    }

    #[tokio::test(start_paused = true)]
    async fn the_other_family_is_tried_once_the_first_has_had_its_head_start() {
        let (v6, v4) = (
            socket("[2606:4700:4700::1111]:443"),
            socket("203.0.114.10:443"),
        );
        let (connect, attempts) = fake_network(&[v4], &[]);
        let connected = connect_to_first(
            &[v6, v4],
            ORIGIN_PROXY_CONNECT_TIMEOUT,
            OTHER_FAMILY_DELAY,
            connect,
        )
        .await
        .unwrap();
        assert_eq!(connected, v4);
        assert_eq!(
            *attempts.lock().unwrap(),
            [(v6, Duration::ZERO), (v4, OTHER_FAMILY_DELAY)]
        );
    }

    #[tokio::test(start_paused = true)]
    async fn the_other_family_is_tried_at_once_when_the_first_has_failed() {
        let (v4, v6) = (
            socket("203.0.114.10:443"),
            socket("[2606:4700:4700::1111]:443"),
        );
        let (connect, attempts) = fake_network(&[v6], &[v4]);
        let connected = connect_to_first(
            &[v4, v6],
            ORIGIN_PROXY_CONNECT_TIMEOUT,
            OTHER_FAMILY_DELAY,
            connect,
        )
        .await
        .unwrap();
        assert_eq!(connected, v6);
        assert_eq!(
            *attempts.lock().unwrap(),
            [(v4, Duration::ZERO), (v6, Duration::ZERO)]
        );
    }

    #[tokio::test(start_paused = true)]
    async fn connecting_fails_within_the_timeout_when_no_checked_address_answers() {
        let addresses = [
            socket("[2606:4700:4700::1111]:443"),
            socket("203.0.114.10:443"),
            socket("203.0.114.11:443"),
        ];
        let started = tokio::time::Instant::now();
        let (connect, attempts) = fake_network(&[], &[addresses[2]]);
        let error = connect_to_first(
            &addresses,
            ORIGIN_PROXY_CONNECT_TIMEOUT,
            OTHER_FAMILY_DELAY,
            connect,
        )
        .await
        .unwrap_err();
        assert!(matches!(error, PublicConnectError::TimedOut), "{error}");
        assert_eq!(started.elapsed(), ORIGIN_PROXY_CONNECT_TIMEOUT);
        // Each address was tried once, and nothing else was.
        assert_eq!(
            *attempts.lock().unwrap(),
            [
                (addresses[0], Duration::ZERO),
                (addresses[1], OTHER_FAMILY_DELAY),
                (
                    addresses[2],
                    OTHER_FAMILY_DELAY + ORIGIN_PROXY_CONNECT_TIMEOUT / 2
                ),
            ]
        );

        let (connect, attempts) = fake_network(&[], &addresses);
        let started = tokio::time::Instant::now();
        let error = connect_to_first(
            &addresses,
            ORIGIN_PROXY_CONNECT_TIMEOUT,
            OTHER_FAMILY_DELAY,
            connect,
        )
        .await
        .unwrap_err();
        assert!(matches!(error, PublicConnectError::Connect(_)), "{error}");
        assert_eq!(started.elapsed(), Duration::ZERO);
        assert_eq!(attempts.lock().unwrap().len(), addresses.len());
    }

    #[tokio::test(start_paused = true)]
    async fn connecting_never_takes_longer_than_the_connect_timeout() {
        let addresses = [
            socket("[2606:4700:4700::1111]:443"),
            socket("203.0.114.10:443"),
            socket("203.0.114.11:443"),
        ];
        let started = tokio::time::Instant::now();
        let (connect, attempts) = fake_network(&[], &[]);
        let error = connect_to_first(
            &addresses,
            ORIGIN_PROXY_CONNECT_TIMEOUT,
            OTHER_FAMILY_DELAY,
            connect,
        )
        .await
        .unwrap_err();
        assert!(matches!(error, PublicConnectError::TimedOut), "{error}");
        // The last IPv4 address, begun at 5.3 s, has a share that would run
        // to 10.3 s; the connect timeout ends the whole attempt at 10 s.
        assert_eq!(started.elapsed(), ORIGIN_PROXY_CONNECT_TIMEOUT);
        assert_eq!(
            *attempts.lock().unwrap(),
            [
                (addresses[0], Duration::ZERO),
                (addresses[1], OTHER_FAMILY_DELAY),
                (
                    addresses[2],
                    OTHER_FAMILY_DELAY + ORIGIN_PROXY_CONNECT_TIMEOUT / 2
                ),
            ]
        );
    }

    #[tokio::test(start_paused = true)]
    async fn the_other_family_is_still_waited_for_when_the_first_fails_after_its_head_start() {
        let (v6, v4) = (
            socket("[2606:4700:4700::1111]:443"),
            socket("203.0.114.10:443"),
        );
        let (connect, attempts) = timed_fake_network(
            &[(v4, Duration::from_secs(3))],
            &[(v6, Duration::from_secs(1))],
        );
        let started = tokio::time::Instant::now();
        let connected = connect_to_first(
            &[v6, v4],
            ORIGIN_PROXY_CONNECT_TIMEOUT,
            OTHER_FAMILY_DELAY,
            connect,
        )
        .await
        .unwrap();
        assert_eq!(connected, v4);
        assert_eq!(
            started.elapsed(),
            OTHER_FAMILY_DELAY + Duration::from_secs(3)
        );
        assert_eq!(
            *attempts.lock().unwrap(),
            [(v6, Duration::ZERO), (v4, OTHER_FAMILY_DELAY)]
        );
    }

    #[tokio::test]
    async fn registration_refuses_network_addresses_and_accepts_loopback() {
        let nothing = ScriptedLookup::default();
        for refused in [
            "http://10.0.0.5:54332",
            "http://172.20.1.2:54332",
            "http://192.168.1.20:54332",
            "http://100.64.0.1:54332",
            "http://169.254.169.254",
            "http://0.0.0.0:54332",
            "http://224.0.0.1:54332",
            "http://[fd00::1]:54332",
            "http://[fe80::1]:54332",
            "http://[::ffff:10.0.0.5]:54332",
        ] {
            let error = check_registration_endpoint(&nothing, &url(refused))
                .await
                .unwrap_err();
            assert!(
                matches!(error, OriginAddressError::NonPublic { .. }),
                "{refused}"
            );
        }
        for accepted in [
            "http://127.0.0.1:54332",
            "http://127.1.2.3:54332",
            "http://[::1]:54332",
            "http://[::ffff:127.0.0.1]:54332",
            "https://8.8.8.8",
            "http://[2606:4700:4700::1111]:8080",
        ] {
            assert!(
                check_registration_endpoint(&nothing, &url(accepted))
                    .await
                    .is_ok(),
                "{accepted}"
            );
        }
        assert_eq!(
            nothing.calls.load(Ordering::SeqCst),
            0,
            "a literal is never looked up"
        );
    }

    #[tokio::test]
    async fn registration_checks_what_a_name_resolves_to() {
        for (addresses, accepted) in [
            (&["127.0.0.1", "::1"][..], true),
            (&["203.0.114.10"][..], true),
            (&["203.0.114.10", "127.0.0.1"][..], true),
            (&["10.0.0.5"][..], false),
            (&["203.0.114.10", "192.168.1.20"][..], false),
            (&["127.0.0.1", "169.254.169.254"][..], false),
            (&["fd00::1"][..], false),
        ] {
            let lookup = ScriptedLookup::always("origin.example", addresses);
            let result =
                check_registration_endpoint(lookup.as_ref(), &url("http://origin.example:54332"))
                    .await;
            assert_eq!(result.is_ok(), accepted, "{addresses:?}");
            assert_eq!(lookup.calls.load(Ordering::SeqCst), 1);
        }
    }

    #[tokio::test]
    async fn registration_accepts_a_name_that_does_not_resolve_here() {
        // A browser may reach it directly; any connection the controller makes
        // is checked again.
        for lookup in [
            Arc::new(ScriptedLookup::default()),
            ScriptedLookup::always("origin.lan", &[]),
        ] {
            assert!(
                check_registration_endpoint(lookup.as_ref(), &url("http://origin.lan:54332"))
                    .await
                    .is_ok()
            );
        }
    }

    #[tokio::test(start_paused = true)]
    async fn registration_does_not_wait_long_for_a_slow_resolver() {
        struct StalledLookup;
        impl HostLookup for StalledLookup {
            fn lookup(&self, _host: &str) -> LookupFuture {
                Box::pin(async {
                    tokio::time::sleep(Duration::from_secs(3600)).await;
                    Ok(ips(&["10.0.0.5"]))
                })
            }
        }
        let started = tokio::time::Instant::now();
        assert!(
            check_registration_endpoint(&StalledLookup, &url("http://origin.example"))
                .await
                .is_ok()
        );
        assert_eq!(started.elapsed(), REGISTRATION_LOOKUP_TIMEOUT);
    }
}
