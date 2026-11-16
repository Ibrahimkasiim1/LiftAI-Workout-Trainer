/**
 * EditSetsSheet — read/edit view for a completed exercise's logged sets.
 *
 * Opened from a completed page in the workout pager (the "Edit sets"
 * affordance) so a mis-logged set is no longer a dead-end. Each row shows
 * the logged weight × reps; tapping a value makes it editable, and Save
 * writes the correction locally + to the database.
 *
 * Plain RN Modal on purpose — the player already nests a paging FlatList and
 * two bottom sheets; this avoids adding another gesture layer.
 */

import { Ionicons } from '@expo/vector-icons';
import * as Haptics from 'expo-haptics';
import React, { useEffect, useState } from 'react';
import {
  KeyboardAvoidingView,
  Modal,
  Platform,
  ScrollView,
  StyleSheet,
  Text,
  TextInput,
  TouchableOpacity,
  View,
} from 'react-native';
import type { ExercisePerformanceLog } from '../src/services/ProgressService';

interface Props {
  visible: boolean;
  exerciseName: string;
  unit: 'kg' | 'lbs';
  isBodyweight: boolean;
  sets: ExercisePerformanceLog[];
  onClose: () => void;
  /** Persist one corrected set (weight in the user's display unit). */
  onSaveSet: (setNumber: number, weight: number, reps: number) => void;
}

interface DraftRow {
  setNumber: number;
  weight: string;
  reps: string;
}

const fmt = (n: number): string =>
  Number.isInteger(n) ? n.toString() : n.toFixed(1).replace(/\.0$/, '');

export default function EditSetsSheet({
  visible,
  exerciseName,
  unit,
  isBodyweight,
  sets,
  onClose,
  onSaveSet,
}: Props) {
  const [drafts, setDrafts] = useState<DraftRow[]>([]);

  useEffect(() => {
    if (!visible) return;
    setDrafts(
      [...sets]
        .sort((a, b) => a.set_number - b.set_number)
        .map((s) => ({
          setNumber: s.set_number,
          weight: fmt(s.weight_used),
          reps: s.reps_completed.toString(),
        })),
    );
  }, [visible, sets]);

  const updateDraft = (setNumber: number, field: 'weight' | 'reps', value: string) => {
    setDrafts((prev) =>
      prev.map((d) => (d.setNumber === setNumber ? { ...d, [field]: value } : d)),
    );
  };

  const handleSave = () => {
    let savedAny = false;
    drafts.forEach((d) => {
      const original = sets.find((s) => s.set_number === d.setNumber);
      if (!original) return;
      const weight = parseFloat(d.weight.replace(',', '.'));
      const reps = parseInt(d.reps, 10);
      if (!Number.isFinite(reps) || reps <= 0) return;
      const finalWeight = isBodyweight ? original.weight_used : Number.isFinite(weight) ? weight : original.weight_used;
      if (finalWeight === original.weight_used && reps === original.reps_completed) return;
      onSaveSet(d.setNumber, finalWeight, reps);
      savedAny = true;
    });
    if (savedAny) {
      Haptics.notificationAsync(Haptics.NotificationFeedbackType.Success);
    }
    onClose();
  };

  return (
    <Modal visible={visible} animationType="slide" transparent onRequestClose={onClose}>
      <View style={styles.backdrop}>
        <KeyboardAvoidingView behavior={Platform.OS === 'ios' ? 'padding' : undefined}>
          <View style={styles.card}>
            <View style={styles.handle} />
            <View style={styles.header}>
              <Text style={styles.title} numberOfLines={1}>{exerciseName}</Text>
              <TouchableOpacity
                onPress={onClose}
                hitSlop={{ top: 12, bottom: 12, left: 12, right: 12 }}
                accessibilityLabel="Close"
              >
                <Ionicons name="close" size={22} color="#111" />
              </TouchableOpacity>
            </View>
            <Text style={styles.subtitle}>Logged this session — tap a value to correct it.</Text>

            <ScrollView style={styles.rows} keyboardShouldPersistTaps="handled">
              {drafts.length === 0 ? (
                <Text style={styles.emptyText}>No sets were logged for this exercise.</Text>
              ) : (
                drafts.map((d) => (
                  <View key={d.setNumber} style={styles.row}>
                    <Text style={styles.setLabel}>Set {d.setNumber}</Text>
                    {!isBodyweight && (
                      <View style={styles.inputWrap}>
                        <TextInput
                          style={styles.input}
                          value={d.weight}
                          onChangeText={(v) => updateDraft(d.setNumber, 'weight', v)}
                          keyboardType="decimal-pad"
                          selectTextOnFocus
                          maxLength={6}
                        />
                        <Text style={styles.inputUnit}>{unit}</Text>
                      </View>
                    )}
                    <Text style={styles.times}>×</Text>
                    <View style={styles.inputWrap}>
                      <TextInput
                        style={styles.input}
                        value={d.reps}
                        onChangeText={(v) => updateDraft(d.setNumber, 'reps', v)}
                        keyboardType="number-pad"
                        selectTextOnFocus
                        maxLength={3}
                      />
                      <Text style={styles.inputUnit}>reps</Text>
                    </View>
                  </View>
                ))
              )}
            </ScrollView>

            {drafts.length > 0 && (
              <TouchableOpacity style={styles.saveButton} onPress={handleSave}>
                <Text style={styles.saveButtonText}>Save changes</Text>
              </TouchableOpacity>
            )}
          </View>
        </KeyboardAvoidingView>
      </View>
    </Modal>
  );
}

