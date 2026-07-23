import type { Page } from "@playwright/test";

export type ViteReactDependencies = {
  react: string;
  reactDomClient: string;
};

/**
 * Resolve Vite's real optimized dependency URLs instead of fabricating one
 * package's cache query from another. Clean Vite servers may assign React and
 * ReactDOM different optimizer hashes.
 */
export async function resolveViteReactDependencies(
  page: Page,
): Promise<ViteReactDependencies> {
  const response = await page.request.get("/src/main.tsx");
  if (!response.ok()) {
    throw new Error(
      `Vite could not transform the frontend entrypoint (${response.status()})`,
    );
  }

  const body = await response.text();
  const react = body.match(
    /["'](\/node_modules\/\.vite\/deps\/react\.js\?v=[^"']+)["']/,
  )?.[1];
  const reactDomClient = body.match(
    /["'](\/node_modules\/\.vite\/deps\/react-dom_client\.js\?v=[^"']+)["']/,
  )?.[1];
  if (!react || !reactDomClient) {
    throw new Error("Could not resolve the frontend entrypoint's Vite dependencies");
  }

  const [reactResponse, reactDomClientResponse] = await Promise.all([
    page.request.get(react),
    page.request.get(reactDomClient),
  ]);
  if (!reactResponse.ok()) {
    throw new Error(`Vite React dependency returned ${reactResponse.status()}: ${react}`);
  }
  if (!reactDomClientResponse.ok()) {
    throw new Error(
      `Vite ReactDOM dependency returned ${reactDomClientResponse.status()}: ${reactDomClient}`,
    );
  }

  return { react, reactDomClient };
}
