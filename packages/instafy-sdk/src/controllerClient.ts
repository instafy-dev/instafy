type AnyFunction = (...args: never[]) => unknown;

type ControllerClientCoreModule = {
  enabled: boolean;
  baseUrl: string;
  clearAccessTokenOverride: AnyFunction;
  coerceRuntimeIdleTtlSeconds: AnyFunction;
  jsonRequest: AnyFunction;
  normalizeOriginEndpointForClient: AnyFunction;
};

type ControllerClientModule = Record<string, AnyFunction | Record<string, AnyFunction>>;

export interface ControllerClientModules {
  core: ControllerClientCoreModule;
  agents: ControllerClientModule;
  credentials: ControllerClientModule;
  projects: ControllerClientModule;
  organizations: ControllerClientModule;
  conversations: ControllerClientModule;
  runtimes: ControllerClientModule;
  integrations: ControllerClientModule;
  workspace: {
    files: ControllerClientModule;
    git: ControllerClientModule;
    origin: ControllerClientModule;
  };
  completions: ControllerClientModule;
  bugReports: ControllerClientModule;
}

type DeepReadonly<T> = {
  readonly [K in keyof T]: T[K] extends (...args: infer A) => infer R
    ? (...args: A) => R
    : T[K] extends object
      ? DeepReadonly<T[K]>
      : T[K];
};

function deepFreeze<T>(value: T): DeepReadonly<T> {
  if (value && typeof value === "object") {
    for (const nested of Object.values(value as Record<string, unknown>)) {
      if (nested && typeof nested === "object") {
        deepFreeze(nested);
      }
    }
    Object.freeze(value);
  }
  return value as DeepReadonly<T>;
}

export type ControllerClient<T extends ControllerClientModules = ControllerClientModules> = DeepReadonly<T>;

export function createControllerClient<const T extends ControllerClientModules>(modules: T): ControllerClient<T> {
  return deepFreeze(modules);
}
