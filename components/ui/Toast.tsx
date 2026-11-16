/**
 * Toast — global, imperative toast system.
 *
 * Usage (from anywhere, no hooks needed):
 *   import { toast } from '../components/ui/Toast';
 *   toast.success('Exercise added');
 *   toast.error('Could not save changes');
 *   toast.info('Synced');
 *
 * `ToastHost` must be mounted once, inside ThemeProvider (see app/_layout.tsx).
 * Replaces native Alert.alert for non-blocking feedback: success/info/errors
 * that don't need a decision. Decisions go through ConfirmSheet instead.
 */

import { Ionicons } from '@expo/vector-icons';
import * as Haptics from 'expo-haptics';
import React, { useCallback, useEffect, useRef, useState } from 'react';
import { Animated, Easing, Platform, Pressable, StyleSheet, Text, View } from 'react-native';
import { useSafeAreaInsets } from 'react-native-safe-area-context';

import { borderRadius, getThemeColors, typography } from '../../constants/theme';
import { useTheme } from '../../context/ThemeContext';

type ToastType = 'success' | 'error' | 'info';

interface ToastPayload {
  id: number;
  type: ToastType;
  title: string;
  message?: string;
}

type Listener = (payload: ToastPayload) => void;

let listener: Listener | null = null;
let nextId = 1;

function emit(type: ToastType, title: string, message?: string) {
  listener?.({ id: nextId++, type, title, message });
}

export const toast = {
  success: (title: string, message?: string) => emit('success', title, message),
  error: (title: string, message?: string) => emit('error', title, message),
  info: (title: string, message?: string) => emit('info', title, message),
};

const AUTO_DISMISS_MS = 3500;

export function ToastHost() {
  const { isDark } = useTheme();
  const colors = getThemeColors(isDark);
  const insets = useSafeAreaInsets();

  const [current, setCurrent] = useState<ToastPayload | null>(null);
  const translateY = useRef(new Animated.Value(-120)).current;
  const opacity = useRef(new Animated.Value(0)).current;
  const hideTimer = useRef<ReturnType<typeof setTimeout> | null>(null);

  const hide = useCallback(() => {
    if (hideTimer.current) {
      clearTimeout(hideTimer.current);
      hideTimer.current = null;
    }
    Animated.parallel([
      Animated.timing(translateY, { toValue: -120, duration: 180, easing: Easing.in(Easing.ease), useNativeDriver: true }),
      Animated.timing(opacity, { toValue: 0, duration: 180, useNativeDriver: true }),
    ]).start(({ finished }) => {
      if (finished) setCurrent(null);
    });
  }, [translateY, opacity]);

  const show = useCallback(
    (payload: ToastPayload) => {
      if (hideTimer.current) clearTimeout(hideTimer.current);
      setCurrent(payload);
      translateY.setValue(-120);
      opacity.setValue(0);
      Animated.parallel([
        Animated.spring(translateY, { toValue: 0, useNativeDriver: true, damping: 18, stiffness: 220, mass: 0.8 }),
        Animated.timing(opacity, { toValue: 1, duration: 200, useNativeDriver: true }),
      ]).start();
      if (Platform.OS === 'ios') {
        void Haptics.notificationAsync(
          payload.type === 'error'
            ? Haptics.NotificationFeedbackType.Error
            : Haptics.NotificationFeedbackType.Success,
        );
      }
      hideTimer.current = setTimeout(hide, AUTO_DISMISS_MS);
    },
    [translateY, opacity, hide],
  );

  useEffect(() => {
    listener = show;
    return () => {
      listener = null;
      if (hideTimer.current) clearTimeout(hideTimer.current);
    };
  }, [show]);

  if (!current) return null;

  const iconName =
    current.type === 'success' ? 'checkmark-circle' : current.type === 'error' ? 'alert-circle' : 'information-circle';
  const iconColor = current.type === 'error' ? colors.error : colors.primary;

  return (
    <Animated.View
      pointerEvents="box-none"
      style={[styles.wrap, { top: insets.top + 8, transform: [{ translateY }], opacity }]}
    >
      <Pressable
        onPress={hide}
        accessibilityRole="alert"
        accessibilityLabel={`${current.title}${current.message ? `. ${current.message}` : ''}`}
        style={[
          styles.card,
          {
            backgroundColor: isDark ? '#1F1F1F' : '#FFFFFF',
            borderColor: colors.border,
            shadowColor: '#000',
          },
        ]}
      >
        <Ionicons name={iconName} size={20} color={iconColor} />
        <View style={styles.textWrap}>
          <Text style={[styles.title, { color: colors.text }]} numberOfLines={2}>
            {current.title}
          </Text>
          {current.message ? (
            <Text style={[styles.message, { color: colors.textSecondary }]} numberOfLines={3}>
              {current.message}
            </Text>
          ) : null}
        </View>
      </Pressable>
    </Animated.View>
  );
}

const styles = StyleSheet.create({
  wrap: {
    position: 'absolute',
    left: 16,
    right: 16,
    zIndex: 9999,
    alignItems: 'center',
  },
  card: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 12,
    maxWidth: 560,
    width: '100%',
    paddingHorizontal: 16,
    paddingVertical: 12,
    borderRadius: borderRadius.xl,
    borderWidth: 1,
    shadowOffset: { width: 0, height: 8 },
    shadowOpacity: 0.18,
    shadowRadius: 16,
    elevation: 8,
  },
  textWrap: {
    flex: 1,
  },
  title: {
    fontSize: typography.fontSize.sm,
    fontFamily: typography.fontFamily.semiBold,
  },
  message: {
    marginTop: 2,
    fontSize: typography.fontSize.xs,
    fontFamily: typography.fontFamily.regular,
    lineHeight: 16,
  },
});
