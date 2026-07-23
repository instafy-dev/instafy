export const INSTAFY_FEATURE_MODULE_API_VERSION: 1;

export type InstafyFeatureModuleApiVersion = typeof INSTAFY_FEATURE_MODULE_API_VERSION;

export type InstafyFeatureModule<TContributions extends object = Record<string, never>> = Readonly<
  {
    apiVersion: InstafyFeatureModuleApiVersion;
    id: string;
  } & TContributions
>;

export type InstafyFeatureModuleInput<
  TContributions extends object = Record<string, unknown>,
> = Readonly<
  {
    apiVersion: number;
    id: string;
  } & TContributions
>;

export function validateInstafyFeatureModules<TContributions extends object>(
  modules: readonly InstafyFeatureModuleInput<TContributions>[],
): readonly InstafyFeatureModule<TContributions>[];

export function defineInstafyFeatureModule<TContributions extends object>(
  module: InstafyFeatureModule<TContributions>,
): InstafyFeatureModule<TContributions>;

export function collectInstafyFeatureModuleContributions<
  TContributions extends object,
  TKey extends keyof TContributions & string,
>(
  modules: readonly InstafyFeatureModuleInput<TContributions>[],
  contributionKey: TKey,
): readonly (
  NonNullable<TContributions[TKey]> extends readonly (infer TContribution)[]
    ? TContribution
    : never
)[];
