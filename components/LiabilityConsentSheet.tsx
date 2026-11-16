/**
 * LiabilityConsentSheet — one-time agreement shown before the user's FIRST
 * ever workout (any workout type; the gate lives in ExerciseTikTokScroll).
 *
 * Product intent: set expectations that the coaching is AI-generated and
 * fallible, and that the user owns their training decisions — the same
 * message the ⓘ disclaimer on coach suggestions reinforces in-context.
 *
 * Legal intent: an explicit, affirmative, versioned acceptance (timestamp
 * stored locally + best-effort server copy + analytics event) that the user
 * trains at their own risk and accepts the Terms. Bump CONSENT_VERSION if
 * this copy materially changes — users will be asked to agree again.
 *
 * This is a plain statement of risk acceptance, not a substitute for the
 * full Terms (linked below the bullets).
 */

import { Ionicons } from '@expo/vector-icons';
import React from 'react';
import { Linking, Modal, ScrollView, StyleSheet, Text, TouchableOpacity, View } from 'react-native';
import { useSafeAreaInsets } from 'react-native-safe-area-context';

export const CONSENT_VERSION = 1;
export const CONSENT_STORAGE_KEY = '@liability_consent_v1';

const TERMS_URL = 'https://liftaiapp.com/terms.html';

const POINTS: { icon: keyof typeof Ionicons.glyphMap; text: string }[] = [
  {
    icon: 'sparkles-outline',
    text: "LiftAI's workouts, weights, and coaching tips are AI-generated suggestions — they can be wrong.",
  },
  {
    icon: 'barbell-outline',
    text: 'You decide what to lift. Only train with weights and movements that feel safe for your body and experience.',
  },
  {
    icon: 'medkit-outline',
    text: 'This is not medical advice. Check with a doctor before starting a training program, especially if you have injuries or health conditions.',
  },
  {
    icon: 'hand-left-outline',
    text: 'Stop immediately if something hurts.',
  },
];

interface Props {
  visible: boolean;
  onAccept: () => void;
  onDecline: () => void;
}

export default function LiabilityConsentSheet({ visible, onAccept, onDecline }: Props) {
  const insets = useSafeAreaInsets();

  return (
    <Modal visible={visible} animationType="slide" onRequestClose={onDecline}>
      <View style={[styles.container, { paddingTop: insets.top + 24, paddingBottom: Math.max(insets.bottom, 16) }]}>
        <ScrollView
          style={styles.scroll}
          contentContainerStyle={styles.scrollContent}
          showsVerticalScrollIndicator={false}
        >
          <View style={styles.badge}>
            <Ionicons name="shield-checkmark-outline" size={26} color="#2E90FA" />
          </View>
          <Text style={styles.title}>Before your first workout</Text>
          <Text style={styles.subtitle}>
            A quick agreement about training with an AI coach.
          </Text>

          <View style={styles.pointsBlock}>
            {POINTS.map((p) => (
              <View key={p.icon} style={styles.pointRow}>
                <View style={styles.pointIconWrap}>
                  <Ionicons name={p.icon} size={16} color="#2E90FA" />
                </View>
                <Text style={styles.pointText}>{p.text}</Text>
              </View>
            ))}
          </View>

          <Text style={styles.legalText}>
            By continuing, you confirm that you train at your own risk, that you are responsible
            for your own training decisions, and that LiftAI is not liable for injuries or losses
            arising from your training. Your use of LiftAI is governed by the{' '}
            <Text style={styles.legalLink} onPress={() => Linking.openURL(TERMS_URL)}>
              Terms of Service
            </Text>
            .
          </Text>
        </ScrollView>

        <View style={styles.footer}>
          <TouchableOpacity
            style={styles.acceptBtn}
            onPress={onAccept}
            activeOpacity={0.85}
            accessibilityRole="button"
            accessibilityLabel="I understand and agree"
          >
            <Text style={styles.acceptBtnText}>I understand and agree</Text>
          </TouchableOpacity>
          <TouchableOpacity
            style={styles.declineBtn}
            onPress={onDecline}
            accessibilityRole="button"
            accessibilityLabel="Not now — go back"
          >
            <Text style={styles.declineBtnText}>Not now</Text>
          </TouchableOpacity>
        </View>
      </View>
    </Modal>
  );
}

const styles = StyleSheet.create({
  container: {
    flex: 1,
    backgroundColor: '#FFFFFF',
    paddingHorizontal: 24,
  },
  scroll: { flex: 1 },
  scrollContent: { paddingBottom: 16 },
  badge: {
    width: 56,
    height: 56,
    borderRadius: 28,
    backgroundColor: '#EAF3FF',
    alignItems: 'center',
    justifyContent: 'center',
    marginBottom: 16,
  },
  title: {
    fontSize: 26,
    fontWeight: '800',
    color: '#0F172A',
    marginBottom: 6,
  },
  subtitle: {
    fontSize: 15,
    fontWeight: '500',
    color: '#64748B',
    marginBottom: 24,
  },
  pointsBlock: { gap: 16, marginBottom: 24 },
  pointRow: { flexDirection: 'row', alignItems: 'flex-start', gap: 12 },
  pointIconWrap: {
    width: 32,
    height: 32,
    borderRadius: 16,
    backgroundColor: '#F1F6FC',
    alignItems: 'center',
    justifyContent: 'center',
    marginTop: 1,
  },
  pointText: {
    flex: 1,
    fontSize: 14.5,
    lineHeight: 21,
    fontWeight: '500',
    color: '#0F172A',
  },
  legalText: {
    fontSize: 12,
    lineHeight: 18,
    fontWeight: '500',
    color: '#8A97A8',
  },
  legalLink: {
    color: '#1A6FE0',
    textDecorationLine: 'underline',
  },
  footer: { gap: 10, paddingTop: 12 },
  acceptBtn: {
    backgroundColor: '#0F172A',
    borderRadius: 16,
    minHeight: 54,
    alignItems: 'center',
    justifyContent: 'center',
  },
  acceptBtnText: {
    color: '#FFFFFF',
    fontSize: 16,
    fontWeight: '800',
  },
  declineBtn: {
    alignItems: 'center',
    justifyContent: 'center',
    minHeight: 40,
  },
  declineBtnText: {
    color: '#64748B',
    fontSize: 14,
    fontWeight: '600',
  },
});
