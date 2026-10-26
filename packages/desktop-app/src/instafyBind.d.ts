// Types for the part of the bound-sites binder (packages/instafy-bind, plain
// JavaScript) that Desktop bundles: its public-address check.
declare module "@instafy/bind/net" {
  export function isPrivateAddress(ip: string): boolean;
  export function isLocalHostName(host: string): boolean;
  export function checkPublicUrl(
    raw: string,
    options?: {
      allowLocal?: boolean;
      lookup?: (host: string, options: { all: true; verbatim: boolean }) => Promise<Array<{ address: string; family: number }>>;
    },
  ): Promise<{ ok: true; addresses: string[] } | { ok: false; reason: string }>;
}
