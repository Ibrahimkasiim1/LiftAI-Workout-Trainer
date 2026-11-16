// components/ExerciseSearchSheet.tsx
//
// Premium exercise library / search. Reuses the hybrid `search_exercises` RPC
// (vector + trigram + curated aliases) in TEXT-ONLY mode — no embedding needed
// client-side, so "elliptical", "abs", "lat pulldown" all resolve. Read-only
// browse: results open an inline detail (gif + instructions + summary) instead
// of the performance-history screen, which would be empty for un-performed moves.

import { Ionicons } from '@expo/vector-icons';
import React, { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import {
  ActivityIndicator,
  FlatList,
  Image,
  Modal,
  ScrollView,
  StyleSheet,
  Text,
  TextInput,
  TouchableOpacity,
  View,
} from 'react-native';
import { SafeAreaView } from 'react-native-safe-area-context';

import { getThemeColors } from '../constants/theme';
import { useTheme } from '../context/ThemeContext';
import { getExerciseGifUrl } from '../utils/exerciseGifs';
import { formatExerciseName, formatExerciseNameParts } from '../utils/exerciseName';
import { supabase } from '../utils/supabase';

export interface ExerciseRow {
  id: string;
  name: string;
  target_muscle: string | null;
  body_part: string | null;
  equipment: string | null;
  equipment_display: string | null;
  enrichment: { summary?: string; movement_pattern?: string } | null;
  difficulty: string | null;
  gif_path: string | null;
  instructions: string[] | null;
}

interface ExerciseSearchSheetProps {
  visible: boolean;
  onClose: () => void;
  /**
   * Picker mode: when provided, the inline detail view shows a primary
   * "select" button and rows get a one-tap select affordance. Used by the
   * manual plan editors (replace / add exercise). Browse mode when omitted.
   */
  onSelect?: (exercise: ExerciseRow) => void;
  /** Button label in picker mode, e.g. "Replace with this" / "Add to workout". */
  selectLabel?: string;
}

// Quick browse chips → the query text fed to the search RPC.
const MUSCLE_CHIPS: { label: string; query: string }[] = [
  { label: 'Chest', query: 'chest pectorals press' },
  { label: 'Back', query: 'back lats rows pull' },
  { label: 'Legs', query: 'legs quads hamstrings glutes squat' },
  { label: 'Shoulders', query: 'shoulders delts overhead press' },
  { label: 'Arms', query: 'biceps triceps curl' },
  { label: 'Core', query: 'abs core obliques' },
  { label: 'Cardio', query: 'cardio conditioning' },
  { label: 'Stretching', query: 'stretch mobility cooldown' },
];

const SELECT_COLS =
  'id, name, target_muscle, body_part, equipment, equipment_display, enrichment, difficulty, gif_path, instructions';

export default function ExerciseSearchSheet({ visible, onClose, onSelect, selectLabel }: ExerciseSearchSheetProps) {
  const { isDark } = useTheme();
  const colors = getThemeColors(isDark);

  const [query, setQuery] = useState('');
  const [activeChip, setActiveChip] = useState<string | null>(null);
  const [results, setResults] = useState<ExerciseRow[]>([]);
  const [loading, setLoading] = useState(false);
  const [selected, setSelected] = useState<ExerciseRow | null>(null);
  const reqId = useRef(0);

  // Default browse list (empty query): a varied slice of the library.
  const loadDefault = useCallback(async () => {
    const id = ++reqId.current;
    setLoading(true);
    // `supabase as any`: the generated types lag the live schema (missing
    // equipment_display / enrichment columns), matching how other screens cast.
    const { data } = await (supabase as any)
      .from('exercises')
      .select(SELECT_COLS)
      .not('gif_path', 'is', null)
      .neq('gif_path', '')
      .order('name')
      .limit(30);
    if (id !== reqId.current) return; // a newer request superseded this one
    setResults((data ?? []) as unknown as ExerciseRow[]);
    setLoading(false);
  }, []);

  const runSearch = useCallback(async (q: string) => {
    const id = ++reqId.current;
    setLoading(true);
    // Text-only search (no embedding) — the RPC handles trigram + alias recall.
    const { data, error } = await (supabase as any).rpc('search_exercises', {
      query_text: q,
      match_count: 30,
    });
    if (id !== reqId.current) return;
    if (error) {
      console.warn('[ExerciseSearchSheet] search failed:', error.message);
      setResults([]);
    } else {
      setResults((data ?? []) as unknown as ExerciseRow[]);
    }
    setLoading(false);
  }, []);

  // Debounced reaction to query changes.
  useEffect(() => {
    if (!visible) return;
    const q = query.trim();
    if (q.length === 0) {
      loadDefault();
      return;
    }
    if (q.length < 2) return;
    const t = setTimeout(() => runSearch(q), 280);
    return () => clearTimeout(t);
  }, [query, visible, runSearch, loadDefault]);

  // Reset transient state each time the sheet opens.
  useEffect(() => {
    if (visible) {
      setSelected(null);
    } else {
      setQuery('');
      setActiveChip(null);
      setResults([]);
    }
  }, [visible]);

  const onChip = useCallback((chip: { label: string; query: string }) => {
    setActiveChip(chip.label);
    setQuery('');
    runSearch(chip.query);
  }, [runSearch]);

  const renderRow = useCallback(
    ({ item }: { item: ExerciseRow }) => {
      const parts = formatExerciseNameParts(item.name);
      const meta = [item.target_muscle, item.equipment_display || item.equipment]
        .filter(Boolean)
        .map(s => String(s))
        .join(' · ');
      return (
        <TouchableOpacity
          style={[styles.row, { borderColor: colors.border }]}
          activeOpacity={0.7}
          onPress={() => setSelected(item)}
        >
          <View style={[styles.thumb, { backgroundColor: colors.backgroundSecondary }]}>
            {item.gif_path ? (
              <Image source={{ uri: getExerciseGifUrl(item.gif_path) }} style={styles.thumbImg} resizeMode="cover" />
            ) : (
              <Ionicons name="barbell-outline" size={22} color={colors.textMuted} />
            )}
          </View>
          <View style={styles.rowText}>
            <Text style={[styles.rowTitle, { color: colors.text }]} numberOfLines={1}>
              {parts.title}
              {parts.modifier ? <Text style={{ color: colors.textMuted }}>{`  ${parts.modifier}`}</Text> : null}
            </Text>
            {meta ? (
              <Text style={[styles.rowMeta, { color: colors.primary }]} numberOfLines={1}>
                {meta}
              </Text>
            ) : null}
            {item.enrichment?.summary ? (
              <Text style={[styles.rowSummary, { color: colors.textMuted }]} numberOfLines={2}>
                {item.enrichment.summary}
              </Text>
            ) : null}
          </View>
          <Ionicons name="chevron-forward" size={18} color={colors.textMuted} />
        </TouchableOpacity>
      );
    },
    [colors],
  );

  const listEmpty = useMemo(() => {
    if (loading) return null;
    return (
      <View style={styles.emptyWrap}>
        <Ionicons name="search-outline" size={28} color={colors.textMuted} />
        <Text style={[styles.emptyText, { color: colors.textMuted }]}>
          {query.trim().length > 0 ? `No matches for "${query.trim()}"` : 'Search 1,300+ exercises'}
        </Text>
      </View>
    );
  }, [loading, query, colors]);

  return (
    <Modal visible={visible} animationType="slide" presentationStyle="pageSheet" onRequestClose={onClose}>
      <SafeAreaView style={[styles.container, { backgroundColor: colors.background }]} edges={['top']}>
        {selected ? (
          <ExerciseDetailInline
            exercise={selected}
            colors={colors}
            onBack={() => setSelected(null)}
            onSelect={onSelect}
            selectLabel={selectLabel}
          />
        ) : (
          <>
            {/* Header: search field + close */}
            <View style={styles.header}>
              <View style={[styles.searchBox, { backgroundColor: colors.backgroundSecondary, borderColor: colors.border }]}>
                <Ionicons name="search" size={18} color={colors.textMuted} />
                <TextInput
                  value={query}
                  onChangeText={(t) => {
                    setQuery(t);
                    setActiveChip(null);
                  }}
                  placeholder="Search exercises…"
                  placeholderTextColor={colors.textMuted}
                  style={[styles.searchInput, { color: colors.text }]}
                  autoCorrect={false}
                  returnKeyType="search"
                />
                {query.length > 0 ? (
                  <TouchableOpacity onPress={() => setQuery('')} hitSlop={{ top: 8, bottom: 8, left: 8, right: 8 }}>
                    <Ionicons name="close-circle" size={18} color={colors.textMuted} />
                  </TouchableOpacity>
                ) : null}
              </View>
              <TouchableOpacity onPress={onClose} style={styles.closeBtn}>
                <Text style={[styles.closeText, { color: colors.primary }]}>Done</Text>
              </TouchableOpacity>
            </View>

            {/* Quick browse chips */}
            <View style={styles.chipsRow}>
              <ScrollView horizontal showsHorizontalScrollIndicator={false} contentContainerStyle={styles.chipsContent}>
                {MUSCLE_CHIPS.map((chip) => {
                  const active = activeChip === chip.label;
                  return (
                    <TouchableOpacity
                      key={chip.label}
                      onPress={() => onChip(chip)}
                      style={[
                        styles.chip,
                        {
                          backgroundColor: active ? colors.primary : colors.backgroundSecondary,
                          borderColor: active ? colors.primary : colors.border,
                        },
                      ]}
                    >
                      <Text style={[styles.chipText, { color: active ? colors.textInverse : colors.text }]}>
                        {chip.label}
                      </Text>
                    </TouchableOpacity>
                  );
                })}
              </ScrollView>
            </View>

            {loading ? (
              <View style={styles.loadingWrap}>
                <ActivityIndicator color={colors.primary} />
              </View>
            ) : (
              <FlatList
                data={results}
                keyExtractor={(item) => item.id}
                renderItem={renderRow}
                contentContainerStyle={styles.listContent}
                keyboardShouldPersistTaps="handled"
                ListEmptyComponent={listEmpty}
              />
            )}
          </>
        )}
      </SafeAreaView>
    </Modal>
  );
}

// In-sheet detail: large gif, pills, summary, numbered instructions.
function ExerciseDetailInline({
  exercise,
  colors,
  onBack,
  onSelect,
  selectLabel,
}: {
  exercise: ExerciseRow;
  colors: ReturnType<typeof getThemeColors>;
  onBack: () => void;
  onSelect?: (exercise: ExerciseRow) => void;
  selectLabel?: string;
}) {
  const pills = [exercise.target_muscle, exercise.equipment_display || exercise.equipment, exercise.difficulty]
    .filter(Boolean)
    .map((s) => String(s));
  return (
    <View style={styles.detailContainer}>
      <View style={styles.detailHeader}>
        <TouchableOpacity onPress={onBack} style={styles.backBtn} hitSlop={{ top: 8, bottom: 8, left: 8, right: 8 }}>
          <Ionicons name="chevron-back" size={24} color={colors.text} />
        </TouchableOpacity>
        <Text style={[styles.detailTitle, { color: colors.text }]} numberOfLines={1}>
          {formatExerciseName(exercise.name)}
        </Text>
        <View style={{ width: 32 }} />
      </View>
      {onSelect ? (
        <View style={styles.selectBtnWrap}>
          <TouchableOpacity
            style={[styles.selectBtn, { backgroundColor: colors.text }]}
            onPress={() => onSelect(exercise)}
            activeOpacity={0.85}
          >
            <Ionicons name="checkmark" size={18} color={colors.textInverse} />
            <Text style={[styles.selectBtnText, { color: colors.textInverse }]}>
              {selectLabel ?? 'Use this exercise'}
            </Text>
          </TouchableOpacity>
        </View>
      ) : null}
      <ScrollView contentContainerStyle={styles.detailScroll}>
        <View style={[styles.detailGif, { backgroundColor: colors.backgroundSecondary }]}>
          {exercise.gif_path ? (
            <Image source={{ uri: getExerciseGifUrl(exercise.gif_path) }} style={styles.detailGifImg} resizeMode="contain" />
          ) : (
            <Ionicons name="barbell-outline" size={40} color={colors.textMuted} />
          )}
        </View>

        <View style={styles.pillRow}>
          {pills.map((p, i) => (
            <View key={i} style={[styles.pill, { backgroundColor: colors.backgroundSecondary, borderColor: colors.border }]}>
              <Text style={[styles.pillText, { color: colors.textSecondary }]}>{p}</Text>
            </View>
          ))}
        </View>

        {exercise.enrichment?.summary ? (
          <Text style={[styles.detailSummary, { color: colors.textSecondary }]}>{exercise.enrichment.summary}</Text>
        ) : null}

        {exercise.instructions && exercise.instructions.length > 0 ? (
          <View style={styles.instructions}>
            <Text style={[styles.instructionsHeading, { color: colors.text }]}>How to perform</Text>
            {exercise.instructions.map((step, i) => (
              <View key={i} style={styles.stepRow}>
                <Text style={[styles.stepNum, { color: colors.primary }]}>{i + 1}</Text>
                <Text style={[styles.stepText, { color: colors.textSecondary }]}>{step}</Text>
              </View>
            ))}
          </View>
        ) : null}
      </ScrollView>
    </View>
  );
}

const styles = StyleSheet.create({
  container: { flex: 1 },
  header: {
    flexDirection: 'row',
    alignItems: 'center',
    paddingHorizontal: 16,
    paddingTop: 8,
    paddingBottom: 8,
    gap: 8,
  },
  searchBox: {
    flex: 1,
    flexDirection: 'row',
    alignItems: 'center',
    gap: 8,
    borderRadius: 12,
    borderWidth: 1,
    paddingHorizontal: 12,
    height: 42,
  },
  searchInput: { flex: 1, fontFamily: 'Montserrat_500Medium', fontSize: 15 },
  closeBtn: { paddingHorizontal: 6, paddingVertical: 8 },
  closeText: { fontFamily: 'Montserrat_600SemiBold', fontSize: 15 },
  chipsRow: { height: 44 },
  chipsContent: { paddingHorizontal: 16, gap: 8, alignItems: 'center' },
  chip: {
    paddingHorizontal: 14,
    paddingVertical: 7,
    borderRadius: 999,
    borderWidth: 1,
  },
  chipText: { fontFamily: 'Montserrat_600SemiBold', fontSize: 13 },
  loadingWrap: { flex: 1, alignItems: 'center', justifyContent: 'center' },
  listContent: { paddingHorizontal: 16, paddingTop: 6, paddingBottom: 40 },
  row: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 12,
    paddingVertical: 12,
    borderBottomWidth: StyleSheet.hairlineWidth,
  },
  thumb: {
    width: 56,
    height: 56,
    borderRadius: 12,
    alignItems: 'center',
    justifyContent: 'center',
    overflow: 'hidden',
  },
  thumbImg: { width: '100%', height: '100%' },
  rowText: { flex: 1, gap: 2 },
  rowTitle: { fontFamily: 'Montserrat_600SemiBold', fontSize: 15 },
  rowMeta: { fontFamily: 'Montserrat_500Medium', fontSize: 12 },
  rowSummary: { fontFamily: 'Montserrat_400Regular', fontSize: 12, lineHeight: 16 },
  emptyWrap: { alignItems: 'center', justifyContent: 'center', paddingTop: 80, gap: 10 },
  emptyText: { fontFamily: 'Montserrat_500Medium', fontSize: 14 },
  // Detail
  detailContainer: { flex: 1 },
  detailHeader: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'space-between',
    paddingHorizontal: 12,
    paddingVertical: 8,
  },
  backBtn: { width: 32, alignItems: 'flex-start' },
  detailTitle: { flex: 1, textAlign: 'center', fontFamily: 'Montserrat_700Bold', fontSize: 17 },
  detailScroll: { paddingHorizontal: 20, paddingBottom: 40 },
  detailGif: {
    width: '100%',
    aspectRatio: 1,
    borderRadius: 20,
    alignItems: 'center',
    justifyContent: 'center',
    overflow: 'hidden',
    marginBottom: 16,
  },
  detailGifImg: { width: '100%', height: '100%' },
  pillRow: { flexDirection: 'row', flexWrap: 'wrap', gap: 8, marginBottom: 16 },
  pill: { paddingHorizontal: 12, paddingVertical: 6, borderRadius: 999, borderWidth: 1 },
  pillText: { fontFamily: 'Montserrat_600SemiBold', fontSize: 12, textTransform: 'capitalize' },
  detailSummary: { fontFamily: 'Montserrat_400Regular', fontSize: 14, lineHeight: 21, marginBottom: 20 },
  instructions: { gap: 12 },
  instructionsHeading: { fontFamily: 'Montserrat_700Bold', fontSize: 15, marginBottom: 4 },
  stepRow: { flexDirection: 'row', gap: 12 },
  stepNum: { fontFamily: 'Montserrat_700Bold', fontSize: 14, width: 18 },
  stepText: { flex: 1, fontFamily: 'Montserrat_400Regular', fontSize: 14, lineHeight: 21 },
  selectBtnWrap: { paddingHorizontal: 20, paddingBottom: 8 },
  selectBtn: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'center',
    gap: 8,
    borderRadius: 14,
    paddingVertical: 14,
  },
  selectBtnText: { fontFamily: 'Montserrat_700Bold', fontSize: 15 },
});
