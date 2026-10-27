import { createStyleReviewConfig } from "../shared-style-followups/viteConfig";
import { electronSwitchBoundaries } from "./boundaries";

const config = createStyleReviewConfig({ name: "electron-browser-switch", port: 5305, stubs: electronSwitchBoundaries });
config.plugins ??= [];
config.plugins.push({
  name: "electron-switch-local-identity",
  configureServer(server) {
    server.middlewares.use((request, response, next) => {
      response.setHeader("Cache-Control", "no-store");
      if (request.url === "/me/session") {
        const bearer = request.headers.authorization?.replace(/^Bearer\s+/i, "") ?? "";
        let userId = "";
        try { userId = JSON.parse(Buffer.from(bearer.split(".")[1] ?? "", "base64url").toString("utf8")).sub ?? ""; } catch { /* Inert local identity only. */ }
        response.statusCode = userId === "22222222-2222-4222-8222-222222222222" ? 200 : 401;
        response.setHeader("Content-Type", "application/json");
        response.end(JSON.stringify(response.statusCode === 200 ? { userId } : { error: "unauthorized" }));
      } else if (request.url === "/native-page") {
        response.setHeader("Content-Type", "text/html; charset=utf-8");
        response.end(`<!doctype html><title>Personal project notes</title><meta name="viewport" content="width=device-width, initial-scale=1"><style>
          *{box-sizing:border-box}body{margin:0;font:16px system-ui;background:#f1f5f9;color:#293b4b}header{padding:28px 24px;background:#5c407c;color:white}h1{font-size:26px;margin:0 0 12px}main{padding:24px}section{background:white;padding:20px;margin:0 0 20px;border-radius:12px;min-height:210px}input{display:block;width:100%;max-width:480px;padding:12px;margin-top:12px;border:1px solid #b4bfca;border-radius:8px;font:inherit}p{line-height:1.6}
          </style><header><h1>This device browser</h1><p>Real Electron WebContentsView · local project notes</p></header><main><section><h2>Research</h2><label>Draft note<input id="draft" value="Compare the screenshots"></label><p>This page stays alive when you switch to the workspace browser.</p></section><section><h2>Design</h2><p>Keep the page, draft, and scroll position while changing browser location.</p></section><section><h2>Next steps</h2><p>Review both directions and a menu opened during resize.</p></section><section><h2>Reference notes</h2><p>Local disposable content; no account or remote browser is connected.</p></section><section><h2>End of notes</h2></section></main>`);
      } else next();
    });
  },
});
export default config;
