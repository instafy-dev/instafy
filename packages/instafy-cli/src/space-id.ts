import { findProjectManifest } from "./project-manifest.js";
import { shownPath, shownValue } from "./terminal-text.js";

/** The environment variables a command takes its space from, in order, when no --space is given. */
export const SPACE_ID_VARIABLES = ["SPACE_ID", "INSTAFY_SPACE_ID", "PROJECT_ID", "INSTAFY_PROJECT_ID"] as const;

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/**
 * The space a command acts on: its --space, else the first of `variables` that is set, else the
 * space the nearest `.instafy/space.json` binds the folder to. The id goes into request paths, and a
 * repository can commit that file, so anything but a UUID is refused, naming where it came from: a
 * binding such as `../agent/plan-groups/<id>/status?x=` would otherwise send the request, with the
 * person's token, to another route of the same controller. A value that is not a space id is an
 * error rather than a reason to try the next source, which could name a different space.
 */
export function resolveSpaceId(
  explicit: string | null | undefined,
  options: { missing: string; variables?: readonly string[]; cwd?: string },
): string {
  const given = explicit?.trim();
  if (given) {
    if (!UUID.test(given)) {
      throw new Error(`--space ${shownValue(given)} is not a space id. Pass the space's UUID.`);
    }
    return given;
  }

  for (const name of options.variables ?? SPACE_ID_VARIABLES) {
    const value = process.env[name]?.trim();
    if (!value) {
      continue;
    }
    if (!UUID.test(value)) {
      throw new Error(
        `${name} is ${shownValue(value)}, which is not a space id. Set it to the space's UUID, or unset it.`,
      );
    }
    return value;
  }

  const found = findProjectManifest(options.cwd ?? process.cwd());
  const bound = found.manifest?.spaceId.trim();
  if (bound) {
    if (!UUID.test(bound)) {
      throw new Error(
        `${shownPath(found.path ?? ".instafy/space.json")} binds this folder to the space ${shownValue(bound)}, which is not a space id. Correct its "spaceId", or pass --space with the space's UUID.`,
      );
    }
    return bound;
  }

  throw new Error(options.missing);
}
