/**
 * ConfirmSheet — global, promise-based confirmation sheet.
 *
 * Usage (from anywhere, no hooks needed):
 *   import { confirmSheet } from '../components/ui/ConfirmSheet';
 *   const ok = await confirmSheet({
 *     title: 'Sign Out',
 *     message: 'Are you sure you want to sign out?',
 *     confirmLabel: 'Sign Out',
 *     destructive: true,
 *   });
 *   if (ok) { ... }
 *
 * `ConfirmSheetHost` must be mounted once, inside ThemeProvider (see app/_layout.tsx).
 * Replaces native Alert.alert for decisions; one-way feedback goes through Toast.
 */

import React, { useCallback, useEffect, useRef, useState } from 'react';
import { Animated, Easing, Modal, Pressable, StyleSheet, Text, TouchableOpacity, View } from 'react-native';
import { useSafeAreaInsets } from 'react-native-safe-area-context';

import { borderRadius, getThemeColors, typography } from '../../constants/theme';
import { useTheme } from '../../context/ThemeContext';

export interface ConfirmOptions {
  title: string;
  message?: string;
  confirmLabel?: string;
  cancelLabel?: string;
  /** Renders the confirm button in the error red reserved for destructive actions. */
  destructive?: boolean;
}

interface PendingConfirm extends ConfirmOptions {
  resolve: (confirmed: boolean) => void;
}

type Opener = (pending: PendingConfirm) => void;

let opener: Opener | null = null;

export function confirmSheet(options: ConfirmOptions): Promise<boolean> {
  return new Promise((resolve) => {
    if (opener) {
      opener({ ...options, resolve });
    } else {
      // Host not mounted (should not happen in app flow) — fail open as "cancel".
      resolve(false);
    }
  });
}

export function ConfirmSheetHost() {
  const { isDark } = useTheme();
  const colors = getThemeColors(isDark);
  const insets = useSafeAreaInsets();

  const [pending, setPending] = useState<PendingConfirm | null>(null);
  const translateY = useRef(new Animated.Value(400)).current;
  const backdrop = useRef(new Animated.Value(0)).current;

  const open = useCallback(
    (next: PendingConfirm) => {
      setPending((prev) => {
        // If a confirm is already showing, resolve it as cancelled.
        prev?.resolve(false);
        return next;
      });
      translateY.setValue(400);
      backdrop.setValue(0);
      Animated.parallel([
        Animated.spring(translateY, { toValue: 0, useNativeDriver: true, damping: 22, stiffness: 260, mass: 0.9 }),
        Animated.timing(backdrop, { toValue: 1, duration: 200, useNativeDriver: true }),
      ]).start();
    },
    [translateY, backdrop],
  );

  useEffect(() => {
    opener = open;
    return () => {
      opener = null;
    };
  }, [open]);

  const close = useCallback(
    (confirmed: boolean) => {
      const current = pending;
      Animated.parallel([
        Animated.timing(translateY, { toValue: 400, duration: 200, easing: Easing.in(Easing.ease), useNativeDriver: true }),
        Animated.timing(backdrop, { toValue: 0, duration: 200, useNativeDriver: true }),
      ]).start(() => {
        current?.resolve(confirmed);
        setPending(null);
      });
    },
    [pending, translateY, backdrop],
  );

  if (!pending) return null;

  return (
    <Modal transparent visible statusBarTranslucent animationType="none" onRequestClose={() => close(false)}>
      <View style={styles.root}>
        <Animated.View style={[StyleSheet.absoluteFill, styles.backdrop, { opacity: backdrop }]}>
          <Pressable style={StyleSheet.absoluteFill} onPress={() => close(false)} accessibilityLabel="Dismiss" />
        </Animated.View>

        <Animated.View
          style={[
            styles.sheet,
            {
              backgroundColor: isDark ? '#1A1A1A' : '#FFFFFF',
              borderColor: colors.border,
              paddingBottom: Math.max(insets.bottom, 16) + 8,
              transform: [{ translateY }],
            },
          ]}
        >
          <View style={[styles.handle, { backgroundColor: colors.border }]} />
          <Text style={[styles.title, { color: colors.text }]}>{pending.title}</Text>
          {pending.message ? (
            <Text style={[styles.message, { color: colors.textSecondary }]}>{pending.message}</Text>
          ) : null}

          <TouchableOpacity
            style={[
              styles.confirmButton,
              { backgroundColor: pending.destructive ? colors.error : colors.text },
            ]}
            activeOpacity={0.85}
            onPress={() => close(true)}
            accessibilityRole="button"
            accessibilityLabel={pending.confirmLabel ?? 'Confirm'}
          >
            <Text
              style={[
                styles.confirmText,
                { color: pending.destructive ? '#FFFFFF' : colors.textInverse },
              ]}
            >
              {pending.confirmLabel ?? 'Confirm'}
            </Text>
          </TouchableOpacity>

          <TouchableOpacity
            style={[styles.cancelButton, { borderColor: colors.border }]}
            activeOpacity={0.85}
            onPress={() => close(false)}
            accessibilityRole="button"
            accessibilityLabel={pending.cancelLabel ?? 'Cancel'}
          >
            <Text style={[styles.cancelText, { color: colors.text }]}>{pending.cancelLabel ?? 'Cancel'}</Text>
          </TouchableOpacity>
        </Animated.View>
      </View>
    </Modal>
  );
}

const styles = StyleSheet.create({
  root: {
    flex: 1,
    justifyContent: 'flex-end',
  },
  backdrop: {
    backgroundColor: 'rgba(0,0,0,0.5)',
  },
  sheet: {
    borderTopLeftRadius: borderRadius['3xl'],
    borderTopRightRadius: borderRadius['3xl'],
    borderWidth: 1,
    paddingHorizontal: 20,
    paddingTop: 12,
  },
  handle: {
    alignSelf: 'center',
    width: 36,
    height: 4,
    borderRadius: borderRadius.full,
    marginBottom: 16,
  },
  title: {
    fontSize: typography.fontSize.lg,
    fontFamily: typography.fontFamily.bold,
    textAlign: 'center',
  },
  message: {
    marginTop: 8,
    fontSize: typography.fontSize.sm,
    fontFamily: typography.fontFamily.regular,
    lineHeight: 20,
    textAlign: 'center',
  },
  confirmButton: {
    marginTop: 20,
    minHeight: 50,
    borderRadius: borderRadius.full,
    alignItems: 'center',
    justifyContent: 'center',
  },
  confirmText: {
    fontSize: typography.fontSize.base,
    fontFamily: typography.fontFamily.bold,
  },
  cancelButton: {
    marginTop: 12,
    minHeight: 50,
    borderRadius: borderRadius.full,
    borderWidth: 1,
    alignItems: 'center',
    justifyContent: 'center',
  },
  cancelText: {
    fontSize: typography.fontSize.base,
    fontFamily: typography.fontFamily.semiBold,
  },
});
