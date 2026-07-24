import { pathToFileURL } from "node:url";

export function modulePathToImportUrl(
  modulePath,
  { windows = process.platform === "win32" } = {},
) {
  return pathToFileURL(modulePath, { windows }).href;
}
