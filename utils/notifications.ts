// utils/notifications.ts
/**
 * Notification Management Module
 * 
 * OVERVIEW:
 * This module handles all push notification functionality using Expo Notifications.
 * It manages notification permissions, schedules workout reminders, sends motivational
 * messages, and provides notification management utilities. Notifications help users
 * stay consistent with their workout schedule.
 * 
 * PURPOSE IN APP:
 * Notifications are critical for user engagement and workout consistency. They remind
 * users of scheduled workouts, provide motivational messages, and help maintain workout
 * habits. This module provides a complete notification system that respects user
 * preferences and device capabilities.
 * 
 * KEY FUNCTIONS:
 * 
 * 1. requestNotificationPermissions()
 *    - Requests notification permissions from user
 *    - Called during onboarding or when user enables notifications
 *    - Returns boolean indicating if permission was granted
 *    - Required before scheduling any notifications
 * 
 * 2. checkNotificationPermissions()
 *    - Checks current notification permission status
 *    - Used to determine if notifications can be scheduled
 *    - Returns boolean for permission state
 * 
 * 3. scheduleWorkoutReminder(time, workoutName)
 *    - Schedules a one-time workout reminder notification
 *    - Used for specific workout reminders
 *    - Includes workout name in notification body
 *    - Returns notification ID for cancellation if needed
 * 
 * 4. scheduleDailyReminders(workoutDays, reminderTime)
 *    - Schedules recurring weekly workout reminders
 *    - Creates notifications for each workout day at specified time
 *    - Repeats weekly automatically
 *    - Used to set up regular workout schedule reminders
 * 
 * 5. scheduleMotivationalMessage(time, message)
 *    - Schedules motivational messages
 *    - Can use custom message or random from predefined list
 *    - Helps maintain user motivation between workouts
 *    - Returns notification ID
 * 
 * 6. cancelNotification(notificationId)
 *    - Cancels a specific scheduled notification
 *    - Used when user dismisses or completes a workout
 *    - Prevents duplicate reminders
 * 
 * 7. cancelAllNotifications()
 *    - Cancels all scheduled notifications
 *    - Used when user disables notifications or logs out
 *    - Cleans up notification schedule
 * 
 * 8. getScheduledNotifications()
 *    - Retrieves all currently scheduled notifications
 *    - Used for debugging and notification management
 *    - Returns array of notification requests
 * 
 * 9. openAppSettings()
 *    - Opens device settings for the app
 *    - Used when user needs to enable notifications manually
 *    - Platform-specific (iOS vs Android)
 * 
 * 10. sendTestNotification()
 *     - Sends immediate test notification
 *     - Used for testing notification functionality
 *     - Helps verify notification setup
 * 
 * HOW IT WORKS:
 * - Uses Expo Notifications API for cross-platform notification support
 * - Configures notification handler for alert/sound behavior
 * - Loads notification logo asset for rich notifications
 * - Schedules notifications with specific triggers (date, weekly, etc.)
 * - Stores notification IDs for management and cancellation
 * - Handles notification permissions gracefully
 * 
 * INTEGRATION POINTS:
 * - Called from onboarding to request permissions
 * - Used by workout scheduling to set reminders
 * - Integrated with user profile for notification preferences
 * - Called from settings to manage notification schedule
 * - Used by workout completion to cancel reminders
 * 
 * NOTIFICATION TYPES:
 * - Workout reminders: Scheduled for workout days at user's preferred time
 * - Motivational messages: Random messages to maintain engagement
 * - Test notifications: For verification and debugging
 * 
 * DATA FLOW:
 * User Enables Notifications → requestNotificationPermissions() → Permission Granted
 * Workout Scheduled → scheduleDailyReminders() → Weekly Reminders Set
 * Workout Completed → cancelNotification() → Reminder Cancelled
 */

import { Asset } from 'expo-asset';
import * as Notifications from 'expo-notifications';
import { Linking, Platform } from 'react-native';