const styles = StyleSheet.create({
  backdrop: {
    flex: 1,
    justifyContent: 'flex-end',
    backgroundColor: 'rgba(0,0,0,0.32)',
  },
  card: {
    backgroundColor: '#FFF',
    borderTopLeftRadius: 18,
    borderTopRightRadius: 18,
    paddingHorizontal: 16,
    paddingTop: 12,
    paddingBottom: 28,
    maxHeight: '75%',
  },
  handle: {
    width: 40,
    height: 4,
    backgroundColor: '#E0E0E0',
    borderRadius: 4,
    alignSelf: 'center',
    marginBottom: 12,
  },
  header: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'space-between',
    gap: 12,
  },
  title: {
    flex: 1,
    fontSize: 18,
    fontWeight: '700',
    color: '#111',
  },
  subtitle: {
    fontSize: 12,
    color: '#8A97A8',
    fontWeight: '500',
    marginTop: 4,
    marginBottom: 14,
  },
  rows: {
    flexGrow: 0,
  },
  emptyText: {
    fontSize: 13,
    color: '#8A97A8',
    paddingVertical: 16,
    textAlign: 'center',
  },
  row: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 10,
    paddingVertical: 8,
    borderBottomWidth: 1,
    borderBottomColor: '#F1F4F8',
  },
  setLabel: {
    width: 52,
    fontSize: 13,
    fontWeight: '700',
    color: '#334155',
  },
  inputWrap: {
    flex: 1,
    flexDirection: 'row',
    alignItems: 'center',
    gap: 6,
    borderWidth: 1.5,
    borderColor: '#DBE7F5',
    borderRadius: 10,
    paddingHorizontal: 10,
    minHeight: 44,
  },
  input: {
    flex: 1,
    fontSize: 16,
    fontWeight: '700',
    color: '#111',
    paddingVertical: 8,
  },
  inputUnit: {
    fontSize: 11,
    fontWeight: '600',
    color: '#94A3B4',
  },
  times: {
    fontSize: 13,
    color: '#94A3B4',
    fontWeight: '600',
  },
  saveButton: {
    marginTop: 16,
    backgroundColor: '#111111',
    borderRadius: 999,
    minHeight: 50,
    alignItems: 'center',
    justifyContent: 'center',
  },
  saveButtonText: {
    color: '#FFF',
    fontSize: 15,
    fontWeight: '700',
  },
});
