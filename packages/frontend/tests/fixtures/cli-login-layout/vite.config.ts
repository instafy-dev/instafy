import { createStyleReviewConfig } from "../shared-style-followups/viteConfig";
import { cliLoginLayoutBoundaries } from "./boundaries";

export default createStyleReviewConfig({ name: "cli-login-layout", port: 5343, stubs: cliLoginLayoutBoundaries });
