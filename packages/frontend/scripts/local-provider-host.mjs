#!/usr/bin/env node

import {
  DEFAULT_LOCAL_PROVIDER_ID,
  LOCAL_PROVIDER_REGISTRATIONS,
  getLocalProviderRegistryHealthDetails,
} from "./current-local-provider-registry.mjs";
import {
  DEFAULT_LOCAL_PROVIDER_ALLOWED_ORIGINS,
  startLocalProviderHost,
} from "./local-provider-host-server.mjs";

const port = Number(process.env.LOCAL_PROVIDER_HOST_PORT || process.env.ROBOT_BRIDGE_PORT || 8797);
const host = process.env.LOCAL_PROVIDER_HOST_HOST || process.env.ROBOT_BRIDGE_HOST || "127.0.0.1";
const allowedOrigins =
  process.env.LOCAL_PROVIDER_HOST_ALLOWED_ORIGINS === undefined
    ? DEFAULT_LOCAL_PROVIDER_ALLOWED_ORIGINS
    : process.env.LOCAL_PROVIDER_HOST_ALLOWED_ORIGINS
        .split(",")
        .map((value) => value.trim())
        .filter(Boolean);

startLocalProviderHost({
  providers: LOCAL_PROVIDER_REGISTRATIONS,
  defaultProviderId: DEFAULT_LOCAL_PROVIDER_ID,
  host,
  port,
  allowedOrigins,
  getHealthDetails: getLocalProviderRegistryHealthDetails,
});
