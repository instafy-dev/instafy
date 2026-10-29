import { createRoot } from "react-dom/client";
import { MemoryRouter, Route, Routes } from "react-router-dom";
import { CliLoginPage } from "../../../src/screens/CliLoginPage";
import "../../../src/styles/tailwind.css";

const params = new URLSearchParams(location.search);
document.documentElement.classList.toggle("dark", params.get("theme") === "dark");

// A session token as long as a real one, made of inert characters.
const user = { id: "cli-login-layout-user", is_anonymous: false };
const session = {
  access_token: `inert-review-access-token-${"x".repeat(780)}-end`,
  refresh_token: "inert-review-refresh-token",
  user,
};
declare global {
  interface Window {
    __cliLoginLayout: { auth: { session: typeof session; user: typeof user } };
  }
}
window.__cliLoginLayout = { auth: { session, user } };

// The address `instafy login` opens, from a CLI that prints the confirmation code.
const address = `/cli/login?${new URLSearchParams({
  serverUrl: "https://controller.example.test",
  cliCallbackUrl: "http://127.0.0.1:45678/callback",
  cliState: "0f1e2d3c4b5a69788796a5b4c3d2e1f0",
  cliCode: "1",
})}`;

createRoot(document.getElementById("root")!).render(
  <MemoryRouter initialEntries={[address]}>
    <Routes>
      <Route path="/cli/login" element={<CliLoginPage />} />
    </Routes>
  </MemoryRouter>,
);
