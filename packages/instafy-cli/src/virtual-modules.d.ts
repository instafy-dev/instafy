// SPDX-License-Identifier: AGPL-3.0-only
// The instafy-web-research skill's link-only-sites.json, bundled from the runtime-agent assets at build time
// (tsup.config.ts) and in tests (vitest.config.ts), so the CLI keeps no copy of its own.
declare module "virtual:instafy/link-only-sites" {
  const data: unknown;
  export default data;
}
