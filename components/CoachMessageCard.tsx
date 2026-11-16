/**
 * CoachMessageCard — the coach "speaking" during a workout.
 *
 * Shows the latest coach reaction (built deterministically from the set the
 * user just logged — see src/services/coachReactions.ts) in the guidance
 * slot on the scroll player. The X dismisses the current message; the next
 * reaction re-opens the card (the parent remounts it via a per-message key).
 *
 * Suggestion-type messages carry a small ⓘ next to the LiftAI label — tap
 * to reveal the AI disclaimer (suggestions can be wrong; the user decides
 * what to lift). See constants/coachDisclaimer.ts.
 *
 * Same visual language as CoachQuestionCard / CoachTargetStrip: light card,
 * hairline border, blue accents only.
 */

import { Ionicons } from '@expo/vector-icons';
import React, { useState } from 'react';
import { StyleSheet, Text, View } from 'react-native';
import { TouchableOpacity } from 'react-native-gesture-handler';
import Animated, { FadeIn, FadeOut } from 'react-native-reanimated';
import { AI_COACH_DISCLAIMER } from '../constants/coachDisclaimer';

interface Props {
  text: string;
  /** Shows the ⓘ disclaimer affordance (set for forward-looking suggestions). */
  showDisclaimer?: boolean;
  onDismiss: () => void;
}

export default function CoachMessageCard({ text, showDisclaimer, onDismiss }: Props) {
  const [disclaimerOpen, setDisclaimerOpen] = useState(false);

  return (
    <Animated.View entering={FadeIn.duration(220)} exiting={FadeOut.duration(180)} style={styles.card}>
      <View style={styles.headerRow}>
        <View style={styles.coachLabelWrap}>
          <Ionicons name="chatbubble-ellipses" size={11} color="#2E90FA" />
          <Text style={styles.coachLabel}>LiftAI</Text>
          {showDisclaimer ? (
            <TouchableOpacity
              onPress={() => setDisclaimerOpen((v) => !v)}
              hitSlop={{ top: 10, bottom: 10, left: 6, right: 6 }}
              accessibilityRole="button"
              accessibilityLabel="About AI suggestions"
            >
              <Ionicons
                name="information-circle-outline"
                size={14}
                color={disclaimerOpen ? '#2E90FA' : '#94A3B4'}
              />
            </TouchableOpacity>
          ) : null}
        </View>
        <TouchableOpacity
          onPress={onDismiss}
          hitSlop={{ top: 14, bottom: 14, left: 14, right: 14 }}
          accessibilityRole="button"
          accessibilityLabel="Dismiss coach message"
        >
          <Ionicons name="close" size={18} color="#94A3B4" />
        </TouchableOpacity>
      </View>
      <Text style={styles.message}>{text}</Text>
      {disclaimerOpen ? (
        <Text style={styles.disclaimer}>{AI_COACH_DISCLAIMER}</Text>
      ) : null}
    </Animated.View>
  );
}

const styles = StyleSheet.create({
  card: {
    backgroundColor: '#FFFFFF',
    borderRadius: 16,
    borderWidth: 1,
    borderColor: '#E8EDF3',
    paddingHorizontal: 14,
    paddingVertical: 11,
    marginTop: 10,
    gap: 6,
    shadowColor: '#0F172A',
    shadowOpacity: 0.05,
    shadowRadius: 8,
    shadowOffset: { width: 0, height: 2 },
    elevation: 2,
  },
  headerRow: { flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between' },
  coachLabelWrap: { flexDirection: 'row', alignItems: 'center', gap: 5 },
  coachLabel: { fontSize: 10, fontWeight: '800', letterSpacing: 1.2, color: '#2E90FA' },
  message: { fontSize: 13, fontWeight: '600', lineHeight: 19, color: '#0F172A' },
  disclaimer: {
    fontSize: 11,
    lineHeight: 15,
    fontWeight: '500',
    color: '#8A97A8',
    borderTopWidth: 1,
    borderTopColor: '#EEF2F7',
    paddingTop: 6,
  },
});
