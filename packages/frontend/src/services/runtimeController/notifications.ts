import {
  controllerBaseUrl,
  readControllerError,
  resolveControllerRequestContext,
  runtimeControllerEnabled,
} from "./core";

export interface GetWebPushVapidPublicKeyResult {
  success: boolean;
  publicKey?: string;
  error?: string;
}

export async function getWebPushVapidPublicKey(): Promise<GetWebPushVapidPublicKeyResult> {
  if (!runtimeControllerEnabled || !controllerBaseUrl) {
    return { success: false, error: "Runtime controller is not configured." };
  }

  try {
    const response = await fetch(
      `${controllerBaseUrl}/notifications/web-push/vapid-public-key`,
      {
        headers: { accept: "application/json" },
      },
    );

    if (!response.ok) {
      const errorMessage = await readControllerError(
        response,
        "Unable to load Web Push configuration",
      );
      return { success: false, error: errorMessage };
    }

    const payload = (await response.json()) as Record<string, unknown>;
    const publicKey =
      typeof payload.publicKey === "string" ? payload.publicKey : null;
    if (!publicKey || publicKey.trim().length === 0) {
      return {
        success: false,
        error: "Controller response missing publicKey.",
      };
    }

    return { success: true, publicKey };
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    return {
      success: false,
      error: `Unable to load Web Push configuration: ${message}`,
    };
  }
}

export type WebPushSubscriptionKeys = {
  p256dh: string;
  auth: string;
};

export type WebPushSubscriptionPayload = {
  endpoint: string;
  keys: WebPushSubscriptionKeys;
};

export interface UpsertWebPushSubscriptionParams {
  subscription: WebPushSubscriptionPayload;
  userAgent?: string;
  accessToken?: string | null;
}

export interface UpsertWebPushSubscriptionResult {
  success: boolean;
  subscriptionId?: string;
  error?: string;
}

export async function upsertMyWebPushSubscription(
  params: UpsertWebPushSubscriptionParams,
): Promise<UpsertWebPushSubscriptionResult> {
  if (!runtimeControllerEnabled || !controllerBaseUrl) {
    return { success: false, error: "Runtime controller is not configured." };
  }

  const requestContext = await resolveControllerRequestContext(
    params.accessToken ?? null,
  );
  const resolvedAccessToken = requestContext.accessToken;
  if (!resolvedAccessToken) {
    return { success: false, error: "Missing controller session token." };
  }

  const endpoint = params.subscription.endpoint?.trim() ?? "";
  const p256dh = params.subscription.keys?.p256dh?.trim() ?? "";
  const auth = params.subscription.keys?.auth?.trim() ?? "";
  if (!endpoint || !p256dh || !auth) {
    return { success: false, error: "Invalid push subscription payload." };
  }

  try {
    const response = await fetch(
      `${requestContext.baseUrl}/me/notifications/web-push/subscription`,
      {
        method: "POST",
        headers: {
          authorization: `Bearer ${resolvedAccessToken}`,
          "content-type": "application/json",
          accept: "application/json",
        },
        body: JSON.stringify({
          endpoint,
          keys: { p256dh, auth },
          userAgent: params.userAgent,
        }),
      },
    );

    if (!response.ok) {
      const errorMessage = await readControllerError(
        response,
        "Unable to save Web Push subscription",
        requestContext,
      );
      return { success: false, error: errorMessage };
    }

    const payload = (await response.json()) as Record<string, unknown>;
    const subscriptionId =
      typeof payload.subscriptionId === "string"
        ? payload.subscriptionId
        : null;
    if (!subscriptionId || subscriptionId.trim().length === 0) {
      return {
        success: false,
        error: "Controller response missing subscriptionId.",
      };
    }

    return { success: true, subscriptionId };
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    return {
      success: false,
      error: `Unable to save Web Push subscription: ${message}`,
    };
  }
}

export interface RemoveWebPushSubscriptionParams {
  endpoint: string;
  accessToken?: string | null;
}

export interface RemoveWebPushSubscriptionResult {
  success: boolean;
  error?: string;
}

export async function removeMyWebPushSubscription(
  params: RemoveWebPushSubscriptionParams,
): Promise<RemoveWebPushSubscriptionResult> {
  if (!runtimeControllerEnabled || !controllerBaseUrl) {
    return { success: false, error: "Runtime controller is not configured." };
  }

  const requestContext = await resolveControllerRequestContext(
    params.accessToken ?? null,
  );
  const resolvedAccessToken = requestContext.accessToken;
  if (!resolvedAccessToken) {
    return { success: false, error: "Missing controller session token." };
  }

  const endpoint = params.endpoint?.trim() ?? "";
  if (!endpoint) {
    return { success: false, error: "endpoint is required." };
  }

  try {
    const response = await fetch(
      `${requestContext.baseUrl}/me/notifications/web-push/subscription/remove`,
      {
        method: "POST",
        headers: {
          authorization: `Bearer ${resolvedAccessToken}`,
          "content-type": "application/json",
          accept: "application/json",
        },
        body: JSON.stringify({ endpoint }),
      },
    );

    if (!response.ok) {
      const errorMessage = await readControllerError(
        response,
        "Unable to remove Web Push subscription",
        requestContext,
      );
      return { success: false, error: errorMessage };
    }

    return { success: true };
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    return {
      success: false,
      error: `Unable to remove Web Push subscription: ${message}`,
    };
  }
}

