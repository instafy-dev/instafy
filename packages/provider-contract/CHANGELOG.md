# @instafy/provider-contract

## 0.2.0

### Minor Changes

- e46aad1: The evaluation, recommendation, comparison and applied-update envelopes are removed. The package root and `@instafy/provider-contract/provider-core` no longer export `createProviderEvaluationReport`, `createProviderRecommendation`, `createProviderComparisonSummary` or `createProviderAppliedUpdate`, or the types `ProviderEvaluationReport`, `ProviderRecommendation`, `ProviderComparisonSummary` and `ProviderAppliedUpdate`. Instafy itself never created any of these envelopes, and nothing in it has read one since the hosted web app's vendored robot slice was removed. This is a breaking change: a provider that imports one of these names fails to type-check or load until it drops the import or keeps its own copy of the shape. Everything else is unchanged: discovery, the tool-call and resource-read envelopes, the runtime, execution, event and artifact-reference envelopes, the provider manifest and host-surface declarations, the UI-surface sandbox messages and the built-in provider metadata.

## 0.1.2

### Patch Changes

- 18d7ba6: Add the neutral provider core, sandbox, bounded UI-surface, built-in provider, evaluation,
  recommendation, comparison, and applied-update contracts while retaining the existing discovery
  and invocation exports.
