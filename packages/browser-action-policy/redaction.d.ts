export type RedactionResult = {
  text: string;
  /** Masked values that are not obvious placeholders. */
  matches: number;
  /** Every masked value. */
  masked: number;
};

export type PageSecretSignals = {
  credentialContext?: boolean;
  secretField?: boolean;
  secretCode?: boolean;
  maskedNearReveal?: boolean;
};

export type PageObservationInput = {
  url: string;
  title: string;
  text: string;
  names: Array<string | undefined>;
  signals?: PageSecretSignals | null;
  withhold?: boolean;
};

export type RedactedPageObservation = {
  url: string;
  title: string;
  text: string;
  names: Array<string | undefined>;
  secretScreen: boolean;
  message?: string;
};

export declare const TEXT_MASK: string;
export declare const URL_MASK: string;
export declare const KNOWN_SECRET_PATTERN_SOURCES: readonly string[];
export declare const CREDENTIAL_CONTEXT_SOURCE: string;
export declare const PLACEHOLDER_SOURCE: string;
export declare const MASKED_TEXT_SOURCE: string;
/** A one-time, backup or recovery code of digits (flags "g"). */
export declare const DIGIT_CODE_SOURCE: string;
/** A word that names a code (flags "iu"); a digit code just after one is masked. */
export declare const CODE_WORD_SOURCE: string;
/** How many characters before a digit code may hold its code word. */
export declare const CODE_NEARBY_CHARACTERS: number;
export declare const SECRET_SCREEN_MESSAGE: string;

export declare function hasCredentialWord(value: unknown): boolean;
export declare function looksRandom(value: unknown, minimumLength?: number): boolean;
export declare function matchesKnownFormat(value: unknown): boolean;
export declare function redactText(
  value: unknown,
  options?: { credentialContext?: boolean; strict?: boolean },
): RedactionResult;
export declare function redactUrl(value: unknown): RedactionResult;
export declare function redactPageObservation(input: PageObservationInput): RedactedPageObservation;
export declare function redactLogValue<T>(value: T, depth?: number): T;