export interface UpsertNativePushTokenParams {
  token: string;
  platform?: "ios" | "android";
  environment?: "sandbox" | "production";
  accessToken?: string | null;
}

export interface UpsertNativePushTokenResult {
  success: boolean;
  tokenId?: string;
  error?: string;
}

export async function upsertMyNativePushToken(
  params: UpsertNativePushTokenParams,
): Promise<UpsertNativePushTokenResult> {
  if (!runtimeControllerEnabled || !controllerBaseUrl) {
    return { success: false, error: "Runtime controller is not configured." };
  }

  const requestContext = await resolveControllerRequestContext(
    params.accessToken ?? null,
  );
  const resolvedAccessToken = requestContext.accessToken;
  if (!resolvedAccessToken) {
    return { success: false, error: "Missing controller session token." };
  }

  const token = params.token?.trim() ?? "";
  if (!token) {
    return { success: false, error: "token is required." };
  }

  try {
    const response = await fetch(
      `${requestContext.baseUrl}/me/notifications/native-push/token`,
      {
        method: "POST",
        headers: {
          authorization: `Bearer ${resolvedAccessToken}`,
          "content-type": "application/json",
          accept: "application/json",
        },
        body: JSON.stringify({
          token,
          platform: params.platform,
          environment: params.environment,
        }),
      },
    );

    if (!response.ok) {
      const errorMessage = await readControllerError(
        response,
        "Unable to save native push token",
        requestContext,
      );
      return { success: false, error: errorMessage };
    }

    const payload = (await response.json()) as Record<string, unknown>;
    const tokenId =
      typeof payload.tokenId === "string" ? payload.tokenId : null;
    if (!tokenId || tokenId.trim().length === 0) {
      return { success: false, error: "Controller response missing tokenId." };
    }

    return { success: true, tokenId };
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    return { success: false, error: `Unable to save push token: ${message}` };
  }
}

export interface RemoveNativePushTokenParams {
  token: string;
  platform?: "ios" | "android";
  accessToken?: string | null;
}

export interface RemoveNativePushTokenResult {
  success: boolean;
  error?: string;
}

export async function removeMyNativePushToken(
  params: RemoveNativePushTokenParams,
): Promise<RemoveNativePushTokenResult> {
  if (!runtimeControllerEnabled || !controllerBaseUrl) {
    return { success: false, error: "Runtime controller is not configured." };
  }

  const requestContext = await resolveControllerRequestContext(
    params.accessToken ?? null,
  );
  const resolvedAccessToken = requestContext.accessToken;
  if (!resolvedAccessToken) {
    return { success: false, error: "Missing controller session token." };
  }

  const token = params.token?.trim() ?? "";
  if (!token) {
    return { success: false, error: "token is required." };
  }

  try {
    const response = await fetch(
      `${requestContext.baseUrl}/me/notifications/native-push/token/remove`,
      {
        method: "POST",
        headers: {
          authorization: `Bearer ${resolvedAccessToken}`,
          "content-type": "application/json",
          accept: "application/json",
        },
        body: JSON.stringify({
          token,
          platform: params.platform,
        }),
      },
    );

    if (!response.ok) {
      const errorMessage = await readControllerError(
        response,
        "Unable to remove native push token",
        requestContext,
      );
      return { success: false, error: errorMessage };
    }

    return { success: true };
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    return {
      success: false,
      error: `Unable to remove native push token: ${message}`,
    };
  }
}

export interface NotificationInboxItem {
  projectId: string;
  projectName?: string | null;
  orgId: string | null;
  orgName?: string | null;
  conversationId: string;
  conversationTitle?: string | null;
  lastMessageId: string;
  lastMessageAt: string;
  lastMessagePreview?: string | null;
  lastMessageType?: string | null;
}

export interface ListMyNotificationInboxParams {
  limit?: number;
  accessToken?: string | null;
}

export interface ListMyNotificationInboxResult {
  success: boolean;
  items?: NotificationInboxItem[];
  error?: string;
}

