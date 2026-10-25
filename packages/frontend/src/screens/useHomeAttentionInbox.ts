import { useCallback, useEffect, useRef, useState } from "react";
import { NOTIFICATION_FEED_CHANGED_EVENT } from "../notifications/notificationFeedEvents";
import { NOTIFICATION_RECEIVED_EVENT } from "../notifications/notificationPresentation";
import { useGatedInterval } from "../runtime/pollingGate";
import { controllerClient, type NotificationInboxItem } from "../sdk/instafy";

// The inbox moves with replies, and replies arrive as notifications: the
// notification center's own check, a push and a conversation switch refresh it
// at once. This timer is only the fallback for an unseen reply that came with
// no notification.
export const HOME_ATTENTION_POLL_ACTIVE_MS = 120_000;
export const HOME_ATTENTION_POLL_IDLE_MS = 600_000;

/** Every account-wide unseen reply, for Home's attention count. */
export function useHomeAttentionInbox({
  currentUserId,
  visibleConversationControllerId,
}: {
  currentUserId: string | null;
  visibleConversationControllerId: string | null;
}) {
  const [items, setItems] = useState<NotificationInboxItem[]>([]);
  const requestRef = useRef<Promise<NotificationInboxItem[]> | null>(null);
  const epochRef = useRef(0);

  useEffect(() => {
    epochRef.current += 1;
    requestRef.current = null;
    setItems([]);
  }, [currentUserId]);

  const refresh = useCallback(async (
    options?: { force?: boolean },
  ): Promise<NotificationInboxItem[]> => {
    if (!currentUserId) {
      setItems([]);
      return [];
    }
    if (options?.force) {
      epochRef.current += 1;
      requestRef.current = null;
    }
    if (requestRef.current) {
      return requestRef.current;
    }

    const epoch = epochRef.current;
    const inflight = (async (): Promise<NotificationInboxItem[]> => {
      try {
        const result = await controllerClient.notifications.listInbox({ limit: 50 });
        if (epoch !== epochRef.current || !result.success) {
          return [];
        }

        // Visibility is presentation state, not acknowledgement. Keep the
        // complete server inbox so a reply hidden in the active chat can
        // surface as soon as the user switches to another conversation.
        const next = result.items ?? [];
        setItems(next);
        return next;
      } catch {
        return [];
      }
    })();

    requestRef.current = inflight;
    try {
      return await inflight;
    } finally {
      if (requestRef.current === inflight) {
        requestRef.current = null;
      }
    }
  }, [currentUserId]);

  useEffect(() => {
    if (typeof window === "undefined" || !currentUserId) {
      return;
    }
    // Conversation switches must not wait for the periodic poll: the reply in
    // the chat we just left may have landed since the previous refresh.
    void refresh({ force: true });
  }, [currentUserId, refresh, visibleConversationControllerId]);

  useEffect(() => {
    if (typeof window === "undefined" || !currentUserId) {
      return;
    }
    // A pushed notification, a local acknowledgement or a change the
    // notification center's check found changes the inbox now, so refresh
    // past any request that was already in flight.
    const receive = () => {
      void refresh({ force: true });
    };
    window.addEventListener(NOTIFICATION_RECEIVED_EVENT, receive);
    window.addEventListener(NOTIFICATION_FEED_CHANGED_EVENT, receive);
    return () => {
      window.removeEventListener(NOTIFICATION_RECEIVED_EVENT, receive);
      window.removeEventListener(NOTIFICATION_FEED_CHANGED_EVENT, receive);
    };
  }, [currentUserId, refresh]);

  // Every 2 min while active, every 10 min once idle, never while hidden. A
  // return reads it only when the last read is 2 min old or more; the
  // notification center's own check covers a quicker one.
  useGatedInterval(() => {
    if (currentUserId) {
      void refresh();
    }
  }, HOME_ATTENTION_POLL_ACTIVE_MS, { idleMs: HOME_ATTENTION_POLL_IDLE_MS, wakeAfterMs: HOME_ATTENTION_POLL_ACTIVE_MS });

  return { items, refresh };
}
