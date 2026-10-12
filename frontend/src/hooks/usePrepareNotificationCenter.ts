import { useCallback, useEffect, useMemo, useState } from "react";

import {
  getDraftNotifications,
  markAllDraftNotificationsRead,
  markDraftNotificationRead,
  type DraftNotification,
} from "@/lib/draftPromotion";
import {
  fetchPrepareNotifications,
  markAllPrepareNotificationsRead,
  markPrepareNotificationRead,
} from "@/lib/prepareNotifications";
import { setVisibleInterval } from "@/lib/visibleInterval.mjs";

function notifyChanged() {
  try {
    window.dispatchEvent(new CustomEvent("mwz:notifications-changed"));
  } catch {
    // ignore browser/event edge cases
  }
}

export function usePrepareNotificationCenter(walletAddress?: string | null, limit = 20) {
  const [notifications, setNotifications] = useState<DraftNotification[]>([]);
  const [usingApi, setUsingApi] = useState(false);
  const [loading, setLoading] = useState(false);

  const refresh = useCallback(async () => {
    const wallet = String(walletAddress || "").trim();

    if (!wallet) {
      setNotifications([]);
      setUsingApi(false);
      return;
    }

    setLoading(true);
    try {
      const items = await fetchPrepareNotifications(wallet, limit);
      setNotifications(items);
      setUsingApi(true);
    } catch {
      setNotifications(getDraftNotifications());
      setUsingApi(false);
    } finally {
      setLoading(false);
    }
  }, [walletAddress, limit]);

  useEffect(() => {
    let cancelled = false;

    const run = async () => {
      if (cancelled) return;
      await refresh();
    };

    void run();
    const onChange = () => void run();
    window.addEventListener("mwz:notifications-changed", onChange as EventListener);
    const stopPolling = setVisibleInterval(run, 30000);

    return () => {
      cancelled = true;
      window.removeEventListener("mwz:notifications-changed", onChange as EventListener);
      stopPolling();
    };
  }, [refresh]);

  const markOneRead = useCallback(
    async (id: string) => {
      if (!id) return;
      const wallet = String(walletAddress || "").trim();

      if (wallet && usingApi) {
        await markPrepareNotificationRead(wallet, id).catch(() => undefined);
        setNotifications((prev) => prev.map((item) => (item.id === id ? { ...item, read: true } : item)));
        notifyChanged();
        return;
      }

      markDraftNotificationRead(id);
      setNotifications(getDraftNotifications());
    },
    [walletAddress, usingApi],
  );

  const markAllRead = useCallback(async () => {
    const wallet = String(walletAddress || "").trim();

    if (wallet && usingApi) {
      await markAllPrepareNotificationsRead(wallet).catch(() => undefined);
      setNotifications((prev) => prev.map((item) => ({ ...item, read: true })));
      notifyChanged();
      return;
    }

    markAllDraftNotificationsRead();
    setNotifications(getDraftNotifications());
  }, [walletAddress, usingApi]);

  const unreadCount = useMemo(() => notifications.filter((item) => !item.read).length, [notifications]);

  return {
    notifications,
    unreadCount,
    loading,
    usingApi,
    refresh,
    markOneRead,
    markAllRead,
  };
}
