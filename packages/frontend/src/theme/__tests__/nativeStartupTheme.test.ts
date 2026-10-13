import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

/**
 * Between the native launch screen and ThemeProvider's first StatusBar sync,
 * the system bars and the WebView are painted only by native startup state.
 * Under a dark system theme that state must already be dark: the launch screen
 * is the dark canvas, so a white status bar or a white WebView in between is a
 * visible flash (Android before 15 colors the bar; Android 15+ draws the
 * WebView under a transparent one).
 */
const __dirname = path.dirname(fileURLToPath(import.meta.url));
const frontendRoot = path.resolve(__dirname, "..", "..", "..");
const read = (...segments: string[]) => fs.readFileSync(path.join(frontendRoot, ...segments), "utf8");

const themeProvider = read("src", "theme", "ThemeProvider.tsx");
const capacitorConfig = read("capacitor.config.ts");
const androidRes = ["android", "app", "src", "main", "res"];
const mainActivity = read("android", "app", "src", "main", "java", "dev", "instafy", "studio", "MainActivity.java");

function themeColors(name: string): { light: string; dark: string } {
  const block = themeProvider.match(new RegExp(`const ${name} = \\{([^}]*)\\}`))?.[1] ?? "";
  const light = block.match(/light:\s*"(#[0-9a-f]{6})"/i)?.[1];
  const dark = block.match(/dark:\s*"(#[0-9a-f]{6})"/i)?.[1];
  if (!light || !dark) {
    throw new Error(`ThemeProvider.tsx no longer declares ${name} as light/dark hex colors`);
  }
  return { light: light.toLowerCase(), dark: dark.toLowerCase() };
}

function splashBackground(valuesDirectory: string): string {
  const xml = read(...androidRes, valuesDirectory, "splash_background.xml");
  const color = xml.match(/<color name="splash_background">(#[0-9a-f]{6})<\/color>/i)?.[1];
  if (!color) {
    throw new Error(`${valuesDirectory}/splash_background.xml has no splash_background color`);
  }
  return color.toLowerCase();
}

const statusBar = themeColors("NATIVE_STATUS_BAR_BACKGROUND");
const canvas = themeColors("BROWSER_THEME_COLOR");

describe("native startup theme before ThemeProvider runs", () => {
  it("keeps the static StatusBar config as the light pair (and the iOS default)", () => {
    const block = capacitorConfig.match(/StatusBar:\s*\{([^}]*)\}/)?.[1] ?? "";
    expect(block).toContain(`backgroundColor: "${statusBar.light}"`);
    expect(block).toContain('style: "LIGHT"');
    expect(block).toContain("overlaysWebView: false");
  });

  it("hands the Android StatusBar plugin the dark pair under a night system theme", () => {
    expect(mainActivity).toContain(`DARK_STATUS_BAR_BACKGROUND = "${statusBar.dark}"`);
    expect(mainActivity).toMatch(/uiMode\s*&\s*Configuration\.UI_MODE_NIGHT_MASK/);
    expect(mainActivity).toContain("nightMode != Configuration.UI_MODE_NIGHT_YES");
    expect(mainActivity).toContain('getPluginConfiguration("StatusBar")');
    expect(mainActivity).toContain('statusBar.put("backgroundColor", DARK_STATUS_BAR_BACKGROUND)');
    expect(mainActivity).toContain('statusBar.put("style", "DARK")');
    expect(mainActivity).toContain("config = capConfig;");

    // The plugin reads its config while the bridge loads inside super.onCreate.
    const onCreate = mainActivity.slice(mainActivity.indexOf("protected void onCreate"));
    const override = onCreate.indexOf("useNightStartupStatusBar();");
    expect(override).toBeGreaterThan(-1);
    expect(override).toBeLessThan(onCreate.indexOf("super.onCreate(savedInstanceState);"));
  });

  it("paints the Android WebView with the launch canvas until the page does", () => {
    expect(splashBackground("values")).toBe(canvas.light);
    expect(splashBackground("values-night")).toBe(canvas.dark);
    expect(mainActivity).toContain("webView.setBackgroundColor(getColor(R.color.splash_background))");

    const onCreate = mainActivity.slice(mainActivity.indexOf("protected void onCreate"));
    const paint = onCreate.indexOf("paintWebViewWithLaunchCanvas();");
    expect(paint).toBeGreaterThan(onCreate.indexOf("super.onCreate(savedInstanceState);"));

    // MainActivity handles uiMode itself, so a live theme switch must repaint too.
    const configurationChanged = mainActivity.slice(mainActivity.indexOf("public void onConfigurationChanged"));
    expect(configurationChanged.slice(0, configurationChanged.indexOf("\n    }"))).toContain(
      "paintWebViewWithLaunchCanvas();",
    );
  });
});