export async function listMyNotificationInbox(
  params: ListMyNotificationInboxParams = {},
): Promise<ListMyNotificationInboxResult> {
  if (!runtimeControllerEnabled || !controllerBaseUrl) {
    return { success: false, error: "Runtime controller is not configured." };
  }

  const requestContext = await resolveControllerRequestContext(
    params.accessToken ?? null,
  );
  const resolvedAccessToken = requestContext.accessToken;
  if (!resolvedAccessToken) {
    return { success: false, error: "Missing controller session token." };
  }

  const rawLimit = typeof params.limit === "number" ? params.limit : 25;
  const limit = Number.isFinite(rawLimit)
    ? Math.max(1, Math.min(100, Math.floor(rawLimit)))
    : 25;

  try {
    const url = new URL(`${requestContext.baseUrl}/me/notifications/inbox`);
    url.searchParams.set("limit", limit.toString());
    const response = await fetch(url.toString(), {
      headers: {
        authorization: `Bearer ${resolvedAccessToken}`,
        accept: "application/json",
      },
    });

    if (!response.ok) {
      const errorMessage = await readControllerError(
        response,
        "Unable to load inbox",
        requestContext,
      );
      return { success: false, error: errorMessage };
    }

    const payload = (await response.json().catch(() => null)) as {
      items?: unknown;
    } | null;

    const items = Array.isArray(payload?.items) ? payload?.items : [];
    const normalized: NotificationInboxItem[] = [];
    for (const entry of items) {
      if (!entry || typeof entry !== "object") {
        continue;
      }
      const record = entry as Record<string, unknown>;
      const projectId =
        typeof record.projectId === "string" ? record.projectId.trim() : "";
      const conversationId =
        typeof record.conversationId === "string"
          ? record.conversationId.trim()
          : "";
      const lastMessageId =
        typeof record.lastMessageId === "string"
          ? record.lastMessageId.trim()
          : "";
      const lastMessageAt =
        typeof record.lastMessageAt === "string"
          ? record.lastMessageAt.trim()
          : "";
      if (!projectId || !conversationId || !lastMessageId || !lastMessageAt) {
        continue;
      }

      normalized.push({
        projectId,
        projectName:
          typeof record.projectName === "string"
            ? record.projectName.trim()
            : record.projectName === null
              ? null
              : undefined,
        orgId:
          typeof record.orgId === "string"
            ? record.orgId.trim()
            : record.orgId === null
              ? null
              : null,
        orgName:
          typeof record.orgName === "string"
            ? record.orgName.trim()
            : record.orgName === null
              ? null
              : undefined,
        conversationId,
        conversationTitle:
          typeof record.conversationTitle === "string"
            ? record.conversationTitle.trim()
            : record.conversationTitle === null
              ? null
              : undefined,
        lastMessageId,
        lastMessageAt,
        lastMessagePreview:
          typeof record.lastMessagePreview === "string"
            ? record.lastMessagePreview.trim()
            : record.lastMessagePreview === null
              ? null
              : undefined,
        lastMessageType:
          typeof record.lastMessageType === "string"
            ? record.lastMessageType.trim()
            : record.lastMessageType === null
              ? null
              : undefined,
      });
    }

    return { success: true, items: normalized };
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    return { success: false, error: `Unable to load inbox: ${message}` };
  }
}

export interface AcknowledgeMyNotificationInboxItemParams {
  conversationId: string;
  accessToken?: string | null;
}

export interface AcknowledgeMyNotificationInboxItemResult {
  success: boolean;
  error?: string;
}

export async function acknowledgeMyNotificationInboxItem(
  params: AcknowledgeMyNotificationInboxItemParams,
): Promise<AcknowledgeMyNotificationInboxItemResult> {
  if (!runtimeControllerEnabled || !controllerBaseUrl) {
    return { success: false, error: "Runtime controller is not configured." };
  }

  const requestContext = await resolveControllerRequestContext(
    params.accessToken ?? null,
  );
  const resolvedAccessToken = requestContext.accessToken;
  if (!resolvedAccessToken) {
    return { success: false, error: "Missing controller session token." };
  }

  const conversationId = params.conversationId?.trim?.() ?? "";
  if (!conversationId) {
    return { success: false, error: "conversationId is required." };
  }

  try {
    const response = await fetch(`${requestContext.baseUrl}/me/notifications/inbox/ack`, {
      method: "POST",
      headers: {
        authorization: `Bearer ${resolvedAccessToken}`,
        "content-type": "application/json",
        accept: "application/json",
      },
      body: JSON.stringify({ conversationId }),
    });

    if (!response.ok) {
      const errorMessage = await readControllerError(
        response,
        "Unable to acknowledge inbox item",
        requestContext,
      );
      return { success: false, error: errorMessage };
    }

    return { success: true };
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    return { success: false, error: `Unable to acknowledge inbox item: ${message}` };
  }
}
