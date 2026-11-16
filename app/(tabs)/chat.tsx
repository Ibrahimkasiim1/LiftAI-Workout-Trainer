// app/(tabs)/chat.tsx
/**
 * Chat Tab - LiftAI Assistant with Streaming
 * 
 * Route: /(tabs)/chat
 * Function: AI-powered fitness assistant with real-time streaming responses
 * 
 * Features:
 * - Real-time streaming chat (backend: Google Gemini)
 * - Generate custom workouts and exercise plans
 * - Save workouts to personal collection
 * - Update main workout plan with AI suggestions
 * - Exercise database integration and recommendations
 * - Context-aware fitness advice and motivation
 */

import { Ionicons } from '@expo/vector-icons';
import NetInfo from '@react-native-community/netinfo';
import * as Clipboard from 'expo-clipboard';
import { GlassView, isLiquidGlassAvailable } from 'expo-glass-effect';
import { Image } from 'expo-image';
import { LinearGradient } from 'expo-linear-gradient';
import * as Haptics from 'expo-haptics';
import { useFocusEffect, useLocalSearchParams, useRouter } from 'expo-router';
import React, { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import {
  Animated,
  FlatList,
  Keyboard,
  KeyboardAvoidingView,
  Modal,
  type NativeScrollEvent,
  type NativeSyntheticEvent,
  Platform,
  Pressable,
  ScrollView,
  StyleSheet,
  Text,
  TextInput,
  TouchableOpacity,
  View
} from 'react-native';
import { Swipeable } from 'react-native-gesture-handler';
import Reanimated, { FadeInDown } from 'react-native-reanimated';
import { useSafeAreaInsets } from 'react-native-safe-area-context';

// Import our services and types
import AdBanner from '../../components/AdBanner';
import GlassIconButton from '../../components/ui/GlassIconButton';
import { AiThinkingState } from '../../components/chat/AiThinkingState';
import { ChatFeatureDiscoveryChips } from '../../components/chat/ChatFeatureDiscoveryChips';
import { messageForGraphNode } from '../../components/chat/graphThinkingLabels';
import ChatHistorySidebar from '../../components/ChatHistorySidebar';
import QuotaLimitSheet from '../../components/QuotaLimitSheet';
import { TAB_BAR_CLEARANCE } from '../../constants/layout';
import { getThemeColors, theme } from '../../constants/theme';
import { useTheme } from '../../context/ThemeContext';
import { confirmSheet } from '../../components/ui/ConfirmSheet';
import { toast } from '../../components/ui/Toast';
import { backendClient, isQuotaExceededError, QuotaExceededError, StreamEvent } from '../../src/api/backendClient';
import { WorkoutService, type TodaysWorkoutStatus } from '../../src/services/WorkoutService';
import { generateConversationId, ChatMessage as HistoryMessage, loadConversation, saveMessage } from '../../utils/chatHistory';
import { getLocalDateString } from '../../utils/date';
import { getExerciseGifUrl } from '../../utils/exerciseGifs';
import { getExercises, normalizeExercises } from '../../utils/exerciseNormalizer';
import {
  ERR_SAVED_WORKOUTS_LIMIT,
  normalizeWorkoutTypeForSavedWorkouts,
  SavedWorkout,
  saveWorkout,
} from '../../utils/storage';
import { useProGate } from '../../hooks/useProGate';
import { useUserQuota } from '../../hooks/useUserQuota';
import FirstVisitHint from '../../components/FirstVisitHint';
import type { Json } from '../../types/supabase';
import { resolveFirstName } from '../../utils/nameUtils';
import { getSession, supabase } from '../../utils/supabase';
import { getUserProfile, UserProfile } from '../../utils/userProfile';
// ChatFSM for state management
import {
  createChatFSM,
  getInputPlaceholder,
  isInputDisabled,
  reduceChatFSM
} from '../../utils/chat-fsm';
import { posthog } from '../../src/config/posthog';

/**
 * REFACTORED: Now using backendClient for all AI interactions
 * Backend sends structured workout events via SSE stream
 * 
 * 
 * Old approach:
 * - Frontend parsed text for JSON workout data
 * - Regex-based extraction from AI responses
 * - Client-side validation
 * 
 * New approach:
 * - Backend sends 'workout' SSE event with validated WorkoutPayload
 * - No parsing needed on frontend
 * - Backend guarantees all exercises have id and gif_path
 * 
 * See: /src/api/backendClient.ts for new streaming implementation
 */

// Import canonical WorkoutPayload and ExerciseCard from shared types
import { ExerciseCard } from '../../types/workoutPayload';

// Real Apple Liquid Glass (UIGlassEffect) is only available on iOS 26+ builds;
// elsewhere the input keeps its solid translucent surface.
const HAS_NATIVE_GLASS = isLiquidGlassAvailable();
const InputShell: React.ComponentType<any> = HAS_NATIVE_GLASS ? GlassView : View;

/**
 * WorkoutPlan - Canonical workout shape for chat UI
 * Uses WorkoutPayload contract with ExerciseCard[] for exercises
 * 
 * NOTE: Backend sends structured ExerciseCard[] objects, NOT strings
 */
export interface WorkoutPlan {
  workout_name: string;
  /** Exercise names for display - extracted from exercises_structured */
  exercises: string[];
  /** Full structured exercise objects with id, name, gif_path, etc. - THE PRIMARY DATA SOURCE */
  exercises_structured: ExerciseCard[];
  /** Alias for exercises_structured (for backward compatibility) */
  structured_exercises?: ExerciseCard[];
  estimated_time: number;
  difficulty: string;
  description?: string;
  workout_type?: 'main_plan' | 'replacement_workout' | 'quick_workout' | 'extra_workout';
  note?: string;
}

/** Keep "Building workout…" visible at least this long before opening the modal (avoids instant pop-in). */
const MIN_WORKOUT_BUILD_DISPLAY_MS = 900;

// Honest failure copy: these fire on OUR infra failures (cold backend, flaky
// stream), never because of how the user phrased something. Say so, and tell
// them the fix is simply resending — not rephrasing.
const COACH_ERROR_COPY =
  "That one's on me — my connection hiccuped for a second. Your message was fine; send it again and I'll get right on it.";
const COACH_WAKING_COPY =
  "Sorry — I'm having trouble reaching the coach server (it can take a few seconds to wake up). Give it a moment and send that again.";

// Message interface for our custom chat
interface ChatMessage {
  id: string;
  text: string;
  isUser: boolean;
  timestamp: Date;
  displayedText?: string; // For typing animation
  isTyping?: boolean; // Track if message is currently being typed
  isLoading?: boolean; // Show loading animation
  /** Shown while backend LangGraph execute_tools is running (from SSE tool_start) */
  coachActivityLabel?: string;
  workoutData?: WorkoutPlan; // Optional workout data for workout cards
  messageType?: 'text' | 'workout'; // Message type for two-message flow
  noBubble?: boolean; // Render text without background bubble
}

type MainPlanEditPreview = {
  dayOfWeek: string;
  splitName: string;
  changes: { added: string[]; removed: string[] };
  newExercises: string[];
  updatedDays: any[];
  changesByDay: {
    dayOfWeek: string;
    splitName: string;
    added: string[];
    removed: string[];
  }[];
};

function buildMainPlanEditPreview(previewChanges: { before: unknown[]; after: unknown[] }): MainPlanEditPreview | null {
  const beforeDays = Array.isArray(previewChanges.before) ? (previewChanges.before as any[]) : [];
  const afterDays = Array.isArray(previewChanges.after) ? (previewChanges.after as any[]) : [];

  const getDayKey = (day: any): string | null => {
    if (!day) return null;
    if (typeof day.id === 'string' && day.id.length > 0) return day.id;
    const raw = day.day_of_week ?? day.dayOfWeek ?? day.day;
    return typeof raw === 'string' && raw.length > 0 ? raw.toLowerCase() : null;
  };

  const getSplitName = (day: any): string => {
    const raw = day?.split_day_name ?? day?.splitDayName ?? day?.focus ?? day?.splitName;
    return typeof raw === 'string' && raw.length > 0 ? raw : 'Workout';
  };

  const getExerciseNames = (day: any): string[] => {
    // Use normalizer to handle all naming conventions
    const exercises = normalizeExercises(day);
    return exercises.map(ex => ex.name);
  };

  const beforeByKey = new Map<string, any>();
  for (const day of beforeDays) {
    const key = getDayKey(day);
    if (key) beforeByKey.set(key, day);
  }

  const changesByDay: MainPlanEditPreview['changesByDay'] = [];
  const updatedDays: any[] = [];

  for (const afterDay of afterDays) {
    const key = getDayKey(afterDay);
    if (!key) continue;

    const beforeDay = beforeByKey.get(key);
    const beforeNames = beforeDay ? getExerciseNames(beforeDay) : [];
    const afterNames = getExerciseNames(afterDay);

    const beforeSet = new Set(beforeNames.map(n => n.toLowerCase()));
    const afterSet = new Set(afterNames.map(n => n.toLowerCase()));

    const added = afterNames.filter(n => !beforeSet.has(n.toLowerCase()));
    const removed = beforeNames.filter(n => !afterSet.has(n.toLowerCase()));

    if (added.length === 0 && removed.length === 0) continue;

    const dayOfWeekRaw = afterDay.day_of_week ?? afterDay.dayOfWeek ?? afterDay.day;
    const dayOfWeek = typeof dayOfWeekRaw === 'string' ? dayOfWeekRaw.toLowerCase() : 'unknown';

    changesByDay.push({
      dayOfWeek,
      splitName: getSplitName(afterDay),
      added,
      removed,
    });
    updatedDays.push(afterDay);
  }

  if (!changesByDay.length) return null;

  const primary = changesByDay[0];
  const primaryAfterDay = updatedDays[0];

  return {
    dayOfWeek: primary.dayOfWeek,
    splitName: primary.splitName,
    changes: { added: primary.added, removed: primary.removed },
    newExercises: getExerciseNames(primaryAfterDay),
    updatedDays,
    changesByDay,
  };
}

export type CoachTodayBrief = {
  status: TodaysWorkoutStatus;
  splitLabel?: string;
  isReplacement: boolean;
  dayOfWeek: string;
};

function truncateChipLabel(s: string, max: number): string {
  const t = s.trim();
  if (t.length <= max) return t;
  return `${t.slice(0, Math.max(0, max - 1))}…`;
}

/** Subtle haptics for coach events (no-op on web). */
function coachHaptic(kind: 'light' | 'medium' | 'warning') {
  if (Platform.OS === 'web') return;
  if (kind === 'warning') {
    void Haptics.notificationAsync(Haptics.NotificationFeedbackType.Warning).catch(() => { });
    return;
  }
  void Haptics.impactAsync(
    kind === 'medium' ? Haptics.ImpactFeedbackStyle.Medium : Haptics.ImpactFeedbackStyle.Light
  ).catch(() => { });
}

const WORKOUT_CARD_MARKER = '[[WORKOUT_CARD]]';

/**
 * Extract intent mode from AI response if present
 * Returns object with intentMode and cleanedText
 */
const extractIntentMode = (text: string) => {
  const intentModeMatch = text.match(/^\[Intent Mode:\s*([^\]]+)\]\s*/);
  if (intentModeMatch) {
    return {
      intentMode: intentModeMatch[1].trim(),
      cleanedText: text.replace(/^\[Intent Mode:\s*[^\]]+\]\s*/, '')
    };
  }
  return {
    intentMode: null,
    cleanedText: text
  };
};

/**
 * Coach markdown: ATX headers (#/##/###), bullets (-/*), `code`, **bold**, ###legacy###.
 * Module scope (no theme fallback): callers must pass the resolved colors.
 */
