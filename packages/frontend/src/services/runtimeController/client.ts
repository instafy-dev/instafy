import {
  controllerBaseUrl,
  readControllerError,
  resolveControllerRequestContext,
  runtimeControllerEnabled,
  type ControllerRequestContext,
} from "./core";

export type ControllerSearchParamValue = string | number | boolean | null | undefined;

export interface ControllerJsonRequestOptions {
  path: string;
  method?: "GET" | "POST" | "PATCH" | "PUT" | "DELETE";
  accessToken?: string | null;
  requestContext?: ControllerRequestContext;
  searchParams?: Record<string, ControllerSearchParamValue>;
  body?: unknown;
  headers?: HeadersInit;
  fallbackError: string;
  allowEmptyResponse?: boolean;
  /**
   * Adds `status` and `unanswered` to a failure, for a caller that must tell a
   * request the controller refused from one whose answer was lost.
   */
  describeFailure?: boolean;
}

export type ControllerJsonRequestSuccess<T> = {
  success: true;
  value: T;
  response: Response;
};

export type ControllerJsonRequestFailure = {
  success: false;
  error: string;
  /**
   * With `describeFailure`: the HTTP status of the error response, when the
   * controller (or a proxy) answered with one.
   */
  status?: number;
  /**
   * With `describeFailure`: the request was sent but no readable answer came
   * back (the connection failed or dropped, or the body could not be read), so
   * whether the controller acted on it is unknown. Absent when the request
   * was never sent.
   */
  unanswered?: true;
};

export type ControllerJsonRequestResult<T> =
  | ControllerJsonRequestSuccess<T>
  | ControllerJsonRequestFailure;

function buildControllerUrl(
  baseUrl: string,
  path: string,
  searchParams?: Record<string, ControllerSearchParamValue>,
) {
  const normalizedPath = path.startsWith("/") ? path : `/${path}`;
  const url = new URL(`${baseUrl}${normalizedPath}`);

  if (!searchParams) {
    return url;
  }

  for (const [key, value] of Object.entries(searchParams)) {
    if (value === null || value === undefined) {
      continue;
    }
    const normalized = String(value).trim();
    if (!normalized) {
      continue;
    }
    url.searchParams.set(key, normalized);
  }

  return url;
}

export async function controllerJsonRequest<T>(
  options: ControllerJsonRequestOptions,
): Promise<ControllerJsonRequestResult<T>> {
  if (!options.requestContext && (!runtimeControllerEnabled || !controllerBaseUrl)) {
    return { success: false, error: "Runtime controller is not configured." };
  }

  const requestContext =
    options.requestContext ?? await resolveControllerRequestContext(options.accessToken ?? null);
  if (!requestContext.baseUrl) {
    return { success: false, error: "Runtime controller is not configured." };
  }
  const accessToken = requestContext.accessToken;
  if (!accessToken) {
    return { success: false, error: "Missing controller session token." };
  }

  const url = buildControllerUrl(
    requestContext.baseUrl,
    options.path,
    options.searchParams,
  );
  const headers = new Headers(options.headers);
  headers.set("authorization", `Bearer ${accessToken}`);
  if (!headers.has("accept")) {
    headers.set("accept", "application/json");
  }

  let body: string | undefined;
  if (typeof options.body !== "undefined") {
    if (!headers.has("content-type")) {
      headers.set("content-type", "application/json");
    }
    body = JSON.stringify(options.body);
  }

  try {
    const response = await fetch(url.toString(), {
      method: options.method ?? (body ? "POST" : "GET"),
      headers,
      body,
    });

    if (!response.ok) {
      return {
        success: false,
        error: await readControllerError(
          response,
          options.fallbackError,
          requestContext,
        ),
        ...(options.describeFailure ? { status: response.status } : {}),
      };
    }

    if (options.allowEmptyResponse && (response.status === 204 || response.headers.get("content-length") === "0")) {
      return {
        success: true,
        value: undefined as T,
        response,
      };
    }

    const text = await response.text();
    if (options.allowEmptyResponse && text.trim().length === 0) {
      return {
        success: true,
        value: undefined as T,
        response,
      };
    }

    return {
      success: true,
      value: JSON.parse(text) as T,
      response,
    };
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    return {
      success: false,
      error: `${options.fallbackError}: ${message}`,
      ...(options.describeFailure ? { unanswered: true as const } : {}),
    };
  }
}
