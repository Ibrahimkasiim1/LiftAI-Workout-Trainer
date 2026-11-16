import * as Haptics from 'expo-haptics';
import React, { useCallback, useEffect, useState } from 'react';
import { Modal, Pressable, StyleSheet, Text, TouchableOpacity, View } from 'react-native';

interface Props {
  visible: boolean;
  value: number;
  label: string;
  unit?: string;
  min?: number;
  max?: number;
  step?: number;
  quickSteps?: number[];
  onConfirm: (value: number) => void;
  onClose: () => void;
}

export default function NumberStepperSheet({
  visible,
  value,
  label,
  unit = '',
  min = 0,
  max = 9999,
  step = 1,
  quickSteps,
  onConfirm,
  onClose,
}: Props) {
  const [local, setLocal] = useState(value);

  useEffect(() => {
    if (visible) setLocal(value);
  }, [visible, value]);

  const adjust = useCallback(
    (delta: number) => {
      Haptics.impactAsync(Haptics.ImpactFeedbackStyle.Light);
      setLocal((prev) => {
        const next = Math.round((prev + delta) / step) * step;
        return Math.min(max, Math.max(min, parseFloat(next.toFixed(4))));
      });
    },
    [min, max, step],
  );

  const steps = quickSteps ?? [...new Set([step, step * 5, step * 10].filter((s) => s > 0 && s !== step || s === step))].slice(0, 3);

  return (
    <Modal visible={visible} transparent animationType="slide" onRequestClose={onClose}>
      <Pressable style={styles.backdrop} onPress={onClose} />
      <View style={styles.sheet}>
        <View style={styles.handle} />
        <Text style={styles.label}>{label}</Text>

        <View style={styles.stepperRow}>
          <TouchableOpacity style={styles.stepBtn} onPress={() => adjust(-step)} activeOpacity={0.7}>
            <Text style={styles.stepBtnText}>−</Text>
          </TouchableOpacity>
          <View style={styles.valueWrap}>
            <Text style={styles.valueText}>{local}</Text>
            {unit ? <Text style={styles.unitText}>{unit}</Text> : null}
          </View>
          <TouchableOpacity style={styles.stepBtn} onPress={() => adjust(step)} activeOpacity={0.7}>
            <Text style={styles.stepBtnText}>+</Text>
          </TouchableOpacity>
        </View>

        <View style={styles.quickRow}>
          {steps.map((s) => (
            <React.Fragment key={s}>
              <TouchableOpacity style={styles.quickBtn} onPress={() => adjust(-s)}>
                <Text style={styles.quickBtnText}>−{s}</Text>
              </TouchableOpacity>
              <TouchableOpacity style={styles.quickBtn} onPress={() => adjust(s)}>
                <Text style={styles.quickBtnText}>+{s}</Text>
              </TouchableOpacity>
            </React.Fragment>
          ))}
        </View>

        <TouchableOpacity
          style={styles.doneBtn}
          onPress={() => {
            onConfirm(local);
            onClose();
          }}
          activeOpacity={0.85}
        >
          <Text style={styles.doneBtnText}>Done</Text>
        </TouchableOpacity>
      </View>
    </Modal>
  );
}

const styles = StyleSheet.create({
  backdrop: {
    flex: 1,
    backgroundColor: 'rgba(0,0,0,0.35)',
  },
  sheet: {
    backgroundColor: '#FFF',
    borderTopLeftRadius: 24,
    borderTopRightRadius: 24,
    paddingHorizontal: 24,
    paddingTop: 12,
    paddingBottom: 36,
    shadowColor: '#000',
    shadowOffset: { width: 0, height: -4 },
    shadowOpacity: 0.1,
    shadowRadius: 12,
    elevation: 8,
  },
  handle: {
    width: 40,
    height: 4,
    backgroundColor: '#E0E0E0',
    borderRadius: 4,
    alignSelf: 'center',
    marginBottom: 16,
  },
  label: {
    fontSize: 16,
    fontWeight: '700',
    color: '#111',
    textAlign: 'center',
    marginBottom: 24,
  },
  stepperRow: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'center',
    gap: 20,
    marginBottom: 20,
  },
  stepBtn: {
    width: 64,
    height: 64,
    borderRadius: 999,
    backgroundColor: '#F0F0F0',
    alignItems: 'center',
    justifyContent: 'center',
  },
  stepBtnText: {
    fontSize: 30,
    fontWeight: '300',
    color: '#111',
    lineHeight: 34,
  },
  valueWrap: {
    flexDirection: 'row',
    alignItems: 'baseline',
    minWidth: 100,
    justifyContent: 'center',
  },
  valueText: {
    fontSize: 48,
    fontWeight: '700',
    color: '#000',
    fontVariant: ['tabular-nums'],
  },
  unitText: {
    fontSize: 18,
    fontWeight: '600',
    color: '#888',
    marginLeft: 6,
    marginBottom: 4,
  },
  quickRow: {
    flexDirection: 'row',
    justifyContent: 'center',
    gap: 8,
    flexWrap: 'wrap',
    marginBottom: 24,
  },
  quickBtn: {
    paddingHorizontal: 16,
    paddingVertical: 8,
    borderRadius: 20,
    backgroundColor: '#F5F5F5',
    borderWidth: 1,
    borderColor: '#E8E8E8',
  },
  quickBtnText: {
    fontSize: 14,
    fontWeight: '600',
    color: '#333',
  },
  doneBtn: {
    backgroundColor: '#2E90FA',
    borderRadius: 16,
    paddingVertical: 16,
    alignItems: 'center',
  },
  doneBtnText: {
    color: '#FFF',
    fontSize: 17,
    fontWeight: '700',
  },
});
