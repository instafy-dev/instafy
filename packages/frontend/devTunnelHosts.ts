/**
 * Extra hosts Studio's own dev server answers, so it can be opened through a
 * tunnel: `.<TUNNEL_DOMAIN>` (the tunnel broker's setting, the domain and
 * every name under it). Unset or unreadable, nothing is added and Vite keeps
 * its default of localhost and IP addresses only.
 */
export function tunnelAllowedHosts(tunnelDomain: string | undefined): string[] {
  const domain = (tunnelDomain ?? "")
    .trim()
    .replace(/^\*?\.+/, "")
    .replace(/\.+$/, "")
    .toLowerCase();
  return /^[a-z0-9-]+(\.[a-z0-9-]+)*$/.test(domain) ? [`.${domain}`] : [];
}
