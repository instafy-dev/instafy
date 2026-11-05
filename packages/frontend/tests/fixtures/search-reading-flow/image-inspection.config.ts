import { defineConfig } from "@playwright/test";
import readingFlowConfig from "./playwright.config";

export default defineConfig(readingFlowConfig, {
  testMatch: "image-inspection.spec.ts",
  outputDir: `../../../test-results/image-inspection-${process.env.INSTAFY_REVIEW_VERSION === "before" ? "before" : "after"}`,
});
