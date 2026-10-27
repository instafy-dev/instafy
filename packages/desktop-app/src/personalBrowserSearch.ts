// Address-bar search in the Personal Browser: words a person types that are not
// an address open a search on the engine they picked, in their own browser.
//
// Which engines there are, and their search links, is the instafy-web-research
// skill's data (references/search-engines.json). The build bundles that file,
// as it bundles the skill's link-only list; Desktop only checks and uses it. A
// list that does not check out offers no search, and the address bar works as
// it did before.
//
// These searches are the person's own. Octo never searches through them: it
// does not open these links, and an engine's own pages may be link-only for it.
import bundledSearchEngines from "virtual:instafy/search-engines";

export const SEARCH_ENGINES_SCHEMA = "instafy.search-engines@1";
/** The longest search a person can type; longer text is cut. */
export const MAX_SEARCH_QUERY_CHARS = 2_048;
const MAX_ENGINES = 20;
const QUERY_PLACEHOLDER = "{query}";

/** The list as the build bundled it, before any check. */
export const BUNDLED_SEARCH_ENGINES: unknown = bundledSearchEngines;

export type PersonalBrowserSearchEngine = { id: string; name: string; search: string };
export type PersonalBrowserSearchEngines = { engines: PersonalBrowserSearchEngine[]; defaultId: string };
/** What Studio shows in the address bar's settings: names only, never the links. */
export type PersonalBrowserSearchChoice = { engines: Array<{ id: string; name: string }>; selected: string | null };

/** Whether a search link is one Desktop opens: https, a public name, no user or password, one {query}. */
function checkSearchLink(template: unknown): template is string {
  if (typeof template !== "string" || template.length > 512) return false;
  if (template.split(QUERY_PLACEHOLDER).length !== 2) return false;
  let url: URL;
  try {
    url = new URL(template.replace(QUERY_PLACEHOLDER, "q"));
  } catch {
    return false;
  }
  const host = url.hostname.toLowerCase();
  // The query goes after the host, in the path or the query string, never into the host itself.
  const queryAt = template.indexOf(QUERY_PLACEHOLDER);
  const hostEnd = template.indexOf("/", "https://".length);
  return (
    url.protocol === "https:" &&
    !url.username &&
    !url.password &&
    !url.port &&
    hostEnd > 0 &&
    queryAt > hostEnd &&
    /^(?:[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?\.)+[a-z]{2,63}$/.test(host) &&
    !/(?:^|\.)localhost$/.test(host)
  );
}

/** The engines of one copy of the list, or null when the list does not check out. */
export function parseSearchEngines(data: unknown): PersonalBrowserSearchEngines | null {
  if (!data || typeof data !== "object") return null;
  const list = data as { schema?: unknown; default?: unknown; engines?: unknown };
  if (list.schema !== SEARCH_ENGINES_SCHEMA || !Array.isArray(list.engines)) return null;
  if (list.engines.length === 0 || list.engines.length > MAX_ENGINES) return null;
  const engines: PersonalBrowserSearchEngine[] = [];
  for (const entry of list.engines) {
    const { id, name, search } = (entry ?? {}) as { id?: unknown; name?: unknown; search?: unknown };
    if (typeof id !== "string" || !/^[a-z0-9][a-z0-9-]{0,31}$/.test(id)) return null;
    if (typeof name !== "string" || !name.trim() || name.length > 60) return null;
    if (!checkSearchLink(search)) return null;
    if (engines.some((engine) => engine.id === id)) return null;
    engines.push({ id, name: name.trim(), search });
  }
  if (typeof list.default !== "string" || !engines.some((engine) => engine.id === list.default)) return null;
  return { engines, defaultId: list.default };
}

/** The bundled list, checked once. Null offers no search. */
export const PERSONAL_BROWSER_SEARCH_ENGINES = parseSearchEngines(BUNDLED_SEARCH_ENGINES);

/** The engine a person picked, or the list's default when they picked none or one the list no longer has. */
export function selectedSearchEngine(
  list: PersonalBrowserSearchEngines | null,
  pickedId: unknown,
): PersonalBrowserSearchEngine | null {
  if (!list) return null;
  return (
    list.engines.find((engine) => engine.id === pickedId) ??
    list.engines.find((engine) => engine.id === list.defaultId) ??
    null
  );
}

/** The engines and the one in use, as Studio's settings list them. */
export function searchChoice(list: PersonalBrowserSearchEngines | null, pickedId: unknown): PersonalBrowserSearchChoice {
  return {
    engines: list ? list.engines.map(({ id, name }) => ({ id, name })) : [],
    selected: selectedSearchEngine(list, pickedId)?.id ?? null,
  };
}

/** The address of a search for these words on this engine, or null when there are no words. */
export function searchAddress(engine: PersonalBrowserSearchEngine, query: unknown): string | null {
  if (typeof query !== "string") return null;
  const words = query.replace(/\s+/g, " ").trim().slice(0, MAX_SEARCH_QUERY_CHARS);
  if (!words) return null;
  const address = engine.search.replace(QUERY_PLACEHOLDER, encodeURIComponent(words));
  try {
    return new URL(address).href;
  } catch {
    return null;
  }
}
