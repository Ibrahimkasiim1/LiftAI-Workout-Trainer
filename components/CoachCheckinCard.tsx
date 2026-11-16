/**
 * CoachCheckinCard — proactive coach message on the home screen.
 *
 * Renders the newest unread coach check-in (drafted by the backend cron from
 * the user's real training data, or a plan-change explanation written by the
 * chat tools). One tap on the CTA deep-links into chat with a prefilled
 * message the agent can act on ("Yes — bump my Bench Press by 2.5 kg").
 *
 * Renders nothing while loading or when there's nothing unread — it never
 * takes space speculatively.
 */

import { Ionicons } from '@expo/vector-icons';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import * as Haptics from 'expo-haptics';
import { useRouter } from 'expo-router';
import React from 'react';
import { StyleSheet, Text, TouchableOpacity, View } from 'react-native';
import { backendClient, type CoachCheckin } from '../src/api/backendClient';
import { useTheme } from '../context/ThemeContext';

const KIND_ICON: Record<CoachCheckin['kind'], keyof typeof Ionicons.glyphMap> = {
  ready_to_progress: 'trending-up',
  streak: 'flame',
  comeback: 'refresh',
  stalled_lift: 'analytics',
  plan_change: 'swap-horizontal',
  first_workout_followup: 'ribbon',
  day2_after_first: 'fitness',
  activation_nudge: 'play-circle',
};

export default function CoachCheckinCard() {
  const router = useRouter();
  const queryClient = useQueryClient();
  const { isDark } = useTheme();

  const { data } = useQuery({
    queryKey: ['coach-checkins'],
    queryFn: () => backendClient.getCoachCheckins(),
    staleTime: 5 * 60 * 1000,
  });

  const checkin = data?.checkins?.find((c) => c.status === 'unread');
  if (!checkin) return null;

  const dismiss = () => {
    Haptics.impactAsync(Haptics.ImpactFeedbackStyle.Light);
    void backendClient.setCheckinStatus(checkin.id, 'dismissed');
    queryClient.setQueryData(
      ['coach-checkins'],
      (prev: { checkins: CoachCheckin[]; unreadCount: number } | undefined) =>
        prev
          ? {
              checkins: prev.checkins.filter((c) => c.id !== checkin.id),
              unreadCount: Math.max(0, prev.unreadCount - 1),
            }
          : prev,
    );
  };

  const openChat = () => {
    Haptics.impactAsync(Haptics.ImpactFeedbackStyle.Medium);
    void backendClient.setCheckinStatus(checkin.id, 'read');
    queryClient.invalidateQueries({ queryKey: ['coach-checkins'] });
    if (checkin.cta) {
      router.push({ pathname: '/(tabs)/chat', params: { initialMessage: checkin.cta } });
    } else {
      router.push('/(tabs)/chat');
    }
  };

  const cardBg = isDark ? '#101823' : '#FFFFFF';
  const border = isDark ? '#1E2A3A' : '#E4EDF7';
  const titleColor = isDark ? '#F1F5F9' : '#0F172A';
  const bodyColor = isDark ? '#B6C2D0' : '#475569';

  return (
    <View style={[styles.card, { backgroundColor: cardBg, borderColor: border }]}>
      <View style={styles.headerRow}>
        <View style={styles.iconBubble}>
          <Ionicons name={KIND_ICON[checkin.kind]} size={15} color="#2E90FA" />
        </View>
        <Text style={styles.coachLabel}>LiftAI</Text>
        <TouchableOpacity
          onPress={dismiss}
          hitSlop={{ top: 10, bottom: 10, left: 10, right: 10 }}
          accessibilityLabel="Dismiss coach message"
        >
          <Ionicons name="close" size={16} color={isDark ? '#64748B' : '#94A3B4'} />
        </TouchableOpacity>
      </View>

      <Text style={[styles.title, { color: titleColor }]}>{checkin.title}</Text>
      <Text style={[styles.message, { color: bodyColor }]}>{checkin.message}</Text>

      {checkin.cta ? (
        <TouchableOpacity style={styles.ctaButton} onPress={openChat} activeOpacity={0.85}>
          <Text style={styles.ctaText}>{checkin.cta}</Text>
          <Ionicons name="arrow-forward" size={14} color="#FFFFFF" />
        </TouchableOpacity>
      ) : (
        <TouchableOpacity style={styles.linkRow} onPress={openChat}>
          <Text style={styles.linkText}>Ask about this</Text>
          <Ionicons name="chevron-forward" size={13} color="#2E90FA" />
        </TouchableOpacity>
      )}
    </View>
  );
}

const styles = StyleSheet.create({
  card: {
    borderRadius: 16,
    borderWidth: 1,
    paddingHorizontal: 16,
    paddingVertical: 14,
    marginHorizontal: 16,
    marginBottom: 14,
    gap: 6,
  },
  headerRow: { flexDirection: 'row', alignItems: 'center', gap: 8 },
  iconBubble: {
    width: 26,
    height: 26,
    borderRadius: 13,
    backgroundColor: '#EAF3FF',
    alignItems: 'center',
    justifyContent: 'center',
  },
  coachLabel: {
    flex: 1,
    fontSize: 10,
    fontWeight: '800',
    letterSpacing: 1.2,
    color: '#2E90FA',
  },
  title: { fontSize: 15, fontWeight: '700' },
  message: { fontSize: 13, lineHeight: 19, fontWeight: '500' },
  ctaButton: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'center',
    gap: 6,
    backgroundColor: '#2E90FA',
    borderRadius: 12,
    paddingVertical: 11,
    marginTop: 6,
  },
  ctaText: { color: '#FFFFFF', fontSize: 13, fontWeight: '700' },
  linkRow: { flexDirection: 'row', alignItems: 'center', gap: 3, marginTop: 4 },
  linkText: { color: '#2E90FA', fontSize: 13, fontWeight: '700' },
});