const parseFormattedText = (text: string, isUser: boolean, colors: any) => {
  if (isUser) {
    return text;
  }

  const normalized = text.replace(/\r\n/g, '\n');
  let inlineKey = 0;
  const ikey = () => inlineKey++;

  const parseInlinePatterns = (segment: string): React.ReactNode => {
    const elements: React.ReactNode[] = [];
    let remaining = segment;
    while (remaining.length > 0) {
      const codeIdx = remaining.indexOf('`');
      const headerStart = remaining.indexOf('###');
      const boldStart = remaining.indexOf('**');
      type Pat = 'code' | 'header' | 'bold';
      const cand: { t: Pat; i: number }[] = [];
      if (codeIdx !== -1) cand.push({ t: 'code', i: codeIdx });
      if (headerStart !== -1) cand.push({ t: 'header', i: headerStart });
      if (boldStart !== -1) cand.push({ t: 'bold', i: boldStart });
      if (!cand.length) {
        elements.push(remaining);
        break;
      }
      cand.sort((a, b) => a.i - b.i);
      const first = cand[0];
      if (first.i > 0) {
        elements.push(remaining.substring(0, first.i));
      }
      remaining = remaining.substring(first.i);

      if (first.t === 'code') {
        const end = remaining.indexOf('`', 1);
        if (end === -1) {
          elements.push(remaining);
          break;
        }
        elements.push(
          <Text key={ikey()} style={[styles.messageTextCode, { color: colors.text }]}>
            {remaining.slice(1, end)}
          </Text>
        );
        remaining = remaining.slice(end + 1);
      } else if (first.t === 'header') {
        const headerEnd = remaining.indexOf('###', 3);
        if (headerEnd !== -1) {
          const headerText = remaining.substring(3, headerEnd);
          elements.push(
            <Text key={ikey()} style={[styles.messageTextHeader, { color: colors.text }]}>
              {parseInlinePatterns(headerText)}
            </Text>
          );
          remaining = remaining.substring(headerEnd + 3);
        } else {
          elements.push(remaining);
          break;
        }
      } else {
        const boldEnd = remaining.indexOf('**', 2);
        if (boldEnd !== -1) {
          const boldText = remaining.substring(2, boldEnd);
          elements.push(
            <Text key={ikey()} style={[styles.messageTextBold, { color: colors.text }]}>
              {parseInlinePatterns(boldText)}
            </Text>
          );
          remaining = remaining.substring(boldEnd + 2);
        } else {
          elements.push(remaining);
          break;
        }
      }
    }
    if (elements.length === 0) return '';
    if (elements.length === 1) return elements[0];
    return elements;
  };

  const lines = normalized.split('\n');
  const blocks: React.ReactNode[] = [];
  let lineIdx = 0;
  let blockKey = 0;

  const TABLE_ROW_RE = /^\s*\|.*\|\s*$/;
  const TABLE_SEPARATOR_RE = /^\s*\|[\s:\-|]+\|\s*$/;
  const ORDERED_RE = /^\s*(\d{1,3})[\.\)]\s+(.+)$/;
  const NESTED_BULLET_RE = /^(\s{2,})[\-\*]\s+(.+)$/;

  while (lineIdx < lines.length) {
    const line = lines[lineIdx];

    // Fenced code block: ``` … ``` renders monospace, verbatim.
    if (line.trim().startsWith('```')) {
      const codeLines: string[] = [];
      lineIdx += 1;
      while (lineIdx < lines.length && !lines[lineIdx].trim().startsWith('```')) {
        codeLines.push(lines[lineIdx]);
        lineIdx += 1;
      }
      lineIdx += 1; // skip closing fence (or run off the end of an unclosed one)
      if (codeLines.length) {
        blocks.push(
          <Text key={`b-${blockKey++}`} style={[styles.messageTextCode, { color: colors.text }]}>
            {codeLines.join('\n')}
          </Text>
        );
      }
      continue;
    }

    // Simple pipe table (sets × reps schemes, weekly splits): header bold,
    // separator row dropped, cells joined for a compact readable line.
    if (TABLE_ROW_RE.test(line)) {
      const tableLines: string[] = [];
      while (lineIdx < lines.length && TABLE_ROW_RE.test(lines[lineIdx])) {
        tableLines.push(lines[lineIdx]);
        lineIdx += 1;
      }
      const rows = tableLines
        .filter(l => !TABLE_SEPARATOR_RE.test(l))
        .map(l => l.trim().replace(/^\|/, '').replace(/\|$/, '').split('|').map(c => c.trim()));
      rows.forEach((cells, rowIdx) => {
        blocks.push(
          <Text
            key={`b-${blockKey++}`}
            style={[
              rowIdx === 0 ? styles.messageTextBold : styles.messageText,
              styles.messageTextTableRow,
              { color: colors.text },
            ]}
          >
            {cells.map((cell, cellIdx) => (
              <Text key={cellIdx}>
                {cellIdx > 0 ? '   ·   ' : ''}
                {parseInlinePatterns(cell)}
              </Text>
            ))}
          </Text>
        );
      });
      continue;
    }

    const mdHead = line.match(/^(#{1,3})\s+(.+)$/);
    if (mdHead) {
      const level = mdHead[1].length;
      const headerStyle = level === 1 ? styles.messageTextHeader : styles.messageTextSubheader;
      blocks.push(
        <Text key={`b-${blockKey++}`} style={[headerStyle, { color: colors.text }]}>
          {parseInlinePatterns(mdHead[2])}
        </Text>
      );
      lineIdx += 1;
      continue;
    }
    const bullet = line.match(/^[\-\*]\s+(.+)$/);
    if (bullet) {
      blocks.push(
        <Text key={`b-${blockKey++}`} style={[styles.messageText, { color: colors.text }]}>
          {'• '}
          {parseInlinePatterns(bullet[1])}
        </Text>
      );
      lineIdx += 1;
      continue;
    }
    // Nested bullet (2+ leading spaces): indented hollow marker.
    const nestedBullet = line.match(NESTED_BULLET_RE);
    if (nestedBullet) {
      blocks.push(
        <Text key={`b-${blockKey++}`} style={[styles.messageText, { color: colors.text }]}>
          {'    ◦ '}
          {parseInlinePatterns(nestedBullet[2])}
        </Text>
      );
      lineIdx += 1;
      continue;
    }
    // Ordered list: "1. Bench press — 4×8"
    const ordered = line.match(ORDERED_RE);
    if (ordered) {
      blocks.push(
        <Text key={`b-${blockKey++}`} style={[styles.messageText, { color: colors.text }]}>
          {`${ordered[1]}. `}
          {parseInlinePatterns(ordered[2])}
        </Text>
      );
      lineIdx += 1;
      continue;
    }
    if (line.trim() === '') {
      lineIdx += 1;
      continue;
    }
    const paraLines: string[] = [];
    while (
      lineIdx < lines.length &&
      lines[lineIdx].trim() !== '' &&
      !lines[lineIdx].match(/^(#{1,3})\s/) &&
      !lines[lineIdx].match(/^[\-\*]\s/) &&
      !lines[lineIdx].match(NESTED_BULLET_RE) &&
      !lines[lineIdx].match(ORDERED_RE) &&
      !TABLE_ROW_RE.test(lines[lineIdx]) &&
      !lines[lineIdx].trim().startsWith('```')
    ) {
      paraLines.push(lines[lineIdx]);
      lineIdx += 1;
    }
    const para = paraLines.join('\n');
    blocks.push(
      <Text key={`b-${blockKey++}`} style={[styles.messageText, { color: colors.text }]}>
        {parseInlinePatterns(para)}
      </Text>
    );
  }

  if (blocks.length === 0) return '';
  if (blocks.length === 1) return blocks[0];
  return (
    <Text style={{ flexShrink: 1 }}>
      {blocks.flatMap((b, i) => (i === 0 ? [b] : ['\n', b]))}
    </Text>
  );
};

/**
 * Workout summary card. The whole card is tappable (opens the preview); the
 * CTA row is a clear secondary affordance for the same action. Module scope so
 * the card keeps its React identity across ChatScreen re-renders — its
 * FadeInDown entering animation must only run when the card first mounts.
 */
const ChatWorkoutCard = ({
  workout,
  isDark,
  onOpen,
}: {
  workout: WorkoutPlan;
  isDark: boolean;
  onOpen: (workout: WorkoutPlan) => void;
}) => {
  const colors = getThemeColors(isDark);
  const exercises = getExercises(workout);
  const exerciseCount = exercises.length;
  // Unique equipment used across the workout (max 3 chips, +N overflow).
  const equipmentList = Array.from(
    new Set(
      exercises
        // Prefer the clean, disambiguated label (e.g. "Chest Press Machine")
        // over the raw DB value (e.g. "leverage machine").
        .map(ex => ((ex as any).equipment_display || ex.equipment || '').trim())
        .filter(eq => eq && eq.toLowerCase() !== 'none' && eq.toLowerCase() !== 'bodyweight' && eq.toLowerCase() !== 'body weight')
    )
  );
  const shownEquipment = equipmentList.slice(0, 3);
  const extraEquipment = equipmentList.length - shownEquipment.length;
  const difficulty = (workout.difficulty || '').trim();
  const difficultyLabel = difficulty
    ? difficulty.charAt(0).toUpperCase() + difficulty.slice(1)
    : null;

  const a11yLabel = `${workout.workout_name}. ${exerciseCount} exercises, ${workout.estimated_time} minutes${difficultyLabel ? `, ${difficultyLabel}` : ''}. Double tap to view workout.`;

  return (
    <Reanimated.View entering={FadeInDown.duration(240)}>
      <TouchableOpacity
        activeOpacity={0.85}
        onPress={() => onOpen(workout)}
        accessibilityRole="button"
        accessibilityLabel={a11yLabel}
        style={[
          styles.workoutCard,
          { backgroundColor: colors.backgroundSecondary, borderColor: colors.border },
        ]}
      >
        <View style={styles.workoutCardHeaderRow}>
          <View style={[styles.workoutCardIconBadge, { backgroundColor: 'rgba(46,144,250,0.14)' }]}>
            <Ionicons name="barbell-outline" size={20} color={colors.primary} />
          </View>
          <Text
            style={[styles.workoutCardTitle, { color: colors.text }]}
            numberOfLines={2}
            ellipsizeMode="tail"
          >
            {workout.workout_name}
          </Text>
        </View>

        <View style={styles.workoutCardDetails}>
          <Ionicons name="fitness-outline" size={14} color={colors.textSecondary} />
          <Text style={[styles.workoutCardStat, { color: colors.textSecondary }]}>
            {exerciseCount} exercises
          </Text>
          <Text style={[styles.workoutCardStat, { color: colors.textTertiary }]}>·</Text>
          <Ionicons name="time-outline" size={14} color={colors.textSecondary} />
          <Text style={[styles.workoutCardStat, { color: colors.textSecondary }]}>
            {workout.estimated_time} min
          </Text>
          {difficultyLabel ? (
            <>
              <Text style={[styles.workoutCardStat, { color: colors.textTertiary }]}>·</Text>
              <Text style={[styles.workoutCardStat, { color: colors.textSecondary }]}>
                {difficultyLabel}
              </Text>
            </>
          ) : null}
        </View>

        {shownEquipment.length > 0 ? (
          <View style={styles.workoutCardChips}>
            {shownEquipment.map(eq => (
              <View
                key={eq}
                style={[styles.workoutCardChip, { backgroundColor: colors.backgroundTertiary }]}
              >
                <Text style={[styles.workoutCardChipText, { color: colors.textSecondary }]}>
                  {eq}
                </Text>
              </View>
            ))}
            {extraEquipment > 0 ? (
              <View style={[styles.workoutCardChip, { backgroundColor: colors.backgroundTertiary }]}>
                <Text style={[styles.workoutCardChipText, { color: colors.textSecondary }]}>
                  +{extraEquipment}
                </Text>
              </View>
            ) : null}
          </View>
        ) : null}

        <View style={[styles.viewWorkoutButton, { backgroundColor: colors.text }]}>
          <Text style={[styles.viewWorkoutButtonText, { color: colors.textInverse }]}>View Workout</Text>
          <Ionicons name="arrow-forward" size={18} color={colors.textInverse} />
        </View>
      </TouchableOpacity>
    </Reanimated.View>
  );
};

/**
 * Thumbs up/down on the coach's latest reply. Feedback is an analytics
 * signal (PostHog `coach_reply_feedback`), not a chat mutation — state lives
 * locally so tapping never re-renders the message list. Locks after one
 * choice; disappears once the user sends their next message.
 */
function CoachFeedbackRow({
  messageId,
  conversationId,
  messageLength,
  isDark,
}: {
  messageId: string;
  conversationId: string;
  messageLength: number;
  isDark: boolean;
}) {
  const [choice, setChoice] = useState<'up' | 'down' | null>(null);

  const give = (helpful: boolean) => {
    if (choice) return;
    Haptics.impactAsync(Haptics.ImpactFeedbackStyle.Light);
    setChoice(helpful ? 'up' : 'down');
    posthog.capture('coach_reply_feedback', {
      helpful,
      message_id: messageId,
      conversation_id: conversationId,
      message_length: messageLength,
    });
  };

  const idleColor = isDark ? '#5B6570' : '#A6AEB8';
  return (
    <View style={styles.feedbackRow}>
      <TouchableOpacity
        onPress={() => give(true)}
        disabled={choice !== null}
        hitSlop={{ top: 8, bottom: 8, left: 8, right: 8 }}
        accessibilityLabel="This reply was helpful"
        style={[choice === 'down' && styles.feedbackFaded]}
      >
        <Ionicons
          name={choice === 'up' ? 'thumbs-up' : 'thumbs-up-outline'}
          size={15}
          color={choice === 'up' ? '#2E90FA' : idleColor}
        />
      </TouchableOpacity>
      <TouchableOpacity
        onPress={() => give(false)}
        disabled={choice !== null}
        hitSlop={{ top: 8, bottom: 8, left: 8, right: 8 }}
        accessibilityLabel="This reply wasn't helpful"
        style={[choice === 'up' && styles.feedbackFaded]}
      >
        <Ionicons
          name={choice === 'down' ? 'thumbs-down' : 'thumbs-down-outline'}
          size={15}
          color={choice === 'down' ? '#2E90FA' : idleColor}
        />
      </TouchableOpacity>
    </View>
  );
}

interface MemoizedMessageProps {
  message: ChatMessage;
  streamingGraphLabel: string | null;
  streamingStatus: string | null;
  isDark: boolean;
  /** True when this message is the target of the typewriter animation. */
  isTypingTarget: boolean;
  /** True only for the latest fully-delivered coach text message. */
  showFeedback: boolean;
  conversationId: string;
  onOpenWorkout: (workout: WorkoutPlan) => void;
  /** Long-press → message action sheet (copy / edit / regenerate / feedback). */
  onLongPress: (message: ChatMessage) => void;
}

/**
 * Memoized chat message renderer.
 *
 * MUST stay at module scope: when this lived inside ChatScreen, React.memo
 * created a brand-new component TYPE on every parent render, so every
 * keystroke in the input (setInputText → re-render) unmounted and remounted
 * every message — replaying the workout card's entering animation ("GUI
 * glitches in and out" on each key press) and defeating memoization entirely.
 */
const MemoizedMessage = React.memo<MemoizedMessageProps>(
  ({ message, streamingGraphLabel, streamingStatus, isDark, isTypingTarget, showFeedback, conversationId, onOpenWorkout, onLongPress }) => {
    const colors = getThemeColors(isDark);
    const feedbackRow = showFeedback ? (
      <CoachFeedbackRow
        messageId={message.id}
        conversationId={conversationId}
        messageLength={(message.text ?? '').length}
        isDark={isDark}
      />
    ) : null;
    // TWO-MESSAGE FLOW: Handle workout card type (separate message)
    if (message.messageType === 'workout' && message.workoutData) {
      return (
        <View style={styles.workoutMessageContainer}>
          <View style={styles.workoutCardWrapper}>
            <ChatWorkoutCard workout={message.workoutData} isDark={isDark} onOpen={onOpenWorkout} />
          </View>
        </View>
      );
    }

    // TWO-MESSAGE FLOW: Handle plain text without bubble
    if (message.noBubble && !message.isUser) {
      const displayText = message.displayedText !== undefined ? message.displayedText : message.text;
      const showCursor = message.isTyping && isTypingTarget;

      if (!displayText?.trim() && !message.isLoading && !message.coachActivityLabel) {
        return null;
      }

      return (
        <View style={styles.plainTextRow}>
          {/* Persistent coach glyph — same blue identity as the thinking orb,
              so streamed text reads as the coach's voice, not a stray label. */}
          <View style={[styles.coachAvatar, { backgroundColor: 'rgba(46,144,250,0.14)' }]}>
            <View style={[styles.coachAvatarDot, { backgroundColor: colors.primary }]} />
          </View>
          <View style={styles.plainTextContainer}>
            {!!displayText?.trim() && (
              <Text
                style={[styles.plainTextMessage, { color: colors.text }]}
                onLongPress={() => onLongPress(message)}
                suppressHighlighting
              >
                {parseFormattedText(displayText || '', false, colors)}
                {showCursor && <Text style={[styles.cursor, { color: colors.primary }]}>|</Text>}
              </Text>
            )}
            {message.coachActivityLabel ? (
              <Text style={[styles.coachActivityLabel, { color: colors.textSecondary }]}>
                {message.coachActivityLabel}
              </Text>
            ) : null}
            {!message.isTyping && feedbackRow}
          </View>
        </View>
      );
    }

    // Don't render empty messages
    if (!message.text?.trim() && !message.workoutData && !message.isLoading) {
      return null;
    }

    // Show loading animation if message is loading
    if (message.isLoading) {
      return (
        <View style={styles.messageContainer}>
          <View style={styles.loadingContainer}>
            <AiThinkingState
              graphNodeMessage={streamingGraphLabel}
              currentStatus={streamingStatus}
              toolHint={message.coachActivityLabel ?? null}
              isDark={isDark}
            />
          </View>
        </View>
      );
    }

    // Get text content and extract intent mode if present
    const displayText = message.displayedText !== undefined ? message.displayedText : message.text;
    const { intentMode, cleanedText } = extractIntentMode(displayText || '');
    const showCursor = message.isTyping && isTypingTarget;
    const hasText = !!(cleanedText && cleanedText.trim().length > 0);

    // If message has workout data, parse text to position workout card inline (OLD FORMAT - fallback)
    if (message.workoutData) {
      // Prefer explicit marker injected during streaming; else fallback to regex split
      if ((cleanedText || '').includes(WORKOUT_CARD_MARKER)) {
        const parts = (cleanedText || '').split(WORKOUT_CARD_MARKER);
        const textBefore = (parts[0] || '').trim();
        const textAfter = (parts[1] || '').trim();
        return (
          <View style={[styles.messageContainer, styles.coachBriefingCardStack]}>
            {/* Show intent mode badge if present */}
            {intentMode && !message.isUser && (
              <View style={styles.intentModeBadge}>
                <Ionicons name="locate" size={11} color="#5AA6FF" />
                <Text style={styles.intentModeText}>{intentMode}</Text>
              </View>
            )}
            {textBefore ? (
              <Text style={[styles.messageText, { color: colors.text }]}>
                {parseFormattedText(textBefore, message.isUser, colors)}
                {showCursor && <Text style={[styles.cursor, { color: colors.primary }]}>|</Text>}
              </Text>
            ) : null}
            <View style={styles.workoutCardContainer}>
              <ChatWorkoutCard workout={message.workoutData} isDark={isDark} onOpen={onOpenWorkout} />
            </View>
            {textAfter ? (
              <Text style={[styles.messageText, { color: colors.text }]}>
                {parseFormattedText(textAfter, message.isUser, colors)}
              </Text>
            ) : null}
          </View>
        );
      }
      // Fallback: split by JSON-like section
      const jsonMatch = (cleanedText || '').match(/(.*?)(```json?[\s\S]*?```|```[\s\S]*?```|\{[\s\S]*"workout_name"[\s\S]*\})(.*)/);

      if (jsonMatch) {
        const textBefore = jsonMatch[1].trim();
        const textAfter = jsonMatch[3].trim();

        return (
          <View style={[styles.messageContainer, styles.coachBriefingCardStack]}>
            {/* Show intent mode badge if present */}
            {intentMode && !message.isUser && (
              <View style={styles.intentModeBadge}>
                <Ionicons name="locate" size={11} color="#5AA6FF" />
                <Text style={styles.intentModeText}>{intentMode}</Text>
              </View>
            )}
            {/* Show text before JSON */}
            {textBefore && (
              <Text style={[styles.messageText, { color: colors.text }]}>
                {parseFormattedText(textBefore, message.isUser, colors)}
                {showCursor && <Text style={[styles.cursor, { color: colors.primary }]}>|</Text>}
              </Text>
            )}

            {/* Show workout card inline where JSON would be */}
            <View style={styles.workoutCardContainer}>
              <ChatWorkoutCard workout={message.workoutData} isDark={isDark} onOpen={onOpenWorkout} />
            </View>

            {/* Show text after JSON */}
            {textAfter && (
              <Text style={[styles.messageText, { color: colors.text }]}>
                {parseFormattedText(textAfter, message.isUser, colors)}
              </Text>
            )}
          </View>
        );
      }
    }

    // Default rendering for messages without workout data or without text.
    // User bubbles are solid brand blue with white text (paywall coach-chat
    // styling); AI messages stay as open text.
    const userColors = { ...colors, text: '#FFFFFF' };
    const aiColors = { ...colors, text: colors.text };

    return (
      <View style={styles.messageContainer}>
        <Pressable
          onLongPress={() => onLongPress(message)}
          delayLongPress={350}
          style={[
            message.isUser ? styles.userMessageBubble : styles.aiMessageBubble,
            message.workoutData && styles.coachBriefingCardStack
          ]}>
          {/* Show intent mode badge if present */}
          {intentMode && !message.isUser && (
            <View style={styles.intentModeBadge}>
              <Ionicons name="locate" size={11} color="#5AA6FF" />
              <Text style={styles.intentModeText}>{intentMode}</Text>
            </View>
          )}
          {/* Show text content if it exists; skip empty bubbles entirely */}
          {hasText && (
            <Text style={[styles.messageText, message.isUser ? styles.userMessageText : styles.aiMessageText, { color: message.isUser ? '#FFFFFF' : colors.text }]}>
              {parseFormattedText(cleanedText || '', message.isUser, message.isUser ? userColors : aiColors)}
              {showCursor && <Text style={[styles.cursor, { color: colors.primary }]}>|</Text>}
            </Text>
          )}

          {/* Show workout card if it exists (fallback for messages without text) */}
          {message.workoutData && (
            <View style={styles.workoutCardContainer}>
              <ChatWorkoutCard workout={message.workoutData} isDark={isDark} onOpen={onOpenWorkout} />
            </View>
          )}
        </Pressable>
        {!message.isUser && !message.isTyping && feedbackRow}
      </View>
    );
  },
  (prev, next) => {
    // Only re-render if these properties change
    return (
      prev.message.id === next.message.id &&
      prev.message.isTyping === next.message.isTyping &&
      prev.message.displayedText === next.message.displayedText &&
      prev.message.text === next.message.text &&
      prev.message.isLoading === next.message.isLoading &&
      prev.message.coachActivityLabel === next.message.coachActivityLabel &&
      prev.message.messageType === next.message.messageType &&
      prev.streamingGraphLabel === next.streamingGraphLabel &&
      prev.streamingStatus === next.streamingStatus &&
      prev.isDark === next.isDark &&
      prev.isTypingTarget === next.isTypingTarget &&
      prev.showFeedback === next.showFeedback &&
      prev.conversationId === next.conversationId &&
      prev.onOpenWorkout === next.onOpenWorkout &&
      prev.onLongPress === next.onLongPress &&
      // Deep comparison for workoutData if it exists
      JSON.stringify(prev.message.workoutData) === JSON.stringify(next.message.workoutData)
    );
  }
);
MemoizedMessage.displayName = 'MemoizedMessage';

export default function ChatScreen() {
  // Theme support
  const { isDark } = useTheme();
  const colors = getThemeColors(isDark);
  const insets = useSafeAreaInsets();
  const proGate = useProGate();

  // Free-tier allowance counter ("2 of 3 coach messages left today"). The
  // count increments server-side pre-flight, so refetch whenever a turn
  // finishes (isTyping falls) to keep the pill honest.
  const { tier: quotaTier, chatsRemaining, refetch: refetchQuota } = useUserQuota();

  // The native tab bar floats over content (it doesn't occupy layout space
  // like the old JS tab bar), so the input bar needs the bottom safe-area
  // inset — which includes the tab bar height — when the keyboard is hidden.
  // When the keyboard is up it covers the tab bar, so the inset would just
  // add a dead gap above the keyboard; drop it then.
  const [keyboardVisible, setKeyboardVisible] = useState(false);
  useEffect(() => {
    const showEvent = Platform.OS === 'ios' ? 'keyboardWillShow' : 'keyboardDidShow';
    const hideEvent = Platform.OS === 'ios' ? 'keyboardWillHide' : 'keyboardDidHide';
    const show = Keyboard.addListener(showEvent, () => setKeyboardVisible(true));
    const hide = Keyboard.addListener(hideEvent, () => setKeyboardVisible(false));
    return () => {
      show.remove();
      hide.remove();
    };
  }, []);

  // Get route params for initial message from home screen
  const params = useLocalSearchParams();
  const initialMessage = params.initialMessage as string | undefined;

  // State management for chat functionality
  const [messages, setMessages] = useState<ChatMessage[]>([]);
  const [inputText, setInputText] = useState('');
  const [isTyping, setIsTyping] = useState(false);
  const [quotaError, setQuotaError] = useState<QuotaExceededError | null>(null);

  // Keep the allowance pill in sync: the server consumes a count when a turn
  // starts, so re-read the row every time a turn ends (or a 429 lands).
  useEffect(() => {
    if (!isTyping) void refetchQuota();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [isTyping, quotaError]);
  const [pendingWorkout, setPendingWorkout] = useState<WorkoutPlan | null>(null);
  // Synchronous guard: state updates are async, so under React's
  // effect double-invocation (StrictMode / re-render while the param is still set)
  // the gate below would fire handleSendInitialMessage twice — two graph runs whose
  // preamble + recap text concatenate and whose racing setMessages wipe the workout
  // card. A ref is applied synchronously and survives the double-invoke, so a given
  // initialMessage is dispatched exactly once.
  const dispatchedInitialMessageRef = useRef<string | null>(null);
  const [typingMessageId, setTypingMessageId] = useState<string | null>(null);
  const [hasStartedChat, setHasStartedChat] = useState(false);
  const [userProfile, setUserProfile] = useState<UserProfile | null>(null);
  // First name for the greeting, resolved the same way as the Home tab: the DB
  // stores the literal placeholder "User" when onboarding never captured a real
  // name, so fall back to OAuth user_metadata before giving up.
  const [greetingName, setGreetingName] = useState('');
  const [mainPlanContext, setMainPlanContext] = useState<any>(null);
  const [todayBrief, setTodayBrief] = useState<CoachTodayBrief | null>(null);
  const [mainPlanEditPreview, setMainPlanEditPreview] = useState<any>(null);
  const [isMainPlanEdit, setIsMainPlanEdit] = useState(false);
  const [showWorkoutPreview, setShowWorkoutPreview] = useState(false);
  const [currentWorkoutMessageId, setCurrentWorkoutMessageId] = useState<string | null>(null);
  /** Mirrors SSE tool_start label for input placeholder while tools run */
  const [coachActivityHint, setCoachActivityHint] = useState<string | null>(null);
  /** LangGraph node label for AiThinkingState (SSE graph_node) */
  const [thinkingGraphLabel, setThinkingGraphLabel] = useState<string | null>(null);
  /**
   * Live, request-specific thinking line streamed from the model — its own
   * `preamble` (SSE `status`) and the dynamic tool label (SSE `tool_start`).
   * Last-write-wins; highest priority in AiThinkingState so the loading text
   * reads like the coach reasoning about THIS request, not a canned phrase.
   */
  const [thinkingStatus, setThinkingStatus] = useState<string | null>(null);
  const isChangeRequestRef = useRef(false);

  const personalizedChips = useMemo(() => {
    const dayTitle = new Date().toLocaleDateString('en-US', { weekday: 'long' });
    const list: { id: string; label: string; prompt: string }[] = [];
    const hasPlan = Array.isArray(mainPlanContext?.weeklySchedule) && mainPlanContext.weeklySchedule.length > 0;

    if (todayBrief?.status === 'workout' && todayBrief.splitLabel?.trim()) {
      const short = truncateChipLabel(todayBrief.splitLabel.trim(), 22);
      if (short.length > 0) {
        list.push({
          id: 'today-session',
          label: `Coach my ${short}`,
          prompt: `I'm on "${todayBrief.splitLabel}" today (${dayTitle}). Give brief coaching tips for intensity and form — do not write out a full workout; I'll use my plan and the app workout flow.`,
        });
      }
    } else if (todayBrief?.status === 'rest') {
      list.push({
        id: 'rest-day',
        label: 'Recovery today',
        prompt: `${dayTitle} is a rest day in my plan. What mobility or light movement would you suggest?`,
      });
    } else if (todayBrief?.status === 'no_plan' || (!hasPlan && todayBrief?.status !== 'error')) {
      list.push({
        id: 'plan-setup',
        label: 'Plan my week',
        prompt: `Help me set up a realistic weekly split that fits my schedule and equipment.`,
      });
    }

    if (userProfile?.goal) {
      const gMap: Record<string, string> = {
        lose: 'fat loss',
        gain: 'size',
        build_muscle: 'muscle',
        maintain: 'maintenance',
      };
      const g = gMap[userProfile.goal] || userProfile.goal;
      list.push({
        id: 'goal-focus',
        label: `This week: ${g}`,
        prompt: `My main goal is ${g}. What should I emphasize in training this week?`,
      });
    }

    list.push({
      id: 'adjust-today',
      label: 'Short on time today',
      prompt: `I'm short on time today — how should I trim my session without skipping the most important work?`,
    });

    if (userProfile?.available_equipment?.length) {
      const eq = userProfile.available_equipment.slice(0, 4).join(', ');
      list.push({
        id: 'equipment',
        label: 'Use my equipment',
        prompt: `I have: ${eq}. Suggest one effective finisher I can add after my main lifts.`,
      });
    }

    list.push({
      id: 'form',
      label: 'Squat cues',
      prompt: `What are the top cues to keep my squat safe when the weight gets heavy?`,
    });

    const seen = new Set<string>();
    const deduped = list.filter((item) => {
      if (seen.has(item.id)) return false;
      seen.add(item.id);
      return true;
    });
    return deduped.slice(0, 3);
  }, [todayBrief, mainPlanContext, userProfile]);

  // ChatFSM for lifecycle control - manages input blocking, chat locking, and streaming states
  const [chatFSM, dispatchFSM] = React.useReducer(reduceChatFSM, createChatFSM());

  // Intent & context
  type ActiveIntent = 'none' | 'create_workout' | 'edit_workout' | 'main_plan_edit' | 'replacement_workout';
  const [activeIntent, setActiveIntent] = useState<ActiveIntent>('none');
  const [intentContext, setIntentContext] = useState<any>(null);
  // (Value no longer rendered — the intent pill is gone — but setters keep
  // the edit-target bookkeeping intact for handleMakeChanges/reject flows.)
  const [, setEditingTargetName] = useState<string | null>(null);

  // Chat history state
  const [showHistorySidebar, setShowHistorySidebar] = useState(false);
  const [conversationId, setConversationId] = useState<string>(() => generateConversationId());
  const [userId, setUserId] = useState<string | null>(null);

  // Tappable follow-up replies from the coach's last message (SSE `suggestions`).
  const [suggestedReplies, setSuggestedReplies] = useState<string[]>([]);

  // Stop-generation: aborts the live SSE turn (backend stops the graph run).
  const stopControllerRef = useRef<AbortController | null>(null);

  // "Try again" chip target: the failed assistant bubble + the message to resend.
  const [retryTarget, setRetryTarget] = useState<{ messageId: string; message: string } | null>(null);

  // Long-press action sheet target (copy / edit & resend / regenerate / feedback).
  const [actionTarget, setActionTarget] = useState<ChatMessage | null>(null);

  // Scroll model: auto-scroll only while the user is already reading the tail.
  // Scrolling up to reread mid-stream must never be fought by the stream.
  const isNearBottomRef = useRef(true);
  const [showJumpToLatest, setShowJumpToLatest] = useState(false);

  // Connectivity: disable send + show a quiet pill instead of reactive errors.
  const [isOffline, setIsOffline] = useState(false);
  useEffect(() => {
    const unsubscribe = NetInfo.addEventListener(state => {
      setIsOffline(!(state.isConnected && state.isInternetReachable !== false));
    });
    return () => unsubscribe();
  }, []);

  // Animation for AI icon - multiple animations
  const dot1Float = useRef(new Animated.Value(0)).current;
  const dot2Float = useRef(new Animated.Value(0)).current;
  const dot3Float = useRef(new Animated.Value(0)).current;
  const pulseAnim = useRef(new Animated.Value(1)).current;
  const rotateAnim = useRef(new Animated.Value(0)).current;
  const sendButtonOpacity = useRef(new Animated.Value(0)).current;

  useEffect(() => {
    Animated.timing(sendButtonOpacity, {
      toValue: (!inputText.trim() || isTyping || isOffline || isInputDisabled(chatFSM)) ? 0 : 1,
      duration: 250,
      useNativeDriver: true,
    }).start();
  }, [inputText, isTyping, isOffline, chatFSM, sendButtonOpacity]);

  // Refs for scroll and input management. The message list is an INVERTED
  // FlatList: content offset 0 is the visual bottom (the newest message), so
  // "scroll to latest" is scrollToOffset(0) and near-bottom is offset < 80.
  const listRef = useRef<FlatList<ChatMessage>>(null);
  const textInputRef = useRef<TextInput>(null);
  const hasNavigatedRef = useRef(false);
  const lastStreamHapticAt = useRef(0);

  const streamCoachHaptic = useCallback((kind: 'light' | 'medium') => {
    const now = Date.now();
    if (kind === 'light' && now - lastStreamHapticAt.current < 300) return;
    lastStreamHapticAt.current = now;
    coachHaptic(kind);
  }, []);

  const workoutArrivedHaptic = useCallback(() => {
    lastStreamHapticAt.current = Date.now();
    coachHaptic('medium');
  }, []);

  // Navigation hook for routing to workout screen
  const router = useRouter();

  // Load user profile and main plan context on component mount
  useEffect(() => {
    const loadData = async () => {
      console.log('Loading data for AI context...');

      // Load user profile
      try {
        const session = await getSession();
        if (session) {
          const { profile } = await getUserProfile(session.user.id);
          if (profile) {
            setUserProfile(profile);
            console.log('Loaded user profile for', profile.name);
          }

          // Resolve greeting first name via the shared chain (mirrors Home).
          setGreetingName(resolveFirstName(profile?.name, session.user.user_metadata));

          // Load main plan context using WorkoutService (single source of truth)
          try {
            const todayState = await WorkoutService.resolveToday(session.user.id);
            setTodayBrief({
              status: todayState.status,
              splitLabel: todayState.workout?.splitName,
              isReplacement: todayState.isReplacement,
              dayOfWeek: todayState.dayOfWeek,
            });
            const activePlan = await WorkoutService.getActivePlan(session.user.id);

            const schedule = activePlan?.schedule || [];
            let todaysWorkout = null;

            if (todayState.status === 'workout' && todayState.workout) {
              todaysWorkout = {
                workout_name: todayState.workout.splitName,
                exercises: todayState.workout.exercises || [],
                exercises_structured: todayState.workout.exercises_structured || [],
                estimated_time: todayState.workout.estimatedTime || 0,
              };
            }

            const planContext = {
              weeklySchedule: schedule,
              todaysWorkout: todaysWorkout,
              currentDay: new Date().toLocaleDateString('en-US', { weekday: 'long' }).toLowerCase()
            };
            setMainPlanContext(planContext);
            console.log('Loaded main plan context with', schedule.length, 'days');
          } catch (error) {
            console.error('Error loading main plan context:', error);
          }
        }
      } catch (error) {
        console.error('Error loading user profile:', error);
      }

    };

    loadData();
  }, []);

  // Snap to the newest message when the list grows or typing toggles — but
  // only while the user is already at the tail. (The inverted list keeps
  // offset 0 pinned during streaming growth; this covers new-item jumps.)
  useEffect(() => {
    if (!isNearBottomRef.current) return;
    const id = requestAnimationFrame(() => {
      listRef.current?.scrollToOffset({ offset: 0, animated: true });
    });
    return () => cancelAnimationFrame(id);
  }, [messages.length, isTyping]);

  useEffect(() => {
    const scrollIfAtTail = () => {
      if (!isNearBottomRef.current) return;
      requestAnimationFrame(() => {
        listRef.current?.scrollToOffset({ offset: 0, animated: true });
      });
    };
    const showSubscription = Keyboard.addListener('keyboardDidShow', scrollIfAtTail);
    const hideSubscription = Keyboard.addListener('keyboardDidHide', scrollIfAtTail);

    return () => {
      showSubscription.remove();
      hideSubscription.remove();
    };
  }, []);

  /**
   * Track whether the user is reading the tail of the conversation. In the
   * inverted list, offset 0 IS the newest message, so "at the tail" is simply
   * a small offset; further up shows the jump-to-latest pill instead of
   * yanking their reading position.
   */
  const handleMessagesScroll = useCallback((e: NativeSyntheticEvent<NativeScrollEvent>) => {
    const nearBottom = e.nativeEvent.contentOffset.y < 80;
    isNearBottomRef.current = nearBottom;
    setShowJumpToLatest(prev => (prev === !nearBottom ? prev : !nearBottom));
  }, []);

  const handleJumpToLatest = useCallback(() => {
    isNearBottomRef.current = true;
    setShowJumpToLatest(false);
    listRef.current?.scrollToOffset({ offset: 0, animated: true });
  }, []);

  // Handle initial message from home screen - start new chat.
  // Dedupe on the message content via a synchronous ref so the same initialMessage
  // is only ever sent once, even if this effect is invoked multiple times.
  useEffect(() => {
    if (initialMessage && dispatchedInitialMessageRef.current !== initialMessage) {
      dispatchedInitialMessageRef.current = initialMessage;
      console.log('Processing initial message from home screen - starting new chat:', initialMessage);

      // Clear existing chat and start fresh
      handleNewChat();

      // Send the message after clearing chat
      setTimeout(() => {
        handleSendInitialMessage(initialMessage);
      }, 100);
    }
  }, [initialMessage]);

  // Start AI icon animations
  useEffect(() => {
    // Dot 1 float animation (starts immediately)
    const dot1Animation = Animated.loop(
      Animated.sequence([
        Animated.timing(dot1Float, {
          toValue: -4,
          duration: 800,
          useNativeDriver: true,
        }),
        Animated.timing(dot1Float, {
          toValue: 0,
          duration: 800,
          useNativeDriver: true,
        }),
      ])
    );
    dot1Animation.start();

    // Dot 2 float animation (266ms delay)
    const dot2Timer = setTimeout(() => {
      const dot2Animation = Animated.loop(
        Animated.sequence([
          Animated.timing(dot2Float, {
            toValue: -4,
            duration: 800,
            useNativeDriver: true,
          }),
          Animated.timing(dot2Float, {
            toValue: 0,
            duration: 800,
            useNativeDriver: true,
          }),
        ])
      );
      dot2Animation.start();
    }, 266);

    // Dot 3 float animation (533ms delay)
    const dot3Timer = setTimeout(() => {
      const dot3Animation = Animated.loop(
        Animated.sequence([
          Animated.timing(dot3Float, {
            toValue: -4,
            duration: 800,
            useNativeDriver: true,
          }),
          Animated.timing(dot3Float, {
            toValue: 0,
            duration: 800,
            useNativeDriver: true,
          }),
        ])
      );
      dot3Animation.start();
    }, 533);

    // Pulse animation (entire group)
    const pulseAnimation = Animated.loop(
      Animated.sequence([
        Animated.timing(pulseAnim, {
          toValue: 1.15,
          duration: 1200,
          useNativeDriver: true,
        }),
        Animated.timing(pulseAnim, {
          toValue: 1,
          duration: 1200,
          useNativeDriver: true,
        }),
      ])
    );
    pulseAnimation.start();

    // Rotation animation (2D - stable)
    const rotateAnimation = Animated.loop(
      Animated.timing(rotateAnim, {
        toValue: 1,
        duration: 4000,
        useNativeDriver: true,
      })
    );
    rotateAnimation.start();

    // Cleanup function to stop all animations
    return () => {
      dot1Animation.stop();
      pulseAnimation.stop();
      rotateAnimation.stop();
      clearTimeout(dot2Timer);
      clearTimeout(dot3Timer);
    };
  }, []);

  // Animated styles for AI icon
  const rotateStyle = {
    transform: [
      { scale: pulseAnim },
      {
        rotate: rotateAnim.interpolate({
          inputRange: [0, 1],
          outputRange: ['0deg', '360deg'],
        })
      }
    ],
  };

  const dot1Style = {
    transform: [{ translateY: dot1Float }],
  };

  const dot2Style = {
    transform: [{ translateY: dot2Float }],
  };

  const dot3Style = {
    transform: [{ translateY: dot3Float }],
  };

  const renderStreamingThinking = useCallback(
    (toolHint?: string | null) => (
      <View style={styles.loadingContainer}>
        <AiThinkingState
          graphNodeMessage={thinkingGraphLabel}
          currentStatus={thinkingStatus}
          toolHint={toolHint ?? null}
          isDark={isDark}
        />
      </View>
    ),
    [thinkingGraphLabel, thinkingStatus, isDark]
  );

  // Dismiss keyboard when tapping outside
  const dismissKeyboard = () => {
    textInputRef.current?.blur();
  };

  // Handle keyboard dismissal during AI response
  const handleScreenPress = () => {
    if (textInputRef.current?.isFocused()) {
      textInputRef.current.blur();
    }
  };

  const handleMakeChanges = () => {
    setShowWorkoutPreview(false);
    setInputText("I want to make some changes to the workout that was just sent: ");
    isChangeRequestRef.current = true;
    if (pendingWorkout) {
      setActiveIntent('edit_workout');
      setEditingTargetName(pendingWorkout.workout_name);
      setIntentContext({ previousWorkout: pendingWorkout });
    }
    // Focus the input after a short delay to ensure the modal is closed
    setTimeout(() => {
      textInputRef.current?.focus();
    }, 100);
  };

  // Round time to nearest 5 minutes
  const roundToNearest5Minutes = (time: number): number => {
    return Math.round(time / 5) * 5;
  };

  // Load user ID on mount
  useEffect(() => {
    getSession().then(session => {
      if (session?.user) {
        setUserId(session.user.id);
      }
    });
  }, []);

  /**
   * Handle loading a conversation from history
   */
  const handleLoadConversation = async (convId: string) => {
    try {
      if (!userId) return;

      // Switching conversations mid-reply kills the in-flight answer — make
      // sure that's what the user wants before doing it.
      if (isTyping) {
        const ok = await confirmSheet({
          title: 'Stop the coach?',
          message: "The coach is still replying. Opening another chat will stop this answer.",
          confirmLabel: 'Open Chat',
          destructive: true,
        });
        if (!ok) return;
        stopControllerRef.current?.abort();
      }

      console.log('Loading conversation:', convId);
      const { messages: historyMessages } = await loadConversation(convId);

      // Convert history messages to chat messages
      const chatMessages: ChatMessage[] = historyMessages.map((msg: HistoryMessage) => ({
        id: msg.id,
        text: msg.content,
        isUser: msg.role === 'user',
        timestamp: new Date(msg.created_at),
        workoutData: msg.metadata?.workout_data || msg.metadata?.workoutData || undefined
      }));

      setMessages(chatMessages);
      setConversationId(convId);
      setShowHistorySidebar(false);
      setSuggestedReplies([]);
      setRetryTarget(null);
      setActionTarget(null);
      isNearBottomRef.current = true;
      setShowJumpToLatest(false);
    } catch (error) {
      console.error('Error loading conversation:', error);
      toast.error('Failed to load conversation');
    }
  };

  /**
   * Start a new chat
   */
  const handleNewChat = () => {
    // A live stream belongs to the old conversation — stop it first.
    stopControllerRef.current?.abort();
    setMessages([]);
    setConversationId(generateConversationId());
    setShowHistorySidebar(false);
    setInputText('');
    setSuggestedReplies([]);
    setRetryTarget(null);
    setActionTarget(null);
    isNearBottomRef.current = true;
    setShowJumpToLatest(false);
    setPendingWorkout(null);
    setIsTyping(false);
    setTypingMessageId(null);
    setHasStartedChat(false);
    setIsMainPlanEdit(false);
    setMainPlanEditPreview(null);
    setActiveIntent('none');
    setIntentContext(null);
    setEditingTargetName(null);
    setActiveIntent('none');
    setIntentContext(null);
    setEditingTargetName(null);
    // Reset ChatFSM state
    dispatchFSM({ type: 'RESET' });
    setCoachActivityHint(null);
    setThinkingGraphLabel(null); setThinkingStatus(null);

    console.log('New chat started');
  };

  /**
   * User-facing "new chat" entry point (navbar +, sidebar button). If the
   * coach is mid-reply, confirm before discarding the in-flight answer — one
   * accidental tap must not silently kill a response. Programmatic resets
   * (initial-message effect) call handleNewChat directly.
   */
  const requestNewChat = async () => {
    if (isTyping) {
      const ok = await confirmSheet({
        title: 'Stop the coach?',
        message: 'The coach is still replying. Start a new chat and discard the rest of this answer?',
        confirmLabel: 'New Chat',
        destructive: true,
      });
      if (!ok) return;
    }
    handleNewChat();
  };

  /**
   * Home-screen initial message — routed through the unified turn runner
   * (runChatTurn) like every other send path.
   */
  const handleSendInitialMessage = (message: string) => {
    console.log('Sending initial message from home screen:', message);
    void runChatTurn(message, { source: 'initial' });
  };

  // Returning from the workout screen: land on the chat, never the preview.
  useFocusEffect(
    useCallback(() => {
      if (hasNavigatedRef.current) {
        console.log('Returned from workout — closing preview, clearing pending workout');
        setShowWorkoutPreview(false);
        setPendingWorkout(null);
        hasNavigatedRef.current = false;
      }
    }, [])
  );

  // Ensure main plan context before streaming — USES SINGLE SOURCE OF TRUTH
  const ensureMainPlanContext = useCallback(async (): Promise<any | null> => {
    if (mainPlanContext && (mainPlanContext.weeklySchedule || mainPlanContext.todaysWorkout)) {
      return mainPlanContext;
    }
    try {
      const currentSession = await getSession();
      if (!currentSession) return null;

      // SINGLE SOURCE OF TRUTH: WorkoutService.resolveToday()
      const todayState = await WorkoutService.resolveToday(currentSession.user.id);
      setTodayBrief({
        status: todayState.status,
        splitLabel: todayState.workout?.splitName,
        isReplacement: todayState.isReplacement,
        dayOfWeek: todayState.dayOfWeek,
      });

      let todaysWorkout: any | null = null;

      if (todayState.status === 'workout' && todayState.workout) {
        todaysWorkout = {
          workout_name: todayState.workout.splitName,
          exercises: todayState.workout.exercises || [],
          exercises_structured: todayState.workout.exercises_structured || [],
          estimated_time: todayState.workout.estimatedTime || 0,
          difficulty: 'intermediate',
          description: todayState.workout.note || '',
          workout_type: todayState.isReplacement ? 'replacement_workout' : 'main_plan',
        };
      }

      // Get weekly schedule from Supabase
      let weeklySchedule: any[] | null = null;
      const activePlan = await WorkoutService.getActivePlan(currentSession.user.id);
      if (activePlan?.schedule) {
        weeklySchedule = activePlan.schedule;
      }

      const ctx = {
        weeklySchedule: weeklySchedule || [],
        todaysWorkout: todaysWorkout,
        currentDay: new Date().toLocaleDateString('en-US', { weekday: 'long' }).toLowerCase()
      };
      setMainPlanContext(ctx);
      return ctx;
    } catch (e) {
      console.warn('Failed to ensure main plan context:', e);
      return null;
    }
  }, [mainPlanContext]);

  /**
   * UNIFIED CHAT TURN — the single SSE stream handler for every send path:
   * typed input, suggested-reply chips, the home-screen initial message, and
   * "Try again" / regenerate re-sends. This logic previously existed as two
   * ~500-line near-identical copies (initial-message path and sendMessage
   * path); every streaming feature had to be built twice and the copies had
   * silently drifted. Any change to stream handling belongs HERE, once.
   *
   * NOTE: Intent detection is handled ENTIRELY by the backend orchestrator —
   * the backend is the single source of truth.
   *
   * Returns true when a turn actually started, so callers can decide whether
   * to clear the input box.
   */
  const runChatTurn = useCallback(async (
    messageText: string,
    opts?: {
      source?: 'input' | 'chip' | 'retry' | 'initial';
      /** Re-sends (retry/regenerate): the user bubble is already on screen. */
      skipUserEcho?: boolean;
    }
  ): Promise<boolean> => {
    const source = opts?.source ?? 'input';
    const skipUserEcho = opts?.skipUserEcho === true;
    const message = messageText.trim();
    if (!message || isTyping) return false;

    // Offline short-circuit: keep the typed message instead of burning it
    // into an error bubble the moment we know the request can't leave the phone.
    if (isOffline) {
      coachHaptic('warning');
      toast.error("You're offline", 'Reconnect to message your coach.');
      return false;
    }

    // Client-side pre-gate: at 0 free messages the server is guaranteed to 429,
    // so open the quota sheet immediately instead of burning a round trip and
    // consuming the user's typed message into an error bubble. The input is
    // left intact so the message survives an upgrade or the daily reset.
    // (Server-side enforcement in quotaGate stays the source of truth.)
    if (quotaTier === 'ad_supported' && chatsRemaining === 0) {
      posthog.capture('chat_send_blocked_client_quota');
      router.push({
        pathname: '/quota-limit',
        params: { feature: 'chat', reason: 'chat_limit' },
      });
      return false;
    }

    console.log(`User sent message (source=${source}):`, message);
    posthog.capture('chat_message_sent', { message_length: message.length, source });

    // Mark that chat has started
    setHasStartedChat(true);
    setRetryTarget(null);
    setActionTarget(null);

    const userChatMessage: ChatMessage = {
      id: `u-${Date.now()}-${Math.floor(Math.random() * 1e6)}`,
      text: message,
      isUser: true,
      timestamp: new Date(),
    };

    // Create placeholder for AI response
    const aiChatMessage: ChatMessage = {
      id: `a-${Date.now()}-${Math.floor(Math.random() * 1e6)}`,
      text: '',
      isUser: false,
      timestamp: new Date(),
      displayedText: '',
      isTyping: true,
      isLoading: true, // Start with loading state
    };

    // The user just acted — a fresh turn always snaps the view to the bottom.
    isNearBottomRef.current = true;
    setShowJumpToLatest(false);

    setMessages(prev =>
      skipUserEcho ? [...prev, aiChatMessage] : [...prev, userChatMessage, aiChatMessage]
    );
    if (source === 'input') setInputText('');
    setIsTyping(true);
    setThinkingGraphLabel(null); setThinkingStatus(null);
    setSuggestedReplies([]);

    // Save user message to history (re-sends already saved it the first time)
    if (!skipUserEcho && userId && conversationId) {
      saveMessage(userId, conversationId, 'user', message).catch(err =>
        console.error('Failed to save user message:', err)
      );
    }

    // Reset change request flag for new message
    isChangeRequestRef.current = false;

    // Track when first content arrives for minimum delay
    let firstContentReceived = false;
    let minimumDelayElapsed = false;
    let contentBuffer = '';
    let fullMessageText = '';
    /** Full assistant text for this turn — unlike fullMessageText it is never
     *  reset when the text target re-points, so history gets the whole reply. */
    let assistantTranscript = '';
    /** While > 0, backend execute_tools is in progress — do not clear isLoading on text tokens */
    let toolExecutionDepth = 0;
    /** True when this turn received a workout payload (valid card-only response is allowed). */
    let receivedWorkoutPayload = false;
    /** Normalized workout from this turn, persisted to history metadata so the
     *  card re-renders when the conversation is reopened from the sidebar. */
    let workoutForHistory: WorkoutPlan | null = null;
    /** Id of the workout card rendered this stream — replace (not append) on re-emit. */
    let emittedWorkoutCardId: string | null = null;
    /** Set when create_one_off_workout starts; used for minimum build animation and label retention */
    let workoutBuildStartedAt: number | null = null;
    /**
     * Message id that streamed text tokens are written to. Starts as the initial
     * assistant bubble; once a workout card is appended it is re-pointed at a
     * fresh bubble placed BELOW the card so the coach's summary always reads
     * after the card it refers to (never above it). See applyWorkoutToUi.
     */
    let activeTextTargetId = aiChatMessage.id;

    // Stop-generation support: aborting fires through backendClient into
    // xhr.abort(); the backend sees the disconnect and stops the graph run,
    // so a stopped reply costs no further tokens.
    const stopController = new AbortController();
    stopControllerRef.current = stopController;

    /**
     * Shared end-of-turn cleanup. Also guarantees the FSM can never stay
     * stuck in 'streaming' after the turn ends (a pre-refactor bug: an error
     * after text_start left the input disabled forever).
     */
    const finalizeTurn = () => {
      toolExecutionDepth = 0;
      workoutBuildStartedAt = null;
      clearTimeout(minimumDelayTimer);
      if (stopControllerRef.current === stopController) stopControllerRef.current = null;
      setCoachActivityHint(null);
      setThinkingGraphLabel(null); setThinkingStatus(null);
      setIsTyping(false);
      dispatchFSM({ type: 'TEXT_DONE' });
    };

    // Set minimum delay timer
    const minimumDelayTimer = setTimeout(() => {
      minimumDelayElapsed = true;
      if (contentBuffer && firstContentReceived && toolExecutionDepth === 0) {
        // Show buffered content now
        setMessages(prev => prev.map(msg =>
          msg.id === activeTextTargetId
            ? {
              ...msg,
              text: (msg.text || '') + contentBuffer,
              displayedText: (msg.displayedText || '') + contentBuffer,
              isLoading: false
            }
            : msg
        ));
        contentBuffer = '';
      }
    }, 60);

    try {
      // Ensure main plan context before streaming
      const freshContext = await ensureMainPlanContext();

      console.log('Starting streaming AI response with backend client...');

      const historyBase = skipUserEcho ? messages : [...messages, userChatMessage];

      // Use new backend client for streaming
      await backendClient.chatStream(
        {
          message,
          conversationId,
          supportsSuggestions: true,
          conversationHistory: historyBase.slice(-10).map(m => ({
            role: m.isUser ? 'user' : 'assistant',
            content: m.text,
          })),
          context: {
            hasPlan: !!(freshContext || mainPlanContext),
            todaysWorkout: (freshContext || mainPlanContext)?.todaysWorkout,
            weeklySchedule: (freshContext || mainPlanContext)?.weeklySchedule,
          },
        },
        {
          signal: stopController.signal,
          onEvent: (event: StreamEvent) => {
            switch (event.type) {
              case 'intent':
                console.log('Backend detected intent:', event.agent);
                break;

              case 'status':
                // Request-specific thinking line straight from the model (its preamble).
                if (event.state?.trim()) setThinkingStatus(event.state.trim());
                break;

              case 'graph_node':
                setThinkingGraphLabel(messageForGraphNode(event.node));
                break;

              case 'suggestions':
                // Tappable follow-up replies for the coach message that just
                // finished — cleared automatically on the next send.
                setSuggestedReplies(
                  (event.replies ?? []).filter((r) => typeof r === 'string' && r.trim().length > 0).slice(0, 3)
                );
                break;

              case 'tool_start':
                toolExecutionDepth += 1;
                if (event.toolNames?.includes('create_one_off_workout') || event.toolNames?.includes('extend_one_off_workout')) {
                  workoutBuildStartedAt = Date.now();
                  // Suppress any pre-tool filler ("Building a quick workout…") the
                  // moment the build begins — the activity label/orb carries the
                  // build, and the card will lead the sequence. Reset buffers so
                  // the filler can't reappear before the card lands.
                  fullMessageText = '';
                  contentBuffer = '';
                  setMessages(prev => prev.map(msg =>
                    msg.id === activeTextTargetId
                      ? { ...msg, text: '', displayedText: '' }
                      : msg
                  ));
                }
                setCoachActivityHint(event.label);
                // Dynamic tool label ("Building your 35-min legs workout…") becomes
                // the live thinking line, overriding the earlier preamble.
                if (event.label?.trim()) setThinkingStatus(event.label.trim());
                setMessages(prev => prev.map(msg =>
                  msg.id === aiChatMessage.id
                    ? { ...msg, coachActivityLabel: event.label }
                    : msg
                ));
                break;

              case 'tool_done':
                toolExecutionDepth = Math.max(0, toolExecutionDepth - 1);
                {
                  const keepBuildUi = workoutBuildStartedAt != null;
                  if (!keepBuildUi) {
                    setCoachActivityHint(null);
                    setMessages(prev => prev.map(msg =>
                      msg.id === aiChatMessage.id
                        ? { ...msg, coachActivityLabel: undefined }
                        : msg
                    ));
                  }
                }
                streamCoachHaptic('light');
                break;

              case 'tool_error':
                clearTimeout(minimumDelayTimer);
                toolExecutionDepth = 0;
                workoutBuildStartedAt = null;
                setCoachActivityHint(null);
                setThinkingGraphLabel(null); setThinkingStatus(null);
                // Raw tool errors are never shown; the graph returns a normal assistant message.
                setMessages(prev => prev.map(msg =>
                  msg.id === aiChatMessage.id
                    ? { ...msg, isTyping: true, isLoading: true, coachActivityLabel: undefined }
                    : msg
                ));
                break;

              case 'workout_start':
                console.log('Workout generation started');
                break;

              case 'workout':
                // Backend sent validated workout data
                if (event.workoutData) {
                  receivedWorkoutPayload = true;
                  toolExecutionDepth = 0;
                  console.log('Received workout data from backend');
                  clearTimeout(minimumDelayTimer);

                  // NORMALIZE: Ensure workout data matches WorkoutPlan contract
                  const rawWorkout = event.workoutData as any;
                  const exercises_structured = normalizeExercises(rawWorkout) as ExerciseCard[];
                  const normalizedWorkout: WorkoutPlan = {
                    workout_name: rawWorkout.workout_name || rawWorkout.focus || 'Workout',
                    exercises: exercises_structured.map(ex => ex.name),
                    exercises_structured,
                    estimated_time: rawWorkout.estimated_time || rawWorkout.estimatedTime || 0,
                    difficulty: rawWorkout.difficulty || 'intermediate',
                    workout_type: rawWorkout.workout_type || rawWorkout.workoutType,
                    description: rawWorkout.description || rawWorkout.note,
                    note: rawWorkout.note,
                  };
                  workoutForHistory = normalizedWorkout;

                  // DEV ASSERTION: Catch data contract violations immediately
                  if (__DEV__) {
                    if (!normalizedWorkout.exercises_structured?.length) {
                      console.error('WORKOUT DATA CONTRACT VIOLATION: exercises_structured is empty!');
                      console.error('   Raw workout data:', JSON.stringify(rawWorkout, null, 2));
                    }
                    if (!normalizedWorkout.workout_name) {
                      console.error('WORKOUT DATA CONTRACT VIOLATION: workout_name is missing!');
                    }
                  }

                  const startedAt = workoutBuildStartedAt ?? Date.now();
                  const waitMs = Math.max(0, MIN_WORKOUT_BUILD_DISPLAY_MS - (Date.now() - startedAt));

                  const applyWorkoutToUi = () => {
                    workoutBuildStartedAt = null;
                    workoutArrivedHaptic();
                    dispatchFSM({ type: 'WORKOUT_DATA', workoutData: normalizedWorkout });
                    setCoachActivityHint(null);

                    const isChangeRequest = isChangeRequestRef.current;
                    // Snapshot BEFORE reassigning the closure var: the updater runs
                    // at render time, after `emittedWorkoutCardId = …` below, so
                    // reading the live var inside it would always take the replace
                    // branch and never append the card on a fresh build.
                    const hadExistingCard = emittedWorkoutCardId !== null;
                    const workoutCardId = emittedWorkoutCardId ?? `workout-${Date.now()}`;
                    emittedWorkoutCardId = workoutCardId;
                    // Fresh bubble that receives the post-card coach summary.
                    const summaryBubbleId = `summary-${workoutCardId}`;

                    setMessages(prev => {
                      // Idempotent: a re-emit in the same stream (e.g. validation
                      // retry) replaces the existing card rather than appending.
                      if (hadExistingCard) {
                        return prev.map(msg =>
                          msg.id === workoutCardId
                            ? { ...msg, workoutData: normalizedWorkout }
                            : msg
                        );
                      }
                      let base = prev;
                      if (isChangeRequest && currentWorkoutMessageId) {
                        base = prev.filter(msg => msg.id !== currentWorkoutMessageId);
                      }
                      // Discard pre-tool filler ("Building your workout…") — the
                      // thinking orb already said it. Intro bubble collapses to
                      // empty so the card leads: card → summary.
                      const updated = base.map(msg =>
                        msg.id === aiChatMessage.id
                          ? {
                            ...msg,
                            text: '',
                            displayedText: '',
                            isLoading: false,
                            isTyping: false,
                            noBubble: true,
                            messageType: 'text' as const,
                            workoutData: undefined,
                            coachActivityLabel: undefined,
                          }
                          : msg
                      );
                      const workoutCardMessage: ChatMessage = {
                        id: workoutCardId,
                        text: '',
                        isUser: false,
                        timestamp: new Date(),
                        workoutData: normalizedWorkout,
                        messageType: 'workout',
                        noBubble: false,
                        isLoading: false,
                        isTyping: false,
                      };
                      // Empty summary bubble placed AFTER the card; post-card text
                      // routes here (activeTextTargetId) so the summary reads below
                      // the card it refers to.
                      const summaryBubble: ChatMessage = {
                        id: summaryBubbleId,
                        text: '',
                        isUser: false,
                        timestamp: new Date(),
                        displayedText: '',
                        isTyping: true,
                        isLoading: false,
                        noBubble: true,
                        messageType: 'text',
                      };
                      return [...updated, workoutCardMessage, summaryBubble];
                    });

                    // Route post-card text to the summary bubble; reset buffers so
                    // pre-tool filler can't leak into it.
                    if (!hadExistingCard) {
                      activeTextTargetId = summaryBubbleId;
                    }
                    fullMessageText = '';
                    contentBuffer = '';
                    setPendingWorkout(normalizedWorkout);
                    setActiveIntent('edit_workout');
                    setEditingTargetName(normalizedWorkout.workout_name);
                    setIntentContext({ previousWorkout: normalizedWorkout });
                    setCurrentWorkoutMessageId(workoutCardId);
                    isChangeRequestRef.current = false;
                    setIsTyping(false);
                  };

                  if (waitMs > 0) {
                    setTimeout(applyWorkoutToUi, waitMs);
                  } else {
                    applyWorkoutToUi();
                  }
                }
                break;

              case 'text_start':
                dispatchFSM({ type: 'TEXT_START' });
                setThinkingGraphLabel(null); setThinkingStatus(null);
                workoutBuildStartedAt = null;
                setCoachActivityHint(null);
                setMessages(prev => prev.map(msg =>
                  msg.id === aiChatMessage.id ? { ...msg, coachActivityLabel: undefined } : msg
                ));
                if (!firstContentReceived) {
                  firstContentReceived = true;
                }
                break;

              case 'text':
                // Append text chunk
                if (event.content) {
                  fullMessageText += event.content;
                  assistantTranscript += event.content;
                  contentBuffer += event.content;

                  if (minimumDelayElapsed && toolExecutionDepth === 0) {
                    setMessages(prev => prev.map(msg =>
                      msg.id === activeTextTargetId
                        ? {
                          ...msg,
                          text: (msg.text || '') + event.content,
                          displayedText: (msg.displayedText || '') + event.content,
                          isLoading: false,
                          isTyping: true,
                          noBubble: true,
                          messageType: 'text'
                        }
                        : msg
                    ));
                    contentBuffer = '';
                  }
                }
                break;

              case 'text_done':
                dispatchFSM({ type: 'TEXT_DONE' });
                if (contentBuffer && toolExecutionDepth === 0) {
                  setMessages(prev => prev.map(msg =>
                    msg.id === activeTextTargetId
                      ? {
                        ...msg,
                        text: (msg.text || '') + contentBuffer,
                        displayedText: (msg.displayedText || '') + contentBuffer,
                        isLoading: false,
                        isTyping: true,
                        noBubble: true,
                        messageType: 'text'
                      }
                      : msg
                  ));
                  contentBuffer = '';
                }
                break;

              case 'edit_preview': {
                const preview = buildMainPlanEditPreview(event.previewChanges);
                if (preview) {
                  setMainPlanEditPreview(preview);
                  setIsMainPlanEdit(true);
                } else {
                  console.warn('Received edit_preview but could not compute changes');
                }
                break;
              }

              case 'plan':
                console.log('Received plan data from backend');
                break;

              case 'complete':
                streamCoachHaptic('light');
                setMessages(prev => prev.map(msg => {
                  if (msg.id !== activeTextTargetId) {
                    return msg.isLoading || msg.coachActivityLabel
                      ? { ...msg, isLoading: false, coachActivityLabel: undefined }
                      : msg;
                  }
                  const hasText = !!(msg.text?.trim() || msg.displayedText?.trim());
                  // A workout card with empty assistant text is a valid success state.
                  const normalizedEmptyText = receivedWorkoutPayload ? '' : (msg.text ?? '');
                  const normalizedEmptyDisplayedText = receivedWorkoutPayload
                    ? ''
                    : (msg.displayedText ?? msg.text ?? '');
                  return {
                    ...msg,
                    isTyping: false,
                    isLoading: false,
                    noBubble: true,
                    messageType: 'text',
                    coachActivityLabel: undefined,
                    text: hasText ? msg.text : normalizedEmptyText,
                    displayedText: hasText ? (msg.displayedText ?? msg.text) : normalizedEmptyDisplayedText,
                  };
                }));
                isChangeRequestRef.current = false;
                fullMessageText = '';
                finalizeTurn();
                break;

              case 'error':
                console.error('Stream error event:', event.message);
                setMessages(prev => prev.map(msg =>
                  msg.id === activeTextTargetId
                    ? {
                      ...msg,
                      text: event.message || COACH_ERROR_COPY,
                      isTyping: false,
                      isLoading: false,
                      coachActivityLabel: undefined
                    }
                    : msg
                ));
                // "Try again" chip under the failed bubble — the error copy
                // literally tells the user to resend, so give them the button.
                setRetryTarget({ messageId: activeTextTargetId, message });
                finalizeTurn();
                break;
            }
          },
          onError: (error: Error) => {
            console.error('Streaming error:', error);

            const isQuota = isQuotaExceededError(error);
            if (isQuota) setQuotaError(error);

            setMessages(prev => prev.map(msg => {
              if (msg.id === activeTextTargetId) {
                return {
                  ...msg,
                  text: isQuota
                    ? "You've reached your daily AI limit. Upgrade for more usage."
                    : COACH_ERROR_COPY,
                  isTyping: false,
                  isLoading: false,
                  coachActivityLabel: undefined
                };
              }
              return msg.isLoading ? { ...msg, isLoading: false } : msg;
            }));
            if (!isQuota) {
              setRetryTarget({ messageId: activeTextTargetId, message });
            }
            finalizeTurn();
          },
          onComplete: () => {
            console.log('Streaming completed');
            finalizeTurn();

            // Save the coach's reply to history — including the workout card
            // payload, so reopening this conversation re-renders the card
            // (loadConversation reads metadata.workout_data back).
            if (userId && conversationId && (assistantTranscript.trim() || workoutForHistory)) {
              saveMessage(
                userId,
                conversationId,
                'assistant',
                assistantTranscript.trim(),
                workoutForHistory ? { workout_data: workoutForHistory } : undefined
              ).catch(err =>
                console.error('Failed to save assistant message:', err)
              );
            }

            // Clean up any remaining loading messages
            setMessages(prev => prev.map(msg =>
              msg.isLoading ? { ...msg, isLoading: false } : msg
            ));
          },
          onAborted: () => {
            // User tapped stop: keep whatever partial reply arrived, drop an
            // empty placeholder, and close the turn cleanly.
            console.log('Generation stopped by user');
            const partial = assistantTranscript.trim();
            posthog.capture('chat_generation_stopped', {
              had_partial_text: partial.length > 0,
            });
            setMessages(prev => prev
              .filter(msg => !(
                msg.id === activeTextTargetId &&
                !(msg.text?.trim()) &&
                !receivedWorkoutPayload
              ))
              .map(msg => {
                const cleaned = (msg.isLoading || msg.isTyping || msg.coachActivityLabel)
                  ? { ...msg, isLoading: false, isTyping: false, coachActivityLabel: undefined }
                  : msg;
                if (msg.id === activeTextTargetId) {
                  return { ...cleaned, noBubble: true, messageType: 'text' as const };
                }
                return cleaned;
              })
            );
            finalizeTurn();
            if (userId && conversationId && (partial || workoutForHistory)) {
              saveMessage(
                userId,
                conversationId,
                'assistant',
                partial,
                workoutForHistory ? { workout_data: workoutForHistory } : undefined
              ).catch(err =>
                console.error('Failed to save stopped reply:', err)
              );
            }
          },
        }
      );

    } catch (error) {
      console.error('Error in chat:', error);

      // Update the message with error (cold backend gets the "waking up" copy
      // on a conversation's first turn — resending is the fix either way).
      const errorCopy = source === 'initial' ? COACH_WAKING_COPY : COACH_ERROR_COPY;
      setMessages(prev => prev.map(msg =>
        msg.id === aiChatMessage.id
          ? {
            ...msg,
            text: errorCopy,
            isTyping: false,
            isLoading: false,
          }
          : msg
      ));
      if (!isQuotaExceededError(error)) {
        setRetryTarget({ messageId: aiChatMessage.id, message });
      }
      finalizeTurn();
    }
    return true;
  }, [
    isTyping,
    isOffline,
    messages,
    mainPlanContext,
    conversationId,
    ensureMainPlanContext,
    streamCoachHaptic,
    workoutArrivedHaptic,
    quotaTier,
    chatsRemaining,
    router,
    userId,
    currentWorkoutMessageId,
  ]);

  /**
   * Handle sending messages to the AI with streaming. `overrideText` lets
   * suggested-reply chips send directly, bypassing the input box (guarded by
   * typeof because onPress passes a gesture event).
   */
  const sendMessage = useCallback((overrideText?: unknown) => {
    const isChip = typeof overrideText === 'string';
    const sourceText = isChip ? overrideText : inputText;
    void runChatTurn(sourceText, { source: isChip ? 'chip' : 'input' });
  }, [inputText, runChatTurn]);

  /** Stop generation mid-response (■ button). */
  const handleStopGeneration = useCallback(() => {
    coachHaptic('light');
    stopControllerRef.current?.abort();
  }, []);

  /** "Try again" chip under a failed reply — re-runs the same message as a fresh turn. */
  const handleRetry = useCallback(() => {
    if (!retryTarget || isTyping) return;
    coachHaptic('light');
    posthog.capture('chat_retry_tapped');
    const { messageId, message } = retryTarget;
    setRetryTarget(null);
    // Remove the failed assistant bubble, then re-send. The turn gets a fresh
    // clientRequestId (the failed one already consumed its idempotency key).
    setMessages(prev => prev.filter(m => m.id !== messageId));
    void runChatTurn(message, { source: 'retry', skipUserEcho: true });
  }, [retryTarget, isTyping, runChatTurn]);

  /** Regenerate the latest coach reply (long-press action sheet). */
  const handleRegenerate = useCallback((assistantMessageId: string) => {
    if (isTyping) return;
    const idx = messages.findIndex(m => m.id === assistantMessageId);
    if (idx === -1) return;
    let userText: string | null = null;
    for (let i = idx - 1; i >= 0; i--) {
      if (messages[i].isUser) { userText = messages[i].text; break; }
    }
    if (!userText?.trim()) return;
    posthog.capture('chat_regenerate_tapped');
    void runChatTurn(userText, { source: 'retry', skipUserEcho: true });
  }, [messages, isTyping, runChatTurn]);

  /** Long-press on a message bubble → action sheet (copy / edit / regenerate / feedback). */
  const handleMessageLongPress = useCallback((message: ChatMessage) => {
    if (!message.text?.trim()) return;
    coachHaptic('light');
    setActionTarget(message);
  }, []);

  const handleCopyMessage = useCallback(async (message: ChatMessage) => {
    try {
      await Clipboard.setStringAsync(message.text);
      coachHaptic('light');
      posthog.capture('chat_message_copied', { is_user: message.isUser });
      toast.success('Copied');
    } catch (e) {
      console.warn('Copy failed:', e);
      toast.error('Could not copy');
    } finally {
      setActionTarget(null);
    }
  }, []);

  /** "Edit & resend": prefill the input with the original text and focus. */
  const handleEditResend = useCallback((message: ChatMessage) => {
    setActionTarget(null);
    setInputText(message.text);
    posthog.capture('chat_edit_resend_tapped');
    requestAnimationFrame(() => textInputRef.current?.focus());
  }, []);

  const handleSheetFeedback = useCallback((message: ChatMessage, helpful: boolean) => {
    coachHaptic('light');
    posthog.capture('coach_reply_feedback', {
      helpful,
      message_id: message.id,
      conversation_id: conversationId,
      message_length: (message.text ?? '').length,
      source: 'action_sheet',
    });
    setActionTarget(null);
    toast.success('Thanks for the feedback');
  }, [conversationId]);

  /**
   * Confirm and start the AI-generated workout
   * This navigates to the workout screen with the exercise list
   */
  /**
   * Explicitly save the previewed workout to the user's library WITHOUT starting
   * it. Backed by the dedicated "Save to Library" button so saving is a clear,
   * first-class action (previously saving only happened as a side effect of
   * "Start Workout").
   */
  const [savedToLibrary, setSavedToLibrary] = useState(false);
  const handleSaveToLibrary = useCallback(async () => {
    if (!pendingWorkout || savedToLibrary) return;
    try {
      const savedWorkout: SavedWorkout = {
        id: `workout_${Date.now()}`,
        workoutName: pendingWorkout.workout_name,
        exercises: pendingWorkout.exercises,
        estimatedTime: roundToNearest5Minutes(pendingWorkout.estimated_time),
        difficulty: pendingWorkout.difficulty,
        description: pendingWorkout.description,
        createdAt: new Date(),
        workoutType: normalizeWorkoutTypeForSavedWorkouts(
          pendingWorkout.workout_type || 'extra_workout'
        ),
        note: pendingWorkout.note,
      };
      const saveResult = await saveWorkout(savedWorkout);
      if (!saveResult.success && saveResult.error === ERR_SAVED_WORKOUTS_LIMIT) {
        proGate.showPaywall('saved_workouts_limit');
        return;
      }
      if (saveResult.success) {
        coachHaptic('light');
        setSavedToLibrary(true);
        posthog.capture('workout_saved', {
          workout_name: savedWorkout.workoutName,
          exercise_count: savedWorkout.exercises?.length ?? 0,
          source: 'explicit_save_button',
        });
        toast.success('Saved to library', `"${savedWorkout.workoutName}" is in your library.`);
      } else {
        toast.error('Could not save', 'Please try again.');
      }
    } catch (e) {
      console.error('Save to library failed:', e);
      toast.error('Could not save', 'Please try again.');
    }
  }, [pendingWorkout, savedToLibrary, proGate]);

  // `workoutOverride` lets the persistent workout bar start its workout
  // directly (state setters are async, so it can't rely on pendingWorkout).
  const confirmWorkout = useCallback(async (workoutOverride?: WorkoutPlan) => {
    const workout = workoutOverride ?? pendingWorkout;
    if (workout) {
      console.log('Confirming workout:', workout.workout_name);
      // Close the preview now so returning from the workout lands on the chat.
      setShowWorkoutPreview(false);

      try {
        // Check if this is a replacement workout
        const isReplacementWorkout = workout.workout_type === 'replacement_workout';

        if (isReplacementWorkout) {
          // Save replacement workout to Supabase (not AsyncStorage)
          console.log('Saving replacement workout to Supabase');

          const session = await getSession();
          if (!session) {
            throw new Error('No active session');
          }

          const { error } = await supabase.from('saved_workouts').insert({
            user_id: session.user.id,
            workout_name: workout.workout_name,
            workout_type: 'replacement_workout',
            // Local calendar day (matches WorkoutService.resolveToday's local
            // read). UTC here put the replacement on the wrong day for users
            // off UTC.
            replacement_date: getLocalDateString(),
            exercises: workout.exercises,
            exercises_structured: normalizeExercises(workout) as unknown as Json,
            estimated_time: workout.estimated_time,
            difficulty: workout.difficulty,
            description: workout.description,
            note: workout.note || `Replacement workout for ${new Date().toLocaleDateString()}`,
          });

          if (error) {
            console.error('Error saving replacement workout:', error);
            throw error;
          }

          console.log('Replacement workout saved to Supabase - will appear in Today\'s Workout on home screen');
        } else {
          // Regular workout - save to saved workouts
          const savedWorkout: SavedWorkout = {
            id: `workout_${Date.now()}`, // String ID will be replaced with UUID by Supabase
            workoutName: workout.workout_name,
            exercises: workout.exercises,
            estimatedTime: roundToNearest5Minutes(workout.estimated_time),
            difficulty: workout.difficulty,
            description: workout.description,
            createdAt: new Date(),
            workoutType: normalizeWorkoutTypeForSavedWorkouts(
              workout.workout_type || 'extra_workout'
            ),
            note: workout.note,
          };

          console.log('Saving workout to Supabase:', savedWorkout.workoutName);
          const saveResult = await saveWorkout(savedWorkout);
          if (!saveResult.success && saveResult.error === ERR_SAVED_WORKOUTS_LIMIT) {
            // Free user hit the 3-workout cap. Show the specific-feature
            // upgrade sheet; continue with navigation so the workout still
            // starts — they just don't get a saved-library copy.
            proGate.showPaywall('saved_workouts_limit');
          } else if (saveResult.success) {
            posthog.capture('workout_saved', {
              workout_name: savedWorkout.workoutName,
              exercise_count: savedWorkout.exercises?.length ?? 0,
            });
            console.log('Workout saved to Supabase successfully');
          }
        }

        // The FSM returns to 'idle' here — the chat stays alive for
        // follow-up questions and edits (duplicate builds are guarded
        // server-side, not by locking the user out).
        dispatchFSM({ type: 'WORKOUT_CONFIRMED' });
      } catch (error) {
        console.error('Error saving workout:', error);
        // Continue with navigation even if save fails
      }

      // Set navigation flag before navigating
      hasNavigatedRef.current = true;

      // Get the structured exercises (primary source) and derive exercise names
      const structuredExercises = normalizeExercises(workout);
      const exerciseNames = structuredExercises.length > 0
        ? structuredExercises.map((ex) => ex.name)
        : workout.exercises;

      // Navigate to workout screen with exercise data
      router.push({
        pathname: '/workout',
        params: {
          exercises: JSON.stringify(exerciseNames),
          exerciseStructure: JSON.stringify(structuredExercises),
          exerciseNames: JSON.stringify(exerciseNames),
          workoutName: workout.workout_name,
          estimatedTime: workout.estimated_time.toString(),
          difficulty: workout.difficulty,
          workoutType: normalizeWorkoutTypeForSavedWorkouts(
            workout.workout_type || 'extra_workout'
          ),
        }
      });
    }
  }, [pendingWorkout, router, activeIntent]);

  /**
   * Reject the proposed workout and ask for changes
   */
  const rejectWorkout = useCallback(() => {
    console.log('User rejected workout');
    setPendingWorkout(null);
    // Do not auto-send assistant messages; allow user to type next
    setActiveIntent('edit_workout');
    if (intentContext?.previousWorkout) {
      setEditingTargetName(intentContext.previousWorkout.workout_name);
    }
  }, []);

  /**
   * Confirm main plan edit
   */
  const confirmMainPlanEdit = useCallback(async () => {
    if (!mainPlanEditPreview) return;

    try {
      console.log('Confirming main plan edit');

      // Hide the confirmation overlay immediately
      setIsMainPlanEdit(false);

      // Store affected days before clearing preview
      const affectedDays: string[] = Array.isArray(mainPlanEditPreview.changesByDay)
        ? mainPlanEditPreview.changesByDay.map((d: any) => d?.dayOfWeek).filter((d: any) => typeof d === 'string')
        : [mainPlanEditPreview.dayOfWeek].filter((d: any) => typeof d === 'string');

      const session = await getSession();
      if (!session) return;

      // Use backendClient to confirm edit
      try {
        console.log('Calling backendClient.confirmEdit...');

        const updatedDaysPayload = Array.isArray(mainPlanEditPreview.updatedDays)
          ? mainPlanEditPreview.updatedDays.flatMap((day: any) => {
            const id = typeof day?.id === 'string' ? day.id : null;
            // Use normalizer to extract exercises_structured
            const exercisesStructured = normalizeExercises(day);

            if (!id || !exercisesStructured.length) return [];
            return [{ id, exercises_structured: exercisesStructured }];
          })
          : [];

        if (!updatedDaysPayload.length) {
          throw new Error('No valid updatedDays payload to confirm');
        }

        const result = await backendClient.confirmEdit({
          updatedDays: updatedDaysPayload,
        });

        console.log('Main plan update result:', result);

        if (result.success) {
          console.log('Database updated via backend.');

          // Clear preview state immediately to prevent re-renders
          setMainPlanEditPreview(null);

          // Add a simple success message without typing animation
          const dayLabel =
            affectedDays.length === 1
              ? affectedDays[0]
              : affectedDays.length > 1
                ? `${affectedDays.length} days`
                : 'your plan';

          const successMessage: ChatMessage = {
            id: Math.round(Math.random() * 1000000).toString(),
            text: `Perfect! I've updated your main plan for ${dayLabel}. The changes have been applied and your workout plan is now updated! 💪`,
            isUser: false,
            timestamp: new Date(),
            isTyping: false,
            noBubble: true,
          };

          setMessages(prev => [...prev, successMessage]);
          // The conversation stays put — thread state is checkpointed
          // server-side, and wiping the chat right after a successful edit
          // read as "I did the thing and my chat vanished."
        } else {
          // Clear preview on error too
          setMainPlanEditPreview(null);

          const errorMessage: ChatMessage = {
            id: Math.round(Math.random() * 1000000).toString(),
            text: "I hit a snag on my side updating your main plan — nothing was changed. Send that again and I'll retry it.",
            isUser: false,
            timestamp: new Date(),
            isTyping: false,
          };

          setMessages(prev => [...prev, errorMessage]);
        }
      } catch (error) {
        console.error('Error confirming main plan edit:', error);
        // Clear states on error
        setMainPlanEditPreview(null);
        setIsMainPlanEdit(false);
      }
    } catch (error) {
      console.error('Error in confirmMainPlanEdit:', error);
      // Clear states on error
      setMainPlanEditPreview(null);
      setIsMainPlanEdit(false);
    }
  }, [mainPlanEditPreview]);

  // Auto-confirm main plan edit when user sends "Yes" and there's a pending preview
  // Also upgrade intent from create_workout to main_plan_edit when preview is detected
  useEffect(() => {
    // Upgrade intent if we have a preview but wrong intent
    if (mainPlanEditPreview && activeIntent !== 'main_plan_edit') {
      console.log('Auto-upgrading intent to main_plan_edit based on detected preview');
      setActiveIntent('main_plan_edit');
    }

    // Check if the last user message was a confirmation
    const lastUserMessage = messages.filter(m => m.isUser).pop();
    if (lastUserMessage && mainPlanEditPreview && !isTyping) {
      const text = lastUserMessage.text.toLowerCase().trim();
      const isConfirmation = text === 'yes' || text === 'yes.' || text === 'yes add both' ||
        text.includes('proceed') || text.includes('confirm') || text === 'go ahead' || text === 'do it';

      if (isConfirmation) {
        console.log('Auto-confirming main plan edit based on user confirmation message');
        confirmMainPlanEdit();
      }
    }
  }, [messages, mainPlanEditPreview, activeIntent, isTyping, confirmMainPlanEdit]);

  /**
   * Reject main plan edit
   */
  const rejectMainPlanEdit = useCallback(() => {
    console.log('User rejected main plan edit');

    const rejectionMessage: ChatMessage = {
      id: Math.round(Math.random() * 1000000).toString(),
      text: "No problem! What would you like to change about your main plan? I can help you modify specific exercises, adjust the split, or make other changes.",
      isUser: false,
      timestamp: new Date(),
      displayedText: '',
      isTyping: true,
    };

    setMessages(prev => [...prev, rejectionMessage]);
    typeMessage(rejectionMessage.id, rejectionMessage.text);

    // Clear states
    setMainPlanEditPreview(null);
    setIsMainPlanEdit(false);
  }, []);

  // Typing animation function
  const typeMessage = useCallback((messageId: string, fullText: string) => {
    setTypingMessageId(messageId);
    let currentIndex = 0;

    const typeInterval = setInterval(() => {
      if (currentIndex <= fullText.length) {
        const displayedText = fullText.substring(0, currentIndex);

        setMessages(prev => prev.map(msg =>
          msg.id === messageId
            ? { ...msg, displayedText, isTyping: currentIndex < fullText.length }
            : msg
        ));

        currentIndex++;
      } else {
        clearInterval(typeInterval);
        setTypingMessageId(null);

        // Mark message as no longer typing
        setMessages(prev => prev.map(msg =>
          msg.id === messageId
            ? { ...msg, isTyping: false }
            : msg
        ));
      }
    }, 30); // 30ms per character for fast typing
  }, []);

  /**
   * Remove an exercise from the previewed workout (swipe-to-delete). Rebuilds
   * both the structured list and the names array so downstream stays in sync.
   */
  const handleRemoveExercise = useCallback((exerciseId: string | undefined, index: number) => {
    setPendingWorkout(prev => {
      if (!prev) return prev;
      const list = getExercises(prev);
      // Keep at least one exercise — a 0-exercise workout isn't usable.
      if (list.length <= 1) {
        coachHaptic('warning');
        return prev;
      }
      coachHaptic('light');
      const next = list.filter((ex, i) => (exerciseId ? ex.id !== exerciseId : i !== index));
      return {
        ...prev,
        exercises_structured: next,
        exercises: next.map(e => e.name),
      };
    });
  }, []);

  /**
   * Newest-first copy of the thread for the INVERTED FlatList: only visible
   * rows mount (a 100-message thread no longer mounts 100 components), and
   * the inverted anchor keeps the newest message pinned during streaming
   * without manual scroll calls.
   */
  const reversedMessages = useMemo(() => [...messages].reverse(), [messages]);

  /**
   * The latest fully-delivered coach text message — the one that carries the
   * thumbs up/down feedback row. Walking backwards stops at the first user
   * message, so the row disappears as soon as the user replies.
   */
  const latestCoachTextId = useMemo(() => {
    for (let i = messages.length - 1; i >= 0; i--) {
      const m = messages[i];
      if (m.isUser) return null;
      if (m.isTyping || m.isLoading) return null;
      if (m.messageType !== 'workout' && (m.text ?? '').trim().length > 0) return m.id;
    }
    return null;
  }, [messages]);

  /**
   * Stable open-preview callback passed into the module-scope message
   * renderer. Must stay referentially stable (empty deps) so MemoizedMessage's
   * memo comparison holds across keystrokes.
   */
  const handleOpenWorkout = useCallback((workout: WorkoutPlan) => {
    setPendingWorkout(workout);
    setSavedToLibrary(false);
    setShowWorkoutPreview(true);
  }, []);

  /**
   * Handle text input submit
   */
  const handleSubmit = () => {
    sendMessage();
  };


  return (
    <>
      {/* Explicit background: the keyboard-avoidance padding strip sits BEHIND
          the iOS keyboard (which is slightly translucent, and doesn't paint the
          device's rounded corners) — without a background it exposes the white
          window root at the keyboard's corners. */}
      <KeyboardAvoidingView
        style={[styles.container, { backgroundColor: colors.background }]}
        behavior={Platform.OS === 'ios' ? 'padding' : undefined}
        keyboardVerticalOffset={0}
      >
        {/* Main Chat Content */}
        <View style={[styles.container, { backgroundColor: colors.background }]}>
          {/* Navbar */}
          <View style={[styles.navbar, { backgroundColor: colors.background }]}>
            <View style={styles.navbarContent}>
              {/* Chat History Button */}
              <GlassIconButton
                icon="time-outline"
                size={40}
                iconSize={22}
                onPress={() => {
                  coachHaptic('light');
                  posthog.capture('chat_history_opened');
                  setShowHistorySidebar(true);
                }}
                accessibilityLabel="Open chat history"
              />
              {/* Lift AI logo */}
              <Image
                source={isDark ? require('../../img/Logo/White-Logo.png') : require('../../img/Logo/Black-Logo.png')}
                style={styles.navbarLogo}
                contentFit="contain"
              />
              {/* New Chat Button */}
              <GlassIconButton
                icon="add"
                size={40}
                iconSize={24}
                onPress={() => void requestNewChat()}
                accessibilityLabel="Start a new chat"
              />
            </View>
          </View>

          {/* NOTE: the workout preview intentionally has ONE surface — the
              inline ChatWorkoutCard in the message stream (tap → preview modal
              with Start). A floating pinned bar used to duplicate it here and
              overlapped the messages; removed 2026-07-19. */}

          {/* One-time orientation hint (first visit only) */}
          <FirstVisitHint
            hintKey="chat"
            text="This is your coach. Ask anything — swap exercises, adjust your plan, get form advice."
          />

          {/* Chat Messages or Empty State */}
          {messages.length === 0 ? (
            <View style={[styles.emptyStateContainer, { backgroundColor: colors.background }]}>
              <Text style={[styles.emptyStateTitle, { color: colors.textMuted }]}>
                Hi {greetingName || 'there'},
              </Text>
              <Text style={[styles.emptyStateSubtitle, { color: colors.text }]}>
                How can I help
              </Text>
              <Text style={[styles.emptyStateSubtitle, { color: colors.text }]}>
                you today?
              </Text>
            </View>
          ) : (
            <View style={styles.messagesWrap}>
              <FlatList
                ref={listRef}
                data={reversedMessages}
                keyExtractor={(item) => item.id}
                inverted
                style={[styles.messagesContainer, { backgroundColor: colors.background }]}
                // Inverted list: content y=0 is the VISUAL BOTTOM, so the
                // bottom clearance is paddingTop and the navbar/workout-bar
                // clearance is paddingBottom.
                contentContainerStyle={[
                  styles.messagesContentInverted,
                  { paddingTop: 24 + insets.bottom + TAB_BAR_CLEARANCE },
                  { paddingBottom: Platform.OS === 'ios' ? 110 : 90 },
                ]}
                showsVerticalScrollIndicator={false}
                keyboardShouldPersistTaps="handled"
                keyboardDismissMode="interactive"
                onScroll={handleMessagesScroll}
                scrollEventThrottle={32}
                initialNumToRender={16}
                maxToRenderPerBatch={12}
                windowSize={9}
                // Visual bottom of the inverted list — the typing indicator
                // sits under the newest message.
                ListHeaderComponent={
                  isTyping && !messages.some(msg => msg.isTyping || msg.isLoading) ? (
                    <View style={[styles.typingContainer, { backgroundColor: colors.backgroundSecondary }]}>
                      {renderStreamingThinking(coachActivityHint)}
                    </View>
                  ) : null
                }
                renderItem={({ item }) => (
                  <>
                    <MemoizedMessage
                      message={item}
                      streamingGraphLabel={thinkingGraphLabel}
                      streamingStatus={thinkingStatus}
                      isDark={isDark}
                      isTypingTarget={typingMessageId === item.id}
                      showFeedback={item.id === latestCoachTextId}
                      conversationId={conversationId}
                      onOpenWorkout={handleOpenWorkout}
                      onLongPress={handleMessageLongPress}
                    />
                    {/* "Try again" under the failed reply (the error copy says
                        "send it again" — this is the button that does it). */}
                    {retryTarget?.messageId === item.id && !isTyping && (
                      <TouchableOpacity
                        style={[
                          styles.retryChip,
                          { borderColor: colors.border, backgroundColor: colors.backgroundSecondary },
                        ]}
                        onPress={handleRetry}
                        activeOpacity={0.85}
                        accessibilityRole="button"
                        accessibilityLabel="Try sending your message again"
                      >
                        <Ionicons name="refresh" size={14} color={colors.primary} />
                        <Text style={[styles.retryChipText, { color: colors.text }]}>Try again</Text>
                      </TouchableOpacity>
                    )}
                  </>
                )}
              />

              {/* Jump-to-latest pill: appears when the user has scrolled up. */}
              {showJumpToLatest && (
                <TouchableOpacity
                  style={[
                    styles.jumpToLatest,
                    { backgroundColor: colors.backgroundSecondary, borderColor: colors.border },
                  ]}
                  onPress={handleJumpToLatest}
                  activeOpacity={0.85}
                  accessibilityRole="button"
                  accessibilityLabel="Jump to latest message"
                >
                  <Ionicons name="arrow-down" size={18} color={colors.primary} />
                </TouchableOpacity>
              )}
            </View>
          )}

          {/* Ad banner only on the empty state — mid-conversation the chat is
              an effort/conversion surface, and the banner was squeezing an
              already-small message viewport. */}
          {messages.length === 0 && !keyboardVisible && <AdBanner />}

          {/* Input Area */}
          <View
            style={[
              styles.inputContainer,
              {
                backgroundColor: colors.background,
                paddingBottom: keyboardVisible ? 16 : 16 + insets.bottom + TAB_BAR_CLEARANCE,
              },
            ]}
          >
            {messages.length === 0 && (
              <ChatFeatureDiscoveryChips
                colors={colors}
                isDark={isDark}
                onSelectPrompt={(prompt) => {
                  coachHaptic('light');
                  // Insert the stub and focus so the user finishes the thought
                  // (chips are fill-in-the-blank, never auto-send).
                  setInputText(prompt);
                  requestAnimationFrame(() => textInputRef.current?.focus());
                }}
                extraChips={personalizedChips
                  .filter(
                    (s) => s.label?.trim().length > 0 && s.prompt?.trim().length > 0
                  )
                  .map((s) => ({
                    id: s.id,
                    label: s.label.trim(),
                    prompt: s.prompt.trim(),
                  }))}
              />
            )}
            {/* Suggested follow-up replies (SSE `suggestions`) — tap to send. */}
            {suggestedReplies.length > 0 && !isTyping && !isInputDisabled(chatFSM) && messages.length > 0 && (
              <View style={styles.suggestionRow}>
                {suggestedReplies.map((reply) => (
                  <TouchableOpacity
                    key={reply}
                    style={[
                      styles.suggestionChip,
                      {
                        borderColor: colors.border,
                        backgroundColor: colors.backgroundSecondary,
                      },
                    ]}
                    onPress={() => {
                      coachHaptic('light');
                      posthog.capture('chat_suggested_reply_tapped', { reply_length: reply.length });
                      sendMessage(reply);
                    }}
                    activeOpacity={0.85}
                    accessibilityRole="button"
                    accessibilityLabel={`Send: ${reply}`}
                  >
                    <Text style={[styles.suggestionChipText, { color: colors.text }]} numberOfLines={1}>
                      {reply}
                    </Text>
                  </TouchableOpacity>
                ))}
              </View>
            )}
            {/* (Intent pill removed — the coach's replies and the persistent
                workout bar already communicate what edits apply to; the
                system-language pill was redundant noise.) */}
            {/* Compact free-tier allowance chip — replaces the full-width
                QuotaPill so the bottom stack stays short. Tap → paywall. */}
            {quotaTier === 'ad_supported' && chatsRemaining != null && (
              <View style={styles.quotaChipRow}>
                <TouchableOpacity
                  style={[
                    styles.quotaChip,
                    { backgroundColor: colors.backgroundSecondary, borderColor: colors.border },
                  ]}
                  onPress={() => proGate.showPaywall('chat')}
                  activeOpacity={0.85}
                  accessibilityRole="button"
                  accessibilityLabel={`${chatsRemaining} coach messages left today. Upgrade for unlimited.`}
                >
                  <Ionicons
                    name="chatbubble-ellipses-outline"
                    size={12}
                    color={chatsRemaining === 0 ? '#EF4444' : colors.textSecondary}
                  />
                  <Text
                    style={[
                      styles.quotaChipText,
                      { color: chatsRemaining === 0 ? '#EF4444' : colors.textSecondary },
                    ]}
                  >
                    {chatsRemaining} left today
                  </Text>
                  <Text style={[styles.quotaChipUpgrade, { color: colors.primary }]}>Get more</Text>
                </TouchableOpacity>
              </View>
            )}
            {/* Offline pill — quiet, factual, no error bubble burned. */}
            {isOffline && (
              <View
                style={[
                  styles.offlinePill,
                  { backgroundColor: colors.backgroundSecondary, borderColor: colors.border },
                ]}
              >
                <Ionicons name="cloud-offline-outline" size={14} color={colors.textSecondary} />
                <Text style={[styles.offlinePillText, { color: colors.textSecondary }]}>
                  You&apos;re offline — reconnect to message your coach.
                </Text>
              </View>
            )}
            {/* (The old "Workout created! Start a new chat" lock banner is
                gone — the chat stays alive after a workout is created, and
                the persistent workout bar carries the Start CTA instead.) */}
            {/* Quiet character counter — invisible until near the cap, so the
                limit never feels like a surprise wall. */}
            {inputText.length >= 850 && (
              <Text
                style={[
                  styles.charCounter,
                  { color: inputText.length >= 1000 ? '#EF4444' : colors.textSecondary },
                ]}
              >
                {inputText.length}/1000
              </Text>
            )}
            {/* Native Liquid Glass shell on iOS 26+ (system draws the surface
                and edge); solid translucent fallback elsewhere. The AI dots,
                input, and send button all live inside the same box. */}
            <InputShell
              style={[
                styles.textInputWrapper,
                !HAS_NATIVE_GLASS && { backgroundColor: colors.backgroundSecondary },
              ]}
              {...(HAS_NATIVE_GLASS
                ? {
                    glassEffectStyle: 'regular' as const,
                    colorScheme: isDark ? ('dark' as const) : ('light' as const),
                    isInteractive: true,
                  }
                : null)}
            >
              <Animated.View style={[styles.aiIconContainer, { perspective: '1000px' }]}>
                <Animated.View style={[styles.particleGroup, rotateStyle]}>
                  {/* Dot 1 - Purple to Pink */}
                  <Animated.View style={[styles.particleDot, styles.dot1Position, dot1Style]}>
                    <LinearGradient
                      colors={['#5AA6FF', '#2E90FA']}
                      style={styles.dotGradient}
                    />
                  </Animated.View>

                  {/* Dot 2 - Blue to Purple */}
                  <Animated.View style={[styles.particleDot, styles.dot2Position, dot2Style]}>
                    <LinearGradient
                      colors={['#1A6FE0', '#5AA6FF']}
                      style={styles.dotGradient}
                    />
                  </Animated.View>

                  {/* Dot 3 - Pink to Blue */}
                  <Animated.View style={[styles.particleDot, styles.dot3Position, dot3Style]}>
                    <LinearGradient
                      colors={['#2E90FA', '#1A6FE0']}
                      style={styles.dotGradient}
                    />
                  </Animated.View>
                </Animated.View>
              </Animated.View>
              <TextInput
                ref={textInputRef}
                style={[styles.textInput, { color: colors.text }]}
                value={inputText}
                onChangeText={setInputText}
                placeholder={getInputPlaceholder(chatFSM, coachActivityHint)}
                placeholderTextColor={colors.textMuted}
                multiline
                maxLength={1000}
                onSubmitEditing={handleSubmit}
                returnKeyType="send"
                blurOnSubmit={false}
                // Always editable — the user can compose their next message
                // while the coach streams (send stays gated; the button is a
                // stop control during streaming). Stop → edit → send.
                editable
              />
              {/* Send button swaps to a stop (■) button while the coach is
                  responding — stopping aborts the stream and the backend
                  halts the graph run (no orphaned token spend). */}
              {isTyping ? (
                <TouchableOpacity
                  style={[styles.sendButton, { backgroundColor: 'transparent' }]}
                  onPress={handleStopGeneration}
                  accessibilityRole="button"
                  accessibilityLabel="Stop generating"
                >
                  <Ionicons name="stop-circle" size={26} color={colors.primary} />
                </TouchableOpacity>
              ) : (
                <Animated.View style={{ opacity: sendButtonOpacity, pointerEvents: (!inputText.trim() || isTyping || isOffline || isInputDisabled(chatFSM)) ? 'none' : 'auto' }}>
                  <TouchableOpacity
                    style={[
                      styles.sendButton,
                      { backgroundColor: 'transparent' }
                    ]}
                    onPress={sendMessage}
                    disabled={!inputText.trim() || isTyping || isOffline || isInputDisabled(chatFSM)}
                  >
                    <Ionicons name="arrow-up" size={24} color={colors.primary} />
                  </TouchableOpacity>
                </Animated.View>
              )}
            </InputShell>
          </View>
        </View>
      </KeyboardAvoidingView>

      <QuotaLimitSheet error={quotaError} onClose={() => setQuotaError(null)} feature="chat" />

      {/* Message action sheet (long-press): copy / edit & resend / regenerate / feedback */}
      <Modal
        visible={actionTarget !== null}
        transparent
        animationType="fade"
        onRequestClose={() => setActionTarget(null)}
      >
        <Pressable style={styles.actionSheetOverlay} onPress={() => setActionTarget(null)}>
          <Pressable
            style={[
              styles.actionSheet,
              {
                backgroundColor: colors.backgroundSecondary,
                borderColor: colors.border,
                paddingBottom: 12 + insets.bottom,
              },
            ]}
            onPress={() => { /* swallow taps inside the sheet */ }}
          >
            {actionTarget && (
              <>
                <Text
                  style={[styles.actionSheetPreview, { color: colors.textSecondary }]}
                  numberOfLines={2}
                >
                  {actionTarget.text}
                </Text>

                <TouchableOpacity
                  style={styles.actionSheetRow}
                  onPress={() => void handleCopyMessage(actionTarget)}
                  accessibilityRole="button"
                  accessibilityLabel="Copy message text"
                >
                  <Ionicons name="copy-outline" size={20} color={colors.text} />
                  <Text style={[styles.actionSheetRowText, { color: colors.text }]}>Copy text</Text>
                </TouchableOpacity>

                {actionTarget.isUser && (
                  <TouchableOpacity
                    style={styles.actionSheetRow}
                    onPress={() => handleEditResend(actionTarget)}
                    accessibilityRole="button"
                    accessibilityLabel="Edit and resend this message"
                  >
                    <Ionicons name="create-outline" size={20} color={colors.text} />
                    <Text style={[styles.actionSheetRowText, { color: colors.text }]}>
                      Edit &amp; resend
                    </Text>
                  </TouchableOpacity>
                )}

                {!actionTarget.isUser && actionTarget.id === latestCoachTextId && !isTyping && (
                  <TouchableOpacity
                    style={styles.actionSheetRow}
                    onPress={() => {
                      const id = actionTarget.id;
                      setActionTarget(null);
                      handleRegenerate(id);
                    }}
                    accessibilityRole="button"
                    accessibilityLabel="Regenerate this response"
                  >
                    <Ionicons name="refresh-outline" size={20} color={colors.text} />
                    <Text style={[styles.actionSheetRowText, { color: colors.text }]}>
                      Regenerate response
                    </Text>
                  </TouchableOpacity>
                )}

                {!actionTarget.isUser && (
                  <View style={styles.actionSheetFeedbackRow}>
                    <TouchableOpacity
                      style={[styles.actionSheetFeedbackBtn, { borderColor: colors.border }]}
                      onPress={() => handleSheetFeedback(actionTarget, true)}
                      accessibilityRole="button"
                      accessibilityLabel="This reply was helpful"
                    >
                      <Ionicons name="thumbs-up-outline" size={18} color={colors.text} />
                      <Text style={[styles.actionSheetFeedbackText, { color: colors.text }]}>Helpful</Text>
                    </TouchableOpacity>
                    <TouchableOpacity
                      style={[styles.actionSheetFeedbackBtn, { borderColor: colors.border }]}
                      onPress={() => handleSheetFeedback(actionTarget, false)}
                      accessibilityRole="button"
                      accessibilityLabel="This reply wasn't helpful"
                    >
                      <Ionicons name="thumbs-down-outline" size={18} color={colors.text} />
                      <Text style={[styles.actionSheetFeedbackText, { color: colors.text }]}>Not helpful</Text>
                    </TouchableOpacity>
                  </View>
                )}

                <TouchableOpacity
                  style={[styles.actionSheetCancel, { backgroundColor: colors.backgroundTertiary }]}
                  onPress={() => setActionTarget(null)}
                  accessibilityRole="button"
                  accessibilityLabel="Close"
                >
                  <Text style={[styles.actionSheetCancelText, { color: colors.text }]}>Cancel</Text>
                </TouchableOpacity>
              </>
            )}
          </Pressable>
        </Pressable>
      </Modal>

      {/* Modals and Overlays */}

      {/* Main Plan Edit Confirmation Overlay */}
      {isMainPlanEdit && mainPlanEditPreview && (
        <View style={styles.workoutConfirmation}>
          <Text style={styles.confirmationTitle}>Confirm Main Plan Changes</Text>
          <Text style={styles.confirmationSubtitle}>
            {mainPlanEditPreview.dayOfWeek.charAt(0).toUpperCase() + mainPlanEditPreview.dayOfWeek.slice(1)} • {mainPlanEditPreview.splitName}
          </Text>

          <View style={styles.exercisePreview}>
            <Text style={styles.changesSectionTitle}>Changes Summary:</Text>

            {/* Added exercises in green */}
            {mainPlanEditPreview.changes.added.length > 0 && (
              <View style={styles.changesSection}>
                <View style={styles.changeIndicator}>
                  <Ionicons name="add-circle" size={18} color="#2E90FA" />
                  <Text style={styles.changesSectionLabel}>Adding:</Text>
                </View>
                {mainPlanEditPreview.changes.added.map((exercise: string, index: number) => (
                  <Text key={`add-${index}`} style={[styles.exerciseChangeItem, styles.addedExercise]}>
                    + {exercise}
                  </Text>
                ))}
              </View>
            )}

            {/* Removed exercises in red */}
            {mainPlanEditPreview.changes.removed.length > 0 && (
              <View style={styles.changesSection}>
                <View style={styles.changeIndicator}>
                  <Ionicons name="remove-circle" size={18} color="#ef4444" />
                  <Text style={styles.changesSectionLabel}>Removing:</Text>
                </View>
                {mainPlanEditPreview.changes.removed.map((exercise: string, index: number) => (
                  <Text key={`remove-${index}`} style={[styles.exerciseChangeItem, styles.removedExercise]}>
                    - {exercise}
                  </Text>
                ))}
              </View>
            )}

            {/* No changes message */}
            {mainPlanEditPreview.changes.added.length === 0 && mainPlanEditPreview.changes.removed.length === 0 && (
              <Text style={styles.noChangesText}>No exercises being added or removed</Text>
            )}
          </View>

          <View style={styles.confirmationButtons}>
            <TouchableOpacity
              style={[styles.confirmButton, styles.acceptButton]}
              onPress={confirmMainPlanEdit}
            >
              <Ionicons name="checkmark-circle" size={20} color="#fff" />
              <Text style={styles.buttonText}>Apply Changes</Text>
            </TouchableOpacity>
            <TouchableOpacity
              style={[styles.confirmButton, styles.rejectButton]}
              onPress={rejectMainPlanEdit}
            >
              <Ionicons name="close-circle" size={20} color="#fff" />
              <Text style={styles.buttonText}>Cancel</Text>
            </TouchableOpacity>
          </View>
        </View>
      )}

      {/* Workout Preview Modal */}
      {showWorkoutPreview && pendingWorkout && (
        <View style={[styles.workoutPreviewModal, { backgroundColor: isDark ? '#000000' : '#FFFFFF' }]}>
          <View style={styles.workoutPreviewContent}>
            {/* Header */}
            <View style={styles.workoutPreviewHeader}>
              <GlassIconButton
                icon="close"
                size={40}
                iconSize={22}
                onPress={() => setShowWorkoutPreview(false)}
                accessibilityLabel="Close workout preview"
                style={styles.closeButton}
              />
              <Text style={[styles.workoutPreviewTitle, { color: isDark ? '#FFFFFF' : '#000000' }]}>{pendingWorkout.workout_name}</Text>
              <Text style={[styles.workoutPreviewSubtitle, { color: isDark ? '#9CA3AF' : '#6B7280' }]}>
                {getExercises(pendingWorkout).length} exercises • {pendingWorkout.estimated_time} min
              </Text>
            </View>

            {/* Exercise List - Use exercises_structured for ExerciseCard objects */}
            <ScrollView style={styles.workoutPreviewExerciseList}>
              {getExercises(pendingWorkout).map((exercise, index, arr) => (
                <Swipeable
                  key={exercise.id || index}
                  overshootLeft={false}
                  leftThreshold={40}
                  // Last exercise can't be removed — a workout needs at least one.
                  renderLeftActions={arr.length <= 1 ? undefined : () => (
                    <View style={styles.exerciseDeleteWrap}>
                      <TouchableOpacity
                        onPress={() => handleRemoveExercise(exercise.id, index)}
                        style={styles.exerciseDeleteBtn}
                        accessibilityRole="button"
                        accessibilityLabel={`Remove ${exercise.name}`}
                      >
                        <Ionicons name="trash-outline" size={20} color="#FFFFFF" />
                        <Text style={styles.exerciseDeleteText}>Delete</Text>
                      </TouchableOpacity>
                    </View>
                  )}
                >
                  <View style={[styles.workoutPreviewExerciseCard, { backgroundColor: isDark ? '#1C1C1E' : '#F5F5F5' }]}>
                    <View style={styles.workoutPreviewExerciseInfo}>
                      {(() => {
                        const gifUrl = getExerciseGifUrl(exercise.gif_path);
                        return gifUrl ? (
                          <Image
                            source={{ uri: gifUrl }}
                            style={[styles.workoutPreviewExerciseThumb, { backgroundColor: isDark ? '#000000' : '#FFFFFF' }]}
                            contentFit="cover"
                            transition={150}
                            cachePolicy="memory-disk"
                          />
                        ) : (
                          <View style={[styles.workoutPreviewExerciseThumb, styles.workoutPreviewExerciseThumbEmpty, { backgroundColor: isDark ? '#000000' : '#FFFFFF' }]}>
                            <Ionicons name="fitness-outline" size={20} color={isDark ? '#FFFFFF' : '#000000'} />
                          </View>
                        );
                      })()}
                      <Text style={[styles.workoutPreviewExerciseName, { color: isDark ? '#FFFFFF' : '#000000' }]}>{exercise.name}</Text>
                      <Text style={styles.workoutPreviewExerciseSets}>{exercise.sets} sets</Text>
                    </View>
                  </View>
                </Swipeable>
              ))}
            </ScrollView>

            {/* Start Workout Button */}
            <TouchableOpacity
              style={[styles.workoutPreviewStartButton, { backgroundColor: isDark ? '#FFFFFF' : '#000000' }]}
              onPress={() => {
                setShowWorkoutPreview(false);
                confirmWorkout();
              }}
            >
              <Ionicons name="play" size={20} color={isDark ? "#000000" : "#FFFFFF"} />
              <Text style={[styles.workoutPreviewStartButtonText, { color: isDark ? '#000000' : '#FFFFFF' }]}>Start Workout</Text>
            </TouchableOpacity>

            {/* Save to Library Button (explicit, brand-blue) */}
            <TouchableOpacity
              style={[
                styles.workoutPreviewSaveButton,
                { borderColor: colors.primary, opacity: savedToLibrary ? 0.6 : 1 },
              ]}
              onPress={handleSaveToLibrary}
              disabled={savedToLibrary}
              accessibilityRole="button"
              accessibilityLabel={savedToLibrary ? 'Saved to library' : 'Save workout to library'}
            >
              <Ionicons
                name={savedToLibrary ? 'checkmark' : 'bookmark-outline'}
                size={20}
                color={colors.primary}
              />
              <Text style={[styles.workoutPreviewSaveButtonText, { color: colors.primary }]}>
                {savedToLibrary ? 'Saved to Library' : 'Save to Library'}
              </Text>
            </TouchableOpacity>

            {/* Make Changes Button */}
            <TouchableOpacity
              style={[styles.workoutPreviewMakeChangesButton, { borderColor: isDark ? '#FFFFFF' : '#000000' }]}
              onPress={handleMakeChanges}
            >
              <Ionicons name="create-outline" size={20} color={isDark ? "#FFFFFF" : "#000000"} />
              <Text style={[styles.workoutPreviewMakeChangesButtonText, { color: isDark ? '#FFFFFF' : '#000000' }]}>Make Changes</Text>
            </TouchableOpacity>
          </View>
        </View>
      )}
      {/* Chat History Sidebar */}
      <ChatHistorySidebar
        visible={showHistorySidebar}
        onClose={() => setShowHistorySidebar(false)}
        onLoadConversation={handleLoadConversation}
        onNewChat={() => void requestNewChat()}
        currentConversationId={conversationId}
      />
    </>
  );
}


const styles = StyleSheet.create({
  container: {
    flex: 1,
  },
  navbar: {
    position: 'absolute',
    top: 0,
    left: 0,
    right: 0,
    zIndex: 100,
    paddingTop: Platform.OS === 'ios' ? 50 : 30,
    paddingBottom: 8,
  },
  navbarContent: {
    flexDirection: 'row',
    justifyContent: 'space-between',
    alignItems: 'center',
    paddingHorizontal: 24,
    paddingVertical: 8,
  },
  navbarLogo: {
    width: 80,
    height: 36,
  },
  historyButton: {
    // History button on left
  },
  newChatButton: {
    paddingHorizontal: 16,
    paddingVertical: 8,
    borderRadius: 999,
    minHeight: 36,
    alignItems: 'center',
    justifyContent: 'center',
  },
  // Chat locked notice styles
  lockedNoticeContainer: {
    flexDirection: 'row',
    alignItems: 'center',
    padding: 12,
    marginHorizontal: 16,
    marginBottom: 8,
    borderRadius: 12,
    borderWidth: 1,
    gap: 8,
  },
  lockedNoticeText: {
    flex: 1,
    fontSize: 13,
    fontFamily: theme.typography.fontFamily.medium,
  },
  newChatButtonText: {
    fontSize: 13,
    fontFamily: theme.typography.fontFamily.semiBold,
  },
  emptyStateContainer: {
    flex: 1,
    justifyContent: 'center',
    alignItems: 'center',
    paddingHorizontal: 40,
  },
  emptyStateTitle: {
    fontSize: 32,
    fontFamily: theme.typography.fontFamily.bold,
    textAlign: 'left',
    marginBottom: 4,
    lineHeight: 38,
    alignSelf: 'stretch',
  },
  emptyStateSubtitle: {
    fontSize: 32,
    fontFamily: theme.typography.fontFamily.bold,
    textAlign: 'left',
    lineHeight: 38,
    alignSelf: 'stretch',
  },
  messagesContainer: {
    flex: 1,
  },
  messagesContent: {
    padding: 20,
    paddingTop: Platform.OS === 'ios' ? 110 : 90,
    paddingBottom: 20,
    flexGrow: 1,
  },
  messageContainer: {
    marginVertical: 8,
    paddingHorizontal: 16,
  },
  // Paywall coach-chat styling: solid brand blue with a "tail" corner.
  userMessageBubble: {
    backgroundColor: '#2E90FA',
    paddingVertical: 12,
    paddingHorizontal: 16,
    maxWidth: '85%',
    alignSelf: 'flex-end',
    borderRadius: 18,
    borderBottomRightRadius: 4,
  },
  aiMessageBubble: {
    backgroundColor: 'transparent',
    paddingVertical: 4,
    paddingHorizontal: 0,
    maxWidth: '100%',
    alignSelf: 'flex-start',
  },
  coachBriefingCardStack: {
    flexDirection: 'column',
    alignItems: 'stretch',
  },
  messageText: {
    fontSize: theme.typography.fontSize.base,
    fontFamily: theme.typography.fontFamily.regular,
    lineHeight: 22,
  },
  userMessageText: {
    color: '#FFFFFF',
  },
  aiMessageText: {
    color: '#FFFFFF',
    textAlign: 'left',
  },
  messageTextBold: {
    fontSize: theme.typography.fontSize.base,
    fontFamily: theme.typography.fontFamily.bold,
    lineHeight: 22,
  },
  messageTextHeader: {
    fontSize: theme.typography.fontSize.lg,
    fontFamily: theme.typography.fontFamily.bold,
    lineHeight: 26,
  },
  messageTextSubheader: {
    fontSize: theme.typography.fontSize.base,
    fontFamily: theme.typography.fontFamily.semiBold,
    lineHeight: 24,
  },
  messageTextCode: {
    fontSize: theme.typography.fontSize.sm,
    fontFamily: Platform.OS === 'ios' ? 'Menlo' : 'monospace',
    lineHeight: 20,
    backgroundColor: 'rgba(128,128,128,0.15)',
    paddingHorizontal: 4,
    borderRadius: 4,
  },
  cursor: {
    fontFamily: theme.typography.fontFamily.bold,
    opacity: 0.8,
  },
  inputContainer: {
    padding: 16,
    paddingBottom: 16,
  },
  suggestionRow: {
    flexDirection: 'row',
    flexWrap: 'wrap',
    gap: 8,
    marginBottom: 10,
  },
  suggestionChip: {
    borderWidth: 1,
    borderRadius: 20,
    paddingHorizontal: 14,
    paddingVertical: 8,
    maxWidth: '100%',
  },
  suggestionChipText: {
    fontSize: 14,
    fontWeight: '500',
  },
  recommendationsContainer: {
    marginBottom: 12,
  },
  recommendationsContent: {
    paddingHorizontal: 4,
    gap: 8,
  },
  recommendationPill: {
    borderWidth: 1,
    borderRadius: 20,
    paddingHorizontal: 16,
    paddingVertical: 12,
    marginRight: 8,
  },
  recommendationPillText: {
    fontSize: theme.typography.fontSize.sm,
    fontFamily: theme.typography.fontFamily.medium,
  },
  intentPillContainer: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'space-between',
    marginBottom: 12,
    paddingHorizontal: 4,
  },
  intentPill: {
    flexDirection: 'row',
    alignItems: 'center',
    backgroundColor: 'rgba(46, 144, 250, 0.15)', // Purple with transparency
    borderRadius: 20,
    paddingHorizontal: 16,
    paddingVertical: 8,
    borderWidth: 1,
    borderColor: 'rgba(46, 144, 250, 0.4)',
    gap: 8,
    flex: 1,
    marginRight: 8,
  },
  intentPillText: {
    fontSize: 13,
    fontWeight: '600',
    flex: 1,
  },
  intentModeBadge: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 4,
    backgroundColor: 'rgba(46, 144, 250, 0.15)', // Blue tint for AI intent badge
    borderRadius: 12,
    paddingHorizontal: 12,
    paddingVertical: 4,
    marginBottom: 8,
    alignSelf: 'flex-start',
    borderWidth: 1,
    borderColor: 'rgba(46, 144, 250, 0.3)',
  },
  intentModeText: {
    color: '#5AA6FF', // Light blue color
    fontSize: 11,
    fontWeight: '600',
    letterSpacing: 0.5,
  },
  textInputWrapper: {
    flexDirection: 'row',
    alignItems: 'center',
    borderRadius: 24,
    paddingHorizontal: 12,
    paddingVertical: 8,
    minHeight: 36,
  },
  aiIconContainer: {
    marginRight: 8,
    alignItems: 'center',
    justifyContent: 'center',
    width: 32,
    height: 32,
    overflow: 'visible',
  },
  particleGroup: {
    width: 24,
    height: 24,
    position: 'relative',
  },
  particleDot: {
    position: 'absolute',
    width: 10,
    height: 10,
    borderRadius: 4,
    overflow: 'hidden',
  },
  dotGradient: {
    width: 10,
    height: 10,
    borderRadius: 4,
  },
  dot1Position: {
    top: 0,
    left: 7, // centered horizontally
  },
  dot2Position: {
    bottom: 0,
    left: 0,
  },
  dot3Position: {
    bottom: 0,
    right: 0,
  },
  textInput: {
    flex: 1,
    backgroundColor: 'transparent',
    fontSize: theme.typography.fontSize.base,
    fontFamily: theme.typography.fontFamily.regular,
    maxHeight: 100,
    paddingLeft: 4,
    paddingRight: 4,
    textAlignVertical: 'center',
    textAlign: 'left',
    paddingVertical: 0,
    paddingTop: 0,
    paddingBottom: 0,
  },
  sendButton: {
    backgroundColor: 'transparent',
    paddingHorizontal: 4,
    paddingVertical: 4,
    borderRadius: 20,
    alignItems: 'center',
    justifyContent: 'center',
    minWidth: 36,
    minHeight: 36,
  },
  sendButtonDisabled: {
    opacity: 0,
  },
  typingContainer: {
    alignItems: 'center',
    justifyContent: 'center',
    padding: 16,
    borderRadius: 20,
    alignSelf: 'flex-start',
    marginRight: 20,
    ...theme.shadows.sm,
  },
  workoutConfirmation: {
    backgroundColor: theme.colors.backgroundTertiary,
    padding: 16,
    paddingTop: Platform.OS === 'ios' ? 110 : 90,
    borderBottomWidth: 1,
    borderBottomColor: theme.colors.borderLight,
    position: 'absolute',
    top: 0,
    left: 0,
    right: 0,
    zIndex: 1000,
    ...theme.shadows.xl,
    borderBottomLeftRadius: 20,
    borderBottomRightRadius: 20,
  },
  confirmationTitle: {
    color: theme.colors.text,
    fontSize: theme.typography.fontSize.xl,
    fontFamily: theme.typography.fontFamily.bold,
    marginBottom: 8,
    textAlign: 'center',
  },
  confirmationSubtitle: {
    color: theme.colors.textSecondary,
    fontSize: theme.typography.fontSize.sm,
    fontFamily: theme.typography.fontFamily.medium,
    marginBottom: 20,
    textAlign: 'center',
  },
  exercisePreview: {
    backgroundColor: theme.colors.backgroundSecondary,
    padding: 20,
    borderRadius: theme.borderRadius.lg,
    marginBottom: 20,
    borderWidth: 1,
    borderColor: theme.colors.borderLight,
  },
  exercisePreviewText: {
    color: theme.colors.text,
    fontSize: theme.typography.fontSize.sm,
    fontFamily: theme.typography.fontFamily.medium,
    marginBottom: 8,
  },
  moreExercisesText: {
    color: theme.colors.primary,
    fontSize: theme.typography.fontSize.xs,
    fontFamily: theme.typography.fontFamily.regular,
    fontStyle: 'italic',
    marginTop: 8,
  },
  confirmationButtons: {
    flexDirection: 'row',
    justifyContent: 'space-between',
  },
  confirmButton: {
    flex: 1,
    padding: 16,
    borderRadius: theme.borderRadius.lg,
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'center',
    gap: 8,
    marginHorizontal: 8,
    ...theme.shadows.md,
  },
  acceptButton: {
    backgroundColor: theme.colors.primary, // Purple for accept
  },
  rejectButton: {
    backgroundColor: theme.colors.border, // Gray for reject
  },
  buttonText: {
    color: theme.colors.text,
    fontFamily: theme.typography.fontFamily.bold,
    fontSize: theme.typography.fontSize.base,
  },
  // Workout Preview Modal Styles
  workoutPreviewModal: {
    position: 'absolute',
    top: 0,
    left: 0,
    right: 0,
    bottom: 0,
    backgroundColor: '#000000', // Pure black background as per image
    zIndex: 2000,
  },
  workoutPreviewContent: {
    flex: 1,
    paddingTop: Platform.OS === 'ios' ? 60 : 40,
  },
  workoutPreviewHeader: {
    paddingHorizontal: 20,
    paddingBottom: 16,
    // borderBottomWidth: 1, // Removed border to match clean look
    // borderBottomColor: theme.colors.border,
  },
  closeButton: {
    position: 'absolute',
    top: Platform.OS === 'ios' ? 60 : 40,
    right: 20,
    zIndex: 10,
  },
  workoutPreviewTitle: {
    fontSize: 28, // Larger title
    fontFamily: theme.typography.fontFamily.bold,
    marginBottom: 4,
    marginTop: 20,
    marginRight: 40,
    flexWrap: 'wrap',
  },
  workoutPreviewSubtitle: {
    color: '#9CA3AF', // Light gray for subtitle
    fontSize: theme.typography.fontSize.base,
    fontFamily: theme.typography.fontFamily.regular,
  },
  workoutPreviewExerciseList: {
    flex: 1,
    paddingHorizontal: 20,
    paddingTop: 12,
  },
  workoutPreviewExerciseCard: {
    backgroundColor: '#1C1C1E', // Dark grey card background
    borderRadius: 16, // More rounded corners
    padding: 16,
    marginBottom: 12,
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'space-between',
  },
  workoutPreviewExerciseInfo: {
    flexDirection: 'row',
    alignItems: 'center',
    flex: 1,
  },
  workoutPreviewExerciseThumb: {
    width: 48,
    height: 48,
    borderRadius: 12,
    overflow: 'hidden',
  },
  exerciseDeleteWrap: {
    justifyContent: 'center',
    alignItems: 'flex-start',
    // Align with the card's marginBottom so the action sits level with the row.
    paddingBottom: 12,
  },
  exerciseDeleteBtn: {
    backgroundColor: '#EF4444',
    height: '100%',
    width: 84,
    borderRadius: 16,
    marginRight: 10,
    alignItems: 'center',
    justifyContent: 'center',
    gap: 4,
  },
  exerciseDeleteText: {
    color: '#FFFFFF',
    fontSize: 12,
    fontFamily: theme.typography.fontFamily.semiBold,
  },
  workoutPreviewExerciseThumbEmpty: {
    alignItems: 'center',
    justifyContent: 'center',
  },
  workoutPreviewExerciseName: {
    color: '#FFFFFF',
    fontSize: 16,
    fontFamily: theme.typography.fontFamily.semiBold,
    flex: 1,
    marginLeft: 12,
    marginRight: 8,
    textTransform: 'lowercase', // Match the lowercase style in image
  },
  workoutPreviewExerciseSets: {
    color: '#9CA3AF', // Light grey color for sets
    fontSize: 14,
    fontFamily: theme.typography.fontFamily.medium,
  },
  workoutPreviewStartButton: {
    backgroundColor: '#FFFFFF', // White button
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'center',
    paddingVertical: 16,
    marginHorizontal: 20,
    marginTop: 12,
    marginBottom: 12,
    borderRadius: 12,
    shadowColor: '#2E90FA',
    shadowOffset: { width: 0, height: 4 },
    shadowOpacity: 0.2,
    shadowRadius: 8,
    elevation: 4,
  },
  workoutPreviewStartButtonText: {
    color: '#000000',
    fontSize: 18,
    fontFamily: theme.typography.fontFamily.bold,
    marginLeft: 8,
  },
  workoutPreviewSaveButton: {
    backgroundColor: 'transparent',
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'center',
    paddingVertical: 16,
    marginHorizontal: 20,
    marginBottom: 12,
    borderRadius: 12,
    borderWidth: 1.5,
  },
  workoutPreviewSaveButtonText: {
    fontSize: 16,
    fontFamily: theme.typography.fontFamily.semiBold,
    marginLeft: 8,
  },
  workoutPreviewMakeChangesButton: {
    backgroundColor: 'transparent',
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'center',
    paddingVertical: 16,
    marginHorizontal: 20,
    marginBottom: 40, // Space at bottom
    borderRadius: 12,
    borderWidth: 1,

  },
  workoutPreviewMakeChangesButtonText: {

    fontSize: 16,
    fontFamily: theme.typography.fontFamily.bold,
    marginLeft: 8,
  },
  // Workout Card Styles
  workoutCardContainer: {
    marginTop: 8,
  },
  workoutCard: {
    borderRadius: 16,
    padding: 16,
    marginVertical: 8,
    shadowColor: '#000',
    shadowOffset: { width: 0, height: 4 },
    shadowOpacity: 0.18,
    shadowRadius: 10,
    elevation: 4,
    maxWidth: '100%',
    borderWidth: 1,
    borderColor: theme.colors.border,
  },
  workoutCardHeaderRow: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 12,
    marginBottom: 12,
  },
  workoutCardIconBadge: {
    width: 38,
    height: 38,
    borderRadius: 12,
    alignItems: 'center',
    justifyContent: 'center',
  },
  workoutCardTitle: {
    flex: 1,
    fontSize: 18,
    fontWeight: 'bold',
    color: theme.colors.text,
    flexWrap: 'wrap',
  },
  workoutCardDetails: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 8,
    marginBottom: 16,
    flexWrap: 'wrap',
  },
  workoutCardStat: {
    fontSize: 14,
    fontVariant: ['tabular-nums'],
    color: theme.colors.textSecondary,
  },
  workoutCardChips: {
    flexDirection: 'row',
    flexWrap: 'wrap',
    gap: 8,
    marginBottom: 16,
  },
  workoutCardChip: {
    paddingHorizontal: 12,
    paddingVertical: 4,
    borderRadius: 999,
  },
  workoutCardChipText: {
    fontSize: 12,
    fontWeight: '500',
    textTransform: 'capitalize',
  },
  viewWorkoutButton: {
    borderRadius: 12,
    paddingVertical: 12,
    paddingHorizontal: 16,
    minHeight: 48,
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'center',
    gap: 8,
  },
  viewWorkoutButtonText: {
    color: '#fff',
    fontSize: 16,
    fontWeight: '700',
  },
  // Loading Animation Styles
  loadingContainer: {
    alignItems: 'flex-start',
    justifyContent: 'center',
    paddingVertical: 8,
    paddingHorizontal: 16,
  },
  loadingParticleGroup: {
    width: 24,
    height: 24,
    position: 'relative',
  },
  loadingParticleDot: {
    position: 'absolute',
    width: 8,
    height: 8,
    borderRadius: 4,
    overflow: 'hidden',
  },
  loadingDotGradient: {
    width: 8,
    height: 8,
    borderRadius: 4,
  },
  loadingDot1Position: {
    top: 0,
    left: 8, // centered horizontally
  },
  loadingDot2Position: {
    bottom: 0,
    left: 0,
  },
  loadingDot3Position: {
    bottom: 0,
    right: 0,
  },
  // Main Plan Edit Changes Styles
  changesSectionTitle: {
    color: theme.colors.text,
    fontSize: theme.typography.fontSize.base,
    fontFamily: theme.typography.fontFamily.bold,
    marginBottom: 12,
  },
  changesSection: {
    marginBottom: 16,
  },
  changeIndicator: {
    flexDirection: 'row',
    alignItems: 'center',
    marginBottom: 8,
    gap: 8,
  },
  changesSectionLabel: {
    color: theme.colors.text,
    fontSize: theme.typography.fontSize.sm,
    fontFamily: theme.typography.fontFamily.semiBold,
  },
  exerciseChangeItem: {
    fontSize: theme.typography.fontSize.sm,
    fontFamily: theme.typography.fontFamily.medium,
    paddingVertical: 4,
    paddingLeft: 24,
  },
  addedExercise: {
    color: '#2E90FA', // Green for added
  },
  removedExercise: {
    color: '#ef4444', // Red for removed
    textDecorationLine: 'line-through',
  },
  noChangesText: {
    color: theme.colors.textSecondary,
    fontSize: theme.typography.fontSize.sm,
    fontFamily: theme.typography.fontFamily.regular,
    fontStyle: 'italic',
    textAlign: 'center',
    paddingVertical: 12,
  },

  // TWO-MESSAGE FLOW STYLES
  plainTextRow: {
    flexDirection: 'row',
    alignItems: 'flex-start',
    gap: 12,
    marginVertical: 8,
    paddingHorizontal: 16,
  },
  coachAvatar: {
    width: 26,
    height: 26,
    borderRadius: 12,
    alignItems: 'center',
    justifyContent: 'center',
    marginTop: 1,
  },
  coachAvatarDot: {
    width: 9,
    height: 9,
    borderRadius: 4,
  },
  plainTextContainer: {
    flex: 1,
  },
  plainTextMessage: {
    fontSize: 16,
    lineHeight: 24,
    fontFamily: theme.typography.fontFamily.regular,
    // NO background, NO border, NO padding box - just plain text
  },
  coachActivityLabel: {
    marginTop: 8,
    fontSize: 14,
    lineHeight: 20,
    fontFamily: theme.typography.fontFamily.medium,
  },
  feedbackRow: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 18,
    marginTop: 10,
  },
  feedbackFaded: {
    opacity: 0.35,
  },
  messageSeparator: {
    height: 1,
    backgroundColor: theme.colors.border,
    marginVertical: 16,
    marginHorizontal: 16,
  },
  workoutMessageContainer: {
    marginVertical: 8,
  },
  workoutCardWrapper: {
    // Workout card retains its own styling
  },
  messagesWrap: {
    flex: 1,
  },
  // Inverted-list content: edge clearances are applied inline (top/bottom
  // meanings flip when the list is inverted).
  messagesContentInverted: {
    paddingHorizontal: 20,
    flexGrow: 1,
  },
  quotaChipRow: {
    flexDirection: 'row',
    justifyContent: 'flex-end',
    marginBottom: 8,
  },
  quotaChip: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 6,
    paddingHorizontal: 10,
    paddingVertical: 5,
    borderRadius: 999,
    borderWidth: 1,
  },
  quotaChipText: {
    fontSize: 12,
    fontFamily: theme.typography.fontFamily.medium,
  },
  quotaChipUpgrade: {
    fontSize: 12,
    fontFamily: theme.typography.fontFamily.semiBold,
  },
  charCounter: {
    alignSelf: 'flex-end',
    fontSize: 11,
    fontFamily: theme.typography.fontFamily.medium,
    fontVariant: ['tabular-nums'],
    marginBottom: 4,
    marginRight: 6,
  },
  jumpToLatest: {
    position: 'absolute',
    bottom: 14,
    alignSelf: 'center',
    width: 38,
    height: 38,
    borderRadius: 19,
    borderWidth: 1,
    alignItems: 'center',
    justifyContent: 'center',
    ...theme.shadows.md,
  },
  retryChip: {
    flexDirection: 'row',
    alignItems: 'center',
    alignSelf: 'flex-start',
    gap: 6,
    marginTop: 2,
    marginBottom: 8,
    marginLeft: 54,
    paddingHorizontal: 14,
    paddingVertical: 8,
    borderRadius: 20,
    borderWidth: 1,
  },
  retryChipText: {
    fontSize: 13,
    fontFamily: theme.typography.fontFamily.semiBold,
  },
  offlinePill: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 6,
    alignSelf: 'flex-start',
    paddingHorizontal: 12,
    paddingVertical: 6,
    borderRadius: 999,
    borderWidth: 1,
    marginBottom: 10,
  },
  offlinePillText: {
    fontSize: 12,
    fontFamily: theme.typography.fontFamily.medium,
  },
  messageTextTableRow: {
    fontVariant: ['tabular-nums'],
    lineHeight: 24,
  },
  actionSheetOverlay: {
    flex: 1,
    justifyContent: 'flex-end',
    backgroundColor: 'rgba(0,0,0,0.45)',
  },
  actionSheet: {
    borderTopLeftRadius: 20,
    borderTopRightRadius: 20,
    borderWidth: 1,
    paddingHorizontal: 16,
    paddingTop: 14,
  },
  actionSheetPreview: {
    fontSize: 13,
    fontFamily: theme.typography.fontFamily.regular,
    marginBottom: 6,
    paddingHorizontal: 4,
  },
  actionSheetRow: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 12,
    paddingVertical: 14,
    paddingHorizontal: 4,
  },
  actionSheetRowText: {
    fontSize: 16,
    fontFamily: theme.typography.fontFamily.medium,
  },
  actionSheetFeedbackRow: {
    flexDirection: 'row',
    gap: 10,
    paddingVertical: 8,
    paddingHorizontal: 4,
  },
  actionSheetFeedbackBtn: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 8,
    paddingHorizontal: 16,
    paddingVertical: 10,
    borderRadius: 999,
    borderWidth: 1,
  },
  actionSheetFeedbackText: {
    fontSize: 14,
    fontFamily: theme.typography.fontFamily.medium,
  },
  actionSheetCancel: {
    marginTop: 8,
    borderRadius: 12,
    alignItems: 'center',
    paddingVertical: 14,
  },
  actionSheetCancelText: {
    fontSize: 16,
    fontFamily: theme.typography.fontFamily.semiBold,
  },
});
