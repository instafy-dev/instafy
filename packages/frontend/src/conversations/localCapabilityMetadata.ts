function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

export function isMetadataRecord(value: unknown): value is Record<string, unknown> {
  return isRecord(value);
}

export function mergeLocalCapabilityMetadata(
  ...sources: Array<Record<string, unknown> | null | undefined>
): Record<string, unknown> | null {
  const merged: Record<string, unknown> = {};
  let sawAny = false;

  for (const source of sources) {
    if (!source) {
      continue;
    }
    Object.assign(merged, source);
    sawAny = true;
  }

  for (const nestedKey of ["agent", "localCapability", "robotLearning", "cameraRequest"]) {
    let nestedMerged: Record<string, unknown> = {};
    let sawNested = false;
    let sawNonRecord = false;
    let nonRecordValue: unknown;
    for (const source of sources) {
      if (!source || !Object.prototype.hasOwnProperty.call(source, nestedKey)) {
        continue;
      }
      const nested = source[nestedKey];
      if (!isRecord(nested)) {
        nestedMerged = {};
        sawNested = false;
        sawNonRecord = true;
        nonRecordValue = nested;
        continue;
      }
      if (sawNonRecord) {
        nestedMerged = {};
        sawNonRecord = false;
        nonRecordValue = undefined;
      }
      Object.assign(nestedMerged, nested);
      sawNested = true;
    }
    if (sawNested) {
      merged[nestedKey] = nestedMerged;
    } else if (sawNonRecord) {
      merged[nestedKey] = nonRecordValue;
    }
  }

  return sawAny ? merged : null;
}
