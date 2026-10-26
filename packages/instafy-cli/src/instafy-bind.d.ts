// Types for the parts of the bound-sites binder (packages/instafy-bind, plain JavaScript) that the CLI bundles.
// SPDX-License-Identifier: AGPL-3.0-only

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

declare module "@instafy/bind/web" {
  export type RobotsGroup = { agents: string[]; rules: Array<{ allow: boolean; path: string }> };
  export const USER_AGENT: string;
  export const AI_AGENTS: string[];
  export function parseRobots(text: string): RobotsGroup[];
  export function robotsAllows(groups: RobotsGroup[], agent: string, pathWithQuery: string): boolean;
  export function challengeReason(status: number, html: string): string | null;
  export function jsonLdBlocks(html: string, max?: number): string[];
}
