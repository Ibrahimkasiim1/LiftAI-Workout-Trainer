/**
 * CoachQuestionCard — lightweight in-workout coach question.
 *
 * Shows one question with tap-pill answers on the scroll page:
 *   • at workout start:  "How are you feeling today?"  (fresh/good/tired/sore)
 *   • mid-workout:       "How's this workout?"          (too easy/right/too hard)
 *
 * Answering takes ONE tap, gives haptic feedback, and the card collapses into
 * a brief acknowledgement before disappearing. The answer is:
 *   1. applied to this session (the player biases overload recommendations
 *      down when tired/sore), and
 *   2. persisted to the user's progressive coach memory via the backend, so
 *      the chat agent knows too.
 *
 * Same visual language as CoachTargetStrip: light card, blue accents, pills.
 */

import { Ionicons } from '@expo/vector-icons';
import * as Haptics from 'expo-haptics';
import React, { useEffect, useState } from 'react';
import { StyleSheet, Text, View } from 'react-native';
import { TouchableOpacity } from 'react-native-gesture-handler';
import Animated, { FadeIn, FadeOut } from 'react-native-reanimated';

export interface CoachQuestionOption {
  value: string;
  label: string;
}

interface Props {
  question: string;
  options: CoachQuestionOption[];
  /** Short line shown for a beat after answering, e.g. "Got it — we'll keep it steady." */
  acknowledgement?: (value: string) => string;
  onAnswer: (value: string) => void;
  onSkip: () => void;
}

export default function CoachQuestionCard({
  question,
  options,
  acknowledgement,
  onAnswer,
  onSkip,
}: Props) {
  const [answered, setAnswered] = useState<string | null>(null);

  // After answering, show the acknowledgement briefly, then let the parent
  // unmount us (it flips its own state in onAnswer; the timer here only
  // controls the thank-you beat).
  useEffect(() => {
    if (!answered) return;
    const t = setTimeout(() => onAnswer(answered), 1400);
    return () => clearTimeout(t);
  }, [answered, onAnswer]);

  const handlePick = (value: string) => {
    Haptics.notificationAsync(Haptics.NotificationFeedbackType.Success);
    setAnswered(value);
  };

  return (
    <Animated.View entering={FadeIn.duration(220)} exiting={FadeOut.duration(180)} style={styles.card}>
      {answered ? (
        <View style={styles.ackRow}>
          <Ionicons name="checkmark-circle" size={16} color="#2E90FA" />
          <Text style={styles.ackText}>
            {acknowledgement ? acknowledgement(answered) : 'Got it — noted for today.'}
          </Text>
        </View>
      ) : (
        <>
          <View style={styles.headerRow}>
            <View style={styles.coachLabelWrap}>
              <Ionicons name="chatbubble-ellipses" size={11} color="#2E90FA" />
              <Text style={styles.coachLabel}>LiftAI</Text>
            </View>
            <TouchableOpacity
              onPress={onSkip}
              hitSlop={{ top: 14, bottom: 14, left: 14, right: 14 }}
              accessibilityLabel="Skip question"
            >
              <Ionicons name="close" size={18} color="#94A3B4" />
            </TouchableOpacity>
          </View>

          <Text style={styles.question}>{question}</Text>

          <View style={styles.optionsRow}>
            {options.map((opt) => (
              <TouchableOpacity
                key={opt.value}
                style={styles.optionPill}
                onPress={() => handlePick(opt.value)}
                activeOpacity={0.8}
              >
                <Text style={styles.optionText}>{opt.label}</Text>
              </TouchableOpacity>
            ))}
          </View>
        </>
      )}
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
    gap: 8,
    shadowColor: '#0F172A',
    shadowOpacity: 0.05,
    shadowRadius: 8,
    shadowOffset: { width: 0, height: 2 },
    elevation: 2,
  },
  headerRow: { flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between' },
  coachLabelWrap: { flexDirection: 'row', alignItems: 'center', gap: 4 },
  coachLabel: { fontSize: 10, fontWeight: '800', letterSpacing: 1.2, color: '#2E90FA' },

  question: { fontSize: 14, fontWeight: '700', color: '#0F172A' },

  // Neutral chips matching the exercise-page tag pills (mono surfaces,
  // blue reserved for the coach label only — see design system).
  optionsRow: { flexDirection: 'row', flexWrap: 'wrap', gap: 8 },
  optionPill: {
    paddingHorizontal: 14,
    paddingVertical: 8,
    borderRadius: 999,
    backgroundColor: '#F1F5F9',
    borderWidth: 1,
    borderColor: '#E2E8F0',
  },
  optionText: { fontSize: 13, fontWeight: '600', color: '#0F172A' },

  ackRow: { flexDirection: 'row', alignItems: 'center', gap: 7, paddingVertical: 4 },
  ackText: { flex: 1, fontSize: 13, fontWeight: '600', color: '#475569' },
});
