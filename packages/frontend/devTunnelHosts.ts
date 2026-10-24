/**
 * Extra hosts Studio's own dev server answers, so it can be opened through a
 * tunnel: `.<TUNNEL_DOMAIN>` (the tunnel broker's setting, the domain and
 * every name under it), read like the controller reads it. Unset, unreadable
 * or a single label (`site`), nothing is added and Vite keeps its default of
 * localhost and IP addresses only.
 */
export function tunnelAllowedHosts(tunnelDomain: string | undefined): string[] {
  const domain = (tunnelDomain ?? "")
    .trim()
    .replace(/^\*?\.+/, "")
    .replace(/\.+$/, "")
    .toLowerCase();
  return /^[a-z0-9-]+(\.[a-z0-9-]+)+$/.test(domain) ? [`.${domain}`] : [];
}
