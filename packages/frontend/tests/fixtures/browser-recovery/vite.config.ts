import { createStyleReviewConfig } from "../shared-style-followups/viteConfig";
import { recoveryBoundaries } from "./boundaries";

export default createStyleReviewConfig({ name: "browser-recovery", port: 5327, stubs: recoveryBoundaries });
