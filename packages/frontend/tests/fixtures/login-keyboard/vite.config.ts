import { createStyleReviewConfig } from "../shared-style-followups/viteConfig";
import { loginKeyboardBoundaries } from "./boundaries";

export default createStyleReviewConfig({ name: "login-keyboard", port: 5337, stubs: loginKeyboardBoundaries });
