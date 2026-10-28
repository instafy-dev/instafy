import { createStyleReviewConfig } from "../shared-style-followups/viteConfig";
import { SUGGESTION_BROWSER_MENU_STUBS } from "./dataStubs";

export default createStyleReviewConfig({ name: "suggestion-browser-menus", port: 5313, stubs: SUGGESTION_BROWSER_MENU_STUBS });
