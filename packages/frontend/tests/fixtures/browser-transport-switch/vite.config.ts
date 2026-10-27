import { createStyleReviewConfig } from "../shared-style-followups/viteConfig";
import { browserSwitchBoundaries } from "./boundaries";

export default createStyleReviewConfig({ name: "browser-transport-switch", port: 5301, stubs: browserSwitchBoundaries });