// Notification logo image - get URI for local asset
const NOTIFICATION_LOGO_ASSET = require('../assets/images/Lift.jpg');
let NOTIFICATION_LOGO_URI: string | null = null;

// Initialize notification logo URI
const initializeNotificationLogo = async (): Promise<string | null> => {
  if (NOTIFICATION_LOGO_URI) return NOTIFICATION_LOGO_URI;

  try {
    const asset = Asset.fromModule(NOTIFICATION_LOGO_ASSET);
    await asset.downloadAsync();
    NOTIFICATION_LOGO_URI = asset.localUri || asset.uri;
    return NOTIFICATION_LOGO_URI;
  } catch (error) {
    console.error('Error loading notification logo:', error);
    return null;
  }
};

// Configure notification behavior
Notifications.setNotificationHandler({
  handleNotification: async () => ({
    shouldShowBanner: true,
    shouldShowList: true,
    shouldPlaySound: true,
    shouldSetBadge: false,
  }),
});

// Android 8+ delivers nothing without a channel. Expo pushes sent without an
// explicit channelId land on "default", so make sure it exists and is loud
// enough to actually show a heads-up banner.
if (Platform.OS === 'android') {
  Notifications.setNotificationChannelAsync('default', {
    name: 'Reminders & coach messages',
    importance: Notifications.AndroidImportance.HIGH,
    vibrationPattern: [0, 250, 250, 250],
  }).catch(() => {});
}

/**
 * Request notification permissions from the user
 */
export const requestNotificationPermissions = async (): Promise<boolean> => {
  try {
    console.log('Requesting notification permissions...');

    const { status: existingStatus } = await Notifications.getPermissionsAsync();
    let finalStatus = existingStatus;

    if (existingStatus !== 'granted') {
      const { status } = await Notifications.requestPermissionsAsync();
      finalStatus = status;
    }

    const granted = finalStatus === 'granted';
    console.log(granted ? 'Notifications granted' : 'Notifications denied');

    return granted;
  } catch (error) {
    console.error('Error requesting notification permissions:', error);
    return false;
  }
};

/**
 * Check if notification permissions are currently granted
 */
export const checkNotificationPermissions = async (): Promise<boolean> => {
  try {
    const { status } = await Notifications.getPermissionsAsync();
    return status === 'granted';
  } catch (error) {
    console.error('Error checking notification permissions:', error);
    return false;
  }
};

/**
 * Schedule a workout reminder notification
 */
export const scheduleWorkoutReminder = async (time: Date, workoutName?: string): Promise<string | null> => {
  try {
    console.log('Scheduling workout reminder for:', time);

    const logoUri = await initializeNotificationLogo();

    const notificationId = await Notifications.scheduleNotificationAsync({
      content: {
        title: "Time to workout! 💪",
        body: workoutName ? `Your ${workoutName} is ready. Let's get moving!` : "Your workout is ready. Let's get moving!",
        sound: true,
        ...(logoUri && { image: logoUri }),
        data: { type: 'workout_reminder' },
      },
      trigger: {
        type: Notifications.SchedulableTriggerInputTypes.DATE,
        date: time,
      },
    });

    console.log('Workout reminder scheduled with ID:', notificationId);
    return notificationId;
  } catch (error) {
    console.error('Error scheduling workout reminder:', error);
    return null;
  }
};

/**
 * Schedule a motivational message
 */
export const scheduleMotivationalMessage = async (time: Date, message?: string): Promise<string | null> => {
  try {
    console.log('Scheduling motivational message for:', time);

    const motivationalMessages = [
      "You're stronger than you think! 💪",
      "Every workout counts! Keep going! 🔥",
      "Your future self will thank you! ⭐",
      "Progress, not perfection! You've got this! 🎯",
      "Consistency is key! You're doing great! 🌟"
    ];

    const selectedMessage = message || motivationalMessages[Math.floor(Math.random() * motivationalMessages.length)];

    const logoUri = await initializeNotificationLogo();

    const notificationId = await Notifications.scheduleNotificationAsync({
      content: {
        title: "Keep it up! 🎉",
        body: selectedMessage,
        sound: true,
        ...(logoUri && { image: logoUri }),
        data: { type: 'motivational' },
      },
      trigger: {
        type: Notifications.SchedulableTriggerInputTypes.DATE,
        date: time,
      },
    });

    console.log('Motivational message scheduled with ID:', notificationId);
    return notificationId;
  } catch (error) {
    console.error('Error scheduling motivational message:', error);
    return null;
  }
};

