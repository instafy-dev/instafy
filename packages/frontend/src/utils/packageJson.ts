export function extractDependenciesFromPackageJson(json: string): string[] {
  try {
    const parsed = JSON.parse(json) as {
      dependencies?: Record<string, string>;
      devDependencies?: Record<string, string>;
    };
    const names = new Set<string>();
    if (parsed.dependencies) {
      Object.keys(parsed.dependencies).forEach((name) => names.add(name));
    }
    if (parsed.devDependencies) {
      Object.keys(parsed.devDependencies).forEach((name) => names.add(name));
    }
    return Array.from(names).sort((a, b) => a.localeCompare(b));
  } catch (error) {
    return [];
  }
}
