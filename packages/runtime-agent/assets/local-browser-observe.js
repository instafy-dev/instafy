const { chromium } = require(process.env.INSTAFY_LOCAL_BROWSER_PLAYWRIGHT_PATH);

const MAX_TEXT_CHARS = 4_000;
const MAX_TITLE_CHARS = 1_000;
const MAX_URL_CHARS = 4_096;
const MAX_STYLE_VALUE_CHARS = 1_000;
const MAX_SCREENSHOT_BYTES = 32 * 1024 * 1024;
const MAX_FULL_PAGE_PIXELS = 16_777_216;

function localProxyUrl() {
  const proxy = new URL(process.env.INSTAFY_LOCAL_BROWSER_PROXY_URL || "");
  if (
    proxy.protocol !== "http:" ||
    proxy.hostname !== "127.0.0.1" ||
    !proxy.port ||
    proxy.username ||
    proxy.password ||
    proxy.pathname !== "/" ||
    proxy.search ||
    proxy.hash
  ) {
    throw new Error("owner-local browser proxy must be an authenticated-process loopback URL");
  }
  return proxy.origin;
}

async function main() {
  const input = JSON.parse(process.argv[1]);
  let browser;
  try {
    browser = await chromium.launch({
      executablePath: process.env.INSTAFY_LOCAL_BROWSER_CHROMIUM_PATH,
      headless: true,
      chromiumSandbox: true,
      args: [
        `--proxy-server=${localProxyUrl()}`,
        "--proxy-bypass-list=<-loopback>",
        "--disable-quic",
        "--force-webrtc-ip-handling-policy=disable_non_proxied_udp",
      ],
    });
    const context = await browser.newContext({
      acceptDownloads: false,
      serviceWorkers: "block",
      viewport: { width: 1280, height: 720 },
    });
    const page = await context.newPage();
    await page.goto(input.url, {
      waitUntil: input.waitUntil,
      timeout: input.timeoutMs,
    });

    const observations = [];
    for (const requested of input.observations) {
      const locator = page.locator(requested.selector);
      const count = await locator.count();
      const first = locator.first();
      let text = null;
      let computedStyles = {};
      if (count > 0) {
        if (requested.text) {
          text = await first.evaluate(
            (element, maxChars) => (element.innerText || "").trim().slice(0, maxChars),
            MAX_TEXT_CHARS,
          );
        }
        if (requested.computedStyles.length > 0) {
          computedStyles = await first.evaluate((element, options) => {
            const style = globalThis.getComputedStyle(element);
            return Object.fromEntries(
              options.names.map((name) => [
                name,
                style.getPropertyValue(name).trim().slice(0, options.maxChars),
              ]),
            );
          }, { names: requested.computedStyles, maxChars: MAX_STYLE_VALUE_CHARS });
        }
      }
      observations.push({
        name: requested.name,
        selector: requested.selector,
        count,
        text,
        computedStyles,
      });
    }

    let screenshotDataBase64 = null;
    if (input.screenshot) {
      if (input.screenshot.fullPage) {
        const dimensions = await page.evaluate(() => ({
          width: Math.max(document.documentElement.scrollWidth, document.body?.scrollWidth || 0),
          height: Math.max(document.documentElement.scrollHeight, document.body?.scrollHeight || 0),
        }));
        if (dimensions.width * dimensions.height > MAX_FULL_PAGE_PIXELS) {
          throw new Error("full-page screenshot exceeds the local browser pixel limit");
        }
      }
      const bytes = await page.screenshot({
        type: "png",
        fullPage: input.screenshot.fullPage,
      });
      if (bytes.length === 0 || bytes.length > MAX_SCREENSHOT_BYTES) {
        throw new Error("screenshot is empty or exceeds the local browser size limit");
      }
      screenshotDataBase64 = bytes.toString("base64");
    }

    const finalLocation = await page.evaluate((maxChars) => ({
      value: globalThis.location.href.slice(0, maxChars),
      tooLong: globalThis.location.href.length > maxChars,
    }), MAX_URL_CHARS);
    if (finalLocation.tooLong) {
      throw new Error("final page URL exceeds the local browser size limit");
    }
    const title = await page.evaluate(
      (maxChars) => document.title.slice(0, maxChars),
      MAX_TITLE_CHARS,
    );

    process.stdout.write(JSON.stringify({
      requestedUrl: input.url,
      url: finalLocation.value,
      title,
      observations,
      screenshotDataBase64,
    }));
  } finally {
    if (browser) {
      await browser.close();
    }
  }
}

main().catch((error) => {
  process.stderr.write(`${error?.stack || error}\n`);
  process.exitCode = 1;
});
