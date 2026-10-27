// SPDX-License-Identifier: AGPL-3.0-only
//
// `instafy web link <site> [name=value…]`: guided mode for a site the web-research skill lists as link-only. Octo never
// opens or reads a "no-agents" site; it gives the person a link to open in their own tab instead. This fills the site's
// search link template from the list (skill-owned data: `placeholders`, each site's `search`, `home` and `deepLinks`)
// with the values given, or gives the home page and what to type there when the site bars deep links or has no search
// link. It reads nothing and fetches nothing: the matcher (`@instafy/browser-action-policy/linkOnly`) checks every value
// against its placeholder's format, URL-encodes it, refuses a placeholder the list or the link does not define, and
// keeps the link https on the site's own hosts.
import type { Command } from "commander";
import * as linkOnly from "@instafy/browser-action-policy/linkOnly";
import {
  BUNDLED_LINK_ONLY_SITES,
  LinkOnlyListUnavailableError,
  defaultSkillRoots,
  loadLinkOnlyGuard,
  type WebReadDeps,
} from "./web-read.js";

export const WEB_LINK_EXIT_OK = 0;
export const WEB_LINK_EXIT_USAGE = 64;
export const WEB_LINK_EXIT_INTERNAL = 70;

/** What Octo does with the link, by the site's kind. */
export const WEB_LINK_TELL: Record<linkOnly.LinkOnlyKind, string> = {
  "no-agents":
    "Octo never opens or reads this link, in any tab or reader. Give the person short numbered steps: open the link in " +
    "their own tab (type the `typeIn` values there, if any), pick the pages to compare, and press \"Send page to Octo\" " +
    "on each. Work only from the pages they send.",
  "no-reuse":
    "This site may be read; its terms bar reusing its content. Summarize it in your own words, cite \"seen <date> on " +
    "<host>\" and link back; never copy its reviews, photos or price lists, and keep its content out of anything " +
    "published or shared by public link.",
};

export type WebLinkReport =
  | (Extract<linkOnly.LinkOnlyGuidedLink, { ok: true }> & { tell: string; warnings: string[] })
  | { ok: false; error: string };

export class WebLinkUsageError extends Error {}

/** `name=value` pairs, each name once. */
export function parseLinkValues(raw: string[]): Record<string, string> {
  // No prototype, so a name such as __proto__ is a name like any other (and refused as an unknown placeholder).
  const values: Record<string, string> = Object.create(null);
  for (const pair of raw) {
    const at = pair.indexOf("=");
    const name = at > 0 ? pair.slice(0, at).trim() : "";
    if (!name) throw new WebLinkUsageError(`"${pair.slice(0, 80)}" is not name=value (for example query=Lisbon).`);
    if (Object.prototype.hasOwnProperty.call(values, name)) throw new WebLinkUsageError(`${name} is given twice.`);
    values[name] = pair.slice(at + 1);
  }
  return values;
}

/** The guided link for `site` with `values`, from the bundled list plus every skill copy the readers use. */
export function webLink(site: string, values: Record<string, string>, deps: Pick<WebReadDeps, "skillRoots" | "bundledLinkOnly" | "env" | "cwd"> = {}): WebLinkReport {
  const env = deps.env ?? process.env;
  const cwd = deps.cwd ?? process.cwd();
  const guard = loadLinkOnlyGuard(deps.skillRoots ?? defaultSkillRoots(cwd, env), "bundledLinkOnly" in deps ? deps.bundledLinkOnly : BUNDLED_LINK_ONLY_SITES);
  const result = linkOnly.guidedLink(guard.list, site, values);
  if (result.ok === false) return result;
  return { ...result, tell: WEB_LINK_TELL[result.kind], warnings: guard.warnings };
}

export function formatWebLink(report: Extract<WebLinkReport, { ok: true }>): string {
  const out = [`${report.site} (${report.kind}${report.deepLinks ? "" : ", no deep links"})`, `link: ${report.link}`];
  for (const item of report.typeIn) out.push(`type: ${item.about}: ${item.value}`);
  out.push(report.tell);
  for (const warning of report.warnings) out.push(`warning: ${warning}`);
  return out.join("\n");
}

export async function runWebLinkCli(
  site: string,
  pairs: string[],
  opts: { json?: boolean },
  io: { out: (line: string) => void; err: (line: string) => void } = { out: console.log, err: console.error },
  deps: Pick<WebReadDeps, "skillRoots" | "bundledLinkOnly" | "env" | "cwd"> = {},
): Promise<number> {
  try {
    const report = webLink(site, parseLinkValues(pairs), deps);
    if (report.ok === false) throw new WebLinkUsageError(report.error);
    io.out(opts.json ? JSON.stringify(report, null, 1) : formatWebLink(report));
    return WEB_LINK_EXIT_OK;
  } catch (error) {
    const usage = error instanceof WebLinkUsageError;
    const code = usage ? WEB_LINK_EXIT_USAGE : WEB_LINK_EXIT_INTERNAL;
    const message = usage || error instanceof LinkOnlyListUnavailableError
      ? (error as Error).message
      : `web link failed: ${error instanceof Error ? error.message : String(error)}`;
    if (opts.json) io.out(JSON.stringify({ ok: false, exitCode: code, error: message }));
    else io.err(message);
    return code;
  }
}

/** `instafy web link`, under `instafy web`. */
export function registerWebLinkCommand(web: Command): Command {
  web
    .command("link")
    .description(
      "Fill a link-only site's search link from the web-research skill's list, for the person to open in their own " +
        "tab (guided mode); gives the home page and what to type when the site bars deep links. Reads nothing " +
        "(exit 64: not a listed site, or a value or placeholder refused).",
    )
    .argument("<site>", "the site's name in the list, one of its hosts, or an address on it")
    .argument("[values...]", "placeholder values as name=value, such as query=Lisbon checkin=2026-11-12 adults=2")
    .option("--json", "Output JSON")
    .action(async (site: string, values: string[], opts: { json?: boolean }) => {
      process.exitCode = await runWebLinkCli(site, values ?? [], opts);
    });
  return web;
}
