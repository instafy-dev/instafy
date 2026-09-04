export { controllerClient } from "../sdk/instafy/controllerClient";
// Feature modules composed from outside this repository (the private feature
// manifest) destructure these helpers from this module's namespace at
// runtime. They lived here before the open-source split and the split
// dropped them, which left those callers destructuring `undefined` in the
// hosted composition only — the packaged desktop build never mounts them.
// Keep the surface stable; see the companion test.
export {
  getProjectIntegrationByProvider,
  getProjectProviderSelectedDevice,
} from "../capabilities/projectProviderAccess";
