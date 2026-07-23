#!/usr/bin/env bash
set -euo pipefail

ZONE="${1:-${TUNNEL_DOMAIN:-}}"
NS_HOSTNAME="${2:-}"
NS_IPV4="${3:-}"

if [[ -z "${ZONE}" ]]; then
  echo "Usage: $0 <zone> [ns-hostname] [ns-ipv4]" >&2
  echo "Example: $0 rt.instafy.dev ns1.rt.instafy.dev 65.109.232.178" >&2
  exit 2
fi

if [[ -z "${NS_HOSTNAME}" ]]; then
  NS_HOSTNAME="ns1.${ZONE}"
fi

RESOLVERS=(8.8.8.8 1.1.1.1 9.9.9.9)

echo "Zone: ${ZONE}"
echo "NS hostname: ${NS_HOSTNAME}"
if [[ -n "${NS_IPV4}" ]]; then
  echo "NS IPv4: ${NS_IPV4}"
fi
echo

function dig_status() {
  dig "$@" +noall +comments 2>/dev/null | awk '/status:/{for(i=1;i<=NF;i++){if($i=="status:"){gsub(/,/, "", $(i+1)); print $(i+1); exit}}}'
}

echo "== Resolver delegation checks (with DNSSEC DO flag)"
for r in "${RESOLVERS[@]}"; do
  ns_status="$(dig_status @"${r}" NS "${ZONE}" +dnssec || true)"
  a_status="$(dig_status @"${r}" A "${NS_HOSTNAME}" +dnssec || true)"

  echo "-- @${r}"
  echo "NS ${ZONE}: ${ns_status:-unknown}"
  echo "A  ${NS_HOSTNAME}: ${a_status:-unknown}"

  if [[ "${ns_status}" != "NOERROR" ]]; then
    echo "Resolver ${r} failed NS lookup for ${ZONE} (status=${ns_status})." >&2
    dig @"${r}" NS "${ZONE}" +dnssec || true
    exit 1
  fi
  if [[ "${a_status}" != "NOERROR" ]]; then
    echo "Resolver ${r} failed A lookup for ${NS_HOSTNAME} (status=${a_status})." >&2
    dig @"${r}" A "${NS_HOSTNAME}" +dnssec || true
    exit 1
  fi

  dig @"${r}" NS "${ZONE}" +dnssec +noall +answer +additional || true
  dig @"${r}" A "${NS_HOSTNAME}" +dnssec +noall +answer || true
  echo
done

if [[ -n "${NS_IPV4}" ]]; then
  echo "== Authoritative checks against ${NS_IPV4}"
  soa_status="$(dig_status @"${NS_IPV4}" SOA "${ZONE}" +dnssec || true)"
  echo "SOA ${ZONE}: ${soa_status:-unknown}"
  if [[ "${soa_status}" != "NOERROR" ]]; then
    echo "Authoritative server ${NS_IPV4} failed SOA lookup for ${ZONE} (status=${soa_status})." >&2
    dig @"${NS_IPV4}" SOA "${ZONE}" +dnssec || true
    exit 1
  fi
  dig @"${NS_IPV4}" SOA "${ZONE}" +dnssec +noall +answer || true
fi

echo
echo "OK"

