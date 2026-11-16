import { useEffect, useRef } from 'react';
import * as Notifications from 'expo-notifications';

interface UseRestTimerNotificationsArgs {
  restEndTime: number | null;
  enabled?: boolean;
}

export function useRestTimerNotifications({ restEndTime, enabled = true }: UseRestTimerNotificationsArgs) {
  const scheduledIdRef = useRef<string | null>(null);

  useEffect(() => {
    const syncNotification = async () => {
      if (!enabled) return;

      if (scheduledIdRef.current) {
        try {
          await Notifications.cancelScheduledNotificationAsync(scheduledIdRef.current);
        } catch {
          // No-op: old notification may have already fired/expired.
        } finally {
          scheduledIdRef.current = null;
        }
      }

      if (!restEndTime || restEndTime <= Date.now()) return;

      try {
        const { status } = await Notifications.getPermissionsAsync();
        if (status !== 'granted') return;

        const notificationId = await Notifications.scheduleNotificationAsync({
          content: {
            title: 'Rest complete',
            body: 'Time for your next set.',
            sound: true,
          },
          trigger: {
            type: Notifications.SchedulableTriggerInputTypes.DATE,
            date: new Date(restEndTime),
          },
        });
        scheduledIdRef.current = notificationId;
      } catch {
        // Notifications are optional; avoid blocking workout flow.
      }
    };

    void syncNotification();

    return () => {
      if (scheduledIdRef.current) {
        Notifications.cancelScheduledNotificationAsync(scheduledIdRef.current).catch(() => undefined);
        scheduledIdRef.current = null;
      }
    };
  }, [restEndTime, enabled]);
}
