export interface FrontendFeatureServices {
  get<TService>(serviceId: string): TService | null;
}

function requireServiceId(serviceId: string) {
  if (!/^[a-z0-9][a-z0-9._-]*$/.test(serviceId)) {
    throw new Error(`Invalid frontend feature service id ${JSON.stringify(serviceId)}.`);
  }
  return serviceId;
}

export function createFrontendFeatureServices(
  entries: Iterable<readonly [serviceId: string, service: unknown]>,
): FrontendFeatureServices {
  const services = new Map<string, unknown>();
  const seenServiceIds = new Set<string>();
  for (const [rawServiceId, service] of entries) {
    const serviceId = requireServiceId(rawServiceId);
    if (seenServiceIds.has(serviceId)) {
      throw new Error(`Duplicate frontend feature service id "${serviceId}".`);
    }
    seenServiceIds.add(serviceId);
    if (service !== null && service !== undefined) {
      services.set(serviceId, service);
    }
  }

  return Object.freeze({
    get<TService>(serviceId: string): TService | null {
      const normalizedServiceId = requireServiceId(serviceId);
      return (services.get(normalizedServiceId) as TService | undefined) ?? null;
    },
  });
}
