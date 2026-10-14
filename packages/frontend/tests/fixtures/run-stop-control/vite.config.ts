import path from "node:path";
import { defineConfig, type UserConfig } from "vite";
import browserUiConfig from "../../../vite.ci-ui.config";
import { RUN_STOP_FIXTURE_STUBS } from "./dataStubs";

/** Standalone preview; never loads local credentials or a real cancel transport. */
export default defineConfig({
  ...(browserUiConfig as UserConfig),
  plugins: [...((browserUiConfig as UserConfig).plugins ?? []), {
    name: "run-stop-playground-data-boundaries",
    enforce: "pre",
    resolveId(source, importer) {
      const resolved = source.startsWith(".") && importer
        ? path.resolve(path.dirname(importer), source) : source;
      for (const suffix of Object.keys(RUN_STOP_FIXTURE_STUBS)) {
        if (resolved.endsWith(suffix) || resolved.endsWith(suffix.replace(/\.(tsx?|jsx?)$/, ""))) {
          return `\0run-stop-fixture:${suffix}`;
        }
      }
    },
    load(id) {
      const prefix = "\0run-stop-fixture:";
      return id.startsWith(prefix) ? RUN_STOP_FIXTURE_STUBS[id.slice(prefix.length)] : null;
    },
  }],
});
