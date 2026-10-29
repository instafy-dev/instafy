import { createStyleReviewConfig } from "../shared-style-followups/viteConfig";
import { browserKeyboardStatusBoundaries } from "./boundaries";

export default createStyleReviewConfig({
  name: "browser-keyboard-status", port: 5331, stubs: browserKeyboardStatusBoundaries,
});
