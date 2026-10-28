import { createStyleReviewConfig } from "../shared-style-followups/viteConfig";
import { BROWSER_APPROVAL_FEEDBACK_STUBS } from "./dataStubs";

export default createStyleReviewConfig({ name: "browser-approval-feedback", port: 5323, stubs: BROWSER_APPROVAL_FEEDBACK_STUBS });
