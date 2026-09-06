import { controllerClient } from "../sdk/instafy";
import { parseNotificationClickUrl } from "./notificationContract";
import { NOTIFICATION_RECEIVED_EVENT } from "./notificationPresentation";

export interface ProcessNotificationClickOptions {
  url: string;
  userId: string | null;
  accessToken: string | null;
  isCurrent: () => boolean;
  openResource: (resourceUrl: string) => void | Promise<void>;
}
export type ProcessNotificationClickResult = {
  status: "pending" | "ignored" | "opened";
  resourceUrl?: string;
};

/** Run only at the authenticated destination, never when a push is received. */
export async function processNotificationClickDestination(options: ProcessNotificationClickOptions): Promise<ProcessNotificationClickResult> {
  const click = parseNotificationClickUrl(options.url);
  if (!click) return { status: "ignored" };
  if (!options.userId || !options.accessToken) return { status: "pending", resourceUrl: click.resourceUrl };
  if (click.accountId !== options.userId || !options.isCurrent()) {
    return { status: "ignored", resourceUrl: click.resourceUrl };
  }
  await options.openResource(click.resourceUrl);
  if (!options.isCurrent()) return { status: "ignored", resourceUrl: click.resourceUrl };
  await controllerClient.notifications.updateState({ id: click.eventId, action: "read", accessToken: options.accessToken });
  if (options.isCurrent()) window.dispatchEvent(new Event(NOTIFICATION_RECEIVED_EVENT));
  return { status: "opened", resourceUrl: click.resourceUrl };
}