/**
 * Cancel a specific notification
 */
export const cancelNotification = async (notificationId: string): Promise<void> => {
  try {
    await Notifications.cancelScheduledNotificationAsync(notificationId);
    console.log('Notification cancelled:', notificationId);
  } catch (error) {
    console.error('Error cancelling notification:', error);
  }
};

/**
 * Cancel all scheduled notifications
 */
export const cancelAllNotifications = async (): Promise<void> => {
  try {
    await Notifications.cancelAllScheduledNotificationsAsync();
    console.log('All notifications cancelled');
  } catch (error) {
    console.error('Error cancelling all notifications:', error);
  }
};

/**
 * Get all scheduled notifications
 */
export const getScheduledNotifications = async (): Promise<Notifications.NotificationRequest[]> => {
  try {
    const notifications = await Notifications.getAllScheduledNotificationsAsync();
    console.log('Retrieved', notifications.length, 'scheduled notifications');
    return notifications;
  } catch (error) {
    console.error('Error getting scheduled notifications:', error);
    return [];
  }
};

/**
 * Open device settings for the app
 */
export const openAppSettings = (): void => {
  try {
    if (Platform.OS === 'ios') {
      Linking.openURL('app-settings:');
    } else {
      Linking.openSettings();
    }
    console.log('Opening app settings');
  } catch (error) {
    console.error('Error opening app settings:', error);
  }
};

/**
 * Schedule daily workout reminders based on user preferences
 */
export const scheduleDailyReminders = async (
  workoutDays: string[],
  reminderTime: string = '18:00'
): Promise<string[]> => {
  try {
    console.log('Scheduling daily reminders for days:', workoutDays);

    const [hours, minutes] = reminderTime.split(':').map(Number);
    const scheduledIds: string[] = [];

    const weekdayExpo: Record<string, number> = {
      sunday: 1,
      monday: 2,
      tuesday: 3,
      wednesday: 4,
      thursday: 5,
      friday: 6,
      saturday: 7,
    };

    for (const day of workoutDays) {
      const weekday = weekdayExpo[day.toLowerCase()];

      if (weekday !== undefined) {
        const trigger: Notifications.WeeklyTriggerInput = {
          type: Notifications.SchedulableTriggerInputTypes.WEEKLY,
          weekday,
          hour: hours,
          minute: minutes,
        };

        const logoUri = await initializeNotificationLogo();

        const notificationId = await Notifications.scheduleNotificationAsync({
          content: {
            title: "Workout Day! 💪",
            body: `Time for your ${day} workout. Let's make it count!`,
            sound: true,
            ...(logoUri && { image: logoUri }),
            data: { type: 'daily_reminder', day },
          },
          trigger,
        });

        scheduledIds.push(notificationId);
      }
    }

    console.log('Scheduled', scheduledIds.length, 'daily reminders');
    return scheduledIds;
  } catch (error) {
    console.error('Error scheduling daily reminders:', error);
    return [];
  }
};

/**
 * Send immediate test notification (for testing purposes)
 */
export const sendTestNotification = async (): Promise<void> => {
  try {
    const logoUri = await initializeNotificationLogo();

    await Notifications.scheduleNotificationAsync({
      content: {
        title: "Test Notification 🔔",
        body: "This is a test notification from LiftAI!",
        sound: true,
        ...(logoUri && { image: logoUri }),
        data: { type: 'test' },
      },
      trigger: null, // Send immediately
    });

    console.log('Test notification sent');
  } catch (error) {
    console.error('Error sending test notification:', error);
  }
};
