import { createStyleReviewConfig } from "../shared-style-followups/viteConfig";
import { statusFeedbackBoundaries } from "./boundaries";

export default createStyleReviewConfig({
  name: "status-feedback", port: 5392, stubs: statusFeedbackBoundaries,
});
