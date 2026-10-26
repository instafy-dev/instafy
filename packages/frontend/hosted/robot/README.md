# Robot integration slice (vendored)

This directory is a generated copy of the robot integration's hosted-web
feature module, its provider family descriptor and its generated robot
contract. Wire identifiers (provider id, tool ids, resource URIs and native
plugin names) are kept verbatim because deployed backends and native apps
depend on them.

Do not edit these files by hand. They are re-exported from the upstream
integration, and the hosted web release refuses a slice that differs from the
reviewed upstream export. `index.ts` is the neutral entry point used by
`../hostedFrontendFeatureManifest.ts`; it and this README are the only files
not copied from upstream.

Robot Lab (`frontend/screens/RobotLabPage.tsx`, `frontend/screens/robot-lab/`)
is development-only: `frontend/developmentFlags.ts` gates it on
`import.meta.env.DEV`, so production bundles do not contain it.
