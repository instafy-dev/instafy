import path from "node:path";
import { readFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import { defineConfig, type UserConfig } from "vite";
import browserUiConfig from "../../../vite.ci-ui.config";

const base = browserUiConfig as UserConfig;
const frontendSrc = fileURLToPath(new URL("../../../src/", import.meta.url));

/** Production components, inert data boundaries, and optional pre-change sources. */
export function createStyleReviewConfig({ name, port, stubs = {}, optimize = [] }: {
  name: string;
  port: number;
  stubs?: Record<string, string>;
  optimize?: string[];
}) {
  const baseline = process.env.INSTAFY_REVIEW_BASELINE_SRC;
  const prefix = `\0style-review-${name}:`;
  return defineConfig({
    ...base,
    cacheDir: `node_modules/.vite-style-review-${name}-${baseline ? "before" : "after"}`,
    optimizeDeps: {
      ...base.optimizeDeps,
      include: [...(base.optimizeDeps?.include ?? []), ...optimize],
    },
    server: {
      ...base.server,
      port,
      fs: { ...base.server?.fs, allow: [...(base.server?.fs?.allow ?? []), ...(baseline ? [baseline] : [])] },
    },
    plugins: [...(base.plugins ?? []), {
      name: `style-review-${name}`,
      enforce: "pre" as const,
      resolveId(source, importer) {
        const resolved = source.startsWith(".") && importer
          ? path.resolve(path.dirname(importer), source) : source;
        for (const suffix of Object.keys(stubs)) {
          if (resolved === suffix || resolved.endsWith(suffix) || resolved.endsWith(suffix.replace(/\.(tsx?|jsx?)$/, ""))) {
            return `${prefix}${suffix}`;
          }
        }
      },
      async load(id) {
        if (id.startsWith(prefix)) return stubs[id.slice(prefix.length)];
        // Keep module identities/import resolution in the real frontend tree.
        // Only source contents change, so both versions use identical fixtures.
        if (baseline && id.startsWith(frontendSrc) && /\.(?:[jt]sx?|css)$/.test(id)) {
          const relative = path.relative(frontendSrc, id);
          const source = await readFile(path.join(baseline, relative), "utf8");
          return relative === "styles/tailwind.css"
            ? `${source}\n@source ${JSON.stringify(baseline)};\n` : source;
        }
      },
    }],
  });
}
