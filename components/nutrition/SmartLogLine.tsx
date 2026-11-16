import * as Haptics from 'expo-haptics';
import React, { forwardRef, useMemo, useState } from 'react';
import {
  ActivityIndicator,
  Keyboard,
  Pressable,
  StyleSheet,
  Text,
  TextInput,
  View,
} from 'react-native';

import { getThemeColors } from '../../constants/theme';
import { useTheme } from '../../context/ThemeContext';
import { Ionicons } from '@expo/vector-icons';
import BarcodeScannerModal, { BarcodeMacros } from './BarcodeScannerModal';

export type ParsedNutrition = {
  calories: number;
  protein: number;
  carbs: number;
  fats: number;
};

export type ClarificationOption = {
  label: string;
  delta: {
    calories: number;
    protein: number;
    carbs: number;
    fats: number;
  };
};

export type ClarificationBlock = {
  question: string;
  options: ClarificationOption[];
};

export type ResolveResult = {
  logId: string;
  parsed: ParsedNutrition;
  clarification?: ClarificationBlock | null;
};

type SmartLogLineProps = {
  placeholder?: string;
  onResolve: (rawText: string) => Promise<ResolveResult>;
  /**
   * Deterministic path for barcode scans with complete macros: persists the
   * log without an LLM parse or the daily AI-meal quota. When absent (or the
   * scan lacked full macro data) barcode lines fall back to onResolve.
   */
  onResolveBarcode?: (payload: {
    rawText: string;
    macros: BarcodeMacros;
  }) => Promise<ResolveResult>;
  onResolved?: (payload: { rawText: string; parsed: ParsedNutrition }) => void;
  /**
   * Opens the photo meal logger (camera). Rendered as a camera icon button
   * next to the barcode button when provided; the parent owns the quota
   * pre-gate and navigation.
   */
  onCameraPress?: () => void;
};

type LineStatus = 'empty' | 'typing' | 'processing' | 'resolved';

/**
 * Apple-Notes-style log line: a borderless text input on the left and a small
 * action area on the right that flips between an arrow-up send button (idle/
 * typing), a spinner (processing), and inline macro text (resolved).
 *
 * Clarification pills are rendered by the parent on the matching log row, not
 * inside this component.
 */
const SmartLogLine = forwardRef<TextInput, SmartLogLineProps>(({
  placeholder = 'Log your meal...',
  onResolve,
  onResolveBarcode,
  onResolved,
  onCameraPress,
}, ref) => {
  const { isDark } = useTheme();
  const colors = getThemeColors(isDark);

  const [rawText, setRawText] = useState('');
  const [status, setStatus] = useState<LineStatus>('empty');
  const [parsed, setParsed] = useState<ParsedNutrition | null>(null);
  const [scannerOpen, setScannerOpen] = useState(false);

  const isProcessing = status === 'processing';
  const isResolved = status === 'resolved';
  const isEmpty = useMemo(() => rawText.trim().length === 0, [rawText]);

  const handleChangeText = (nextText: string) => {
    setRawText(nextText);
    if (isProcessing) return;
    if (parsed) setParsed(null);
    setStatus(nextText.trim().length > 0 ? 'typing' : 'empty');
  };

  /** Shared submit pipeline — the resolver differs (AI parse vs. structured
   *  barcode persist) but the status/haptics/keyboard handling is identical. */
  const submitVia = async (text: string, resolve: () => Promise<ResolveResult>) => {
    if (!text || isProcessing) return;

    setStatus('processing');
    try {
      const result = await resolve();
      setParsed(result.parsed);
      setStatus('resolved');
      // Dismiss keyboard so the resolved row (and any row-attached clarification
      // pills) are not hidden behind it.
      Keyboard.dismiss();
      void Haptics.impactAsync(Haptics.ImpactFeedbackStyle.Light);
      onResolved?.({ rawText: text, parsed: result.parsed });
    } catch (error) {
      console.error('Failed to resolve nutrition line:', error);
      setParsed(null);
      setStatus(text.length > 0 ? 'typing' : 'empty');
    }
  };

  const handleSubmit = async (override?: string) => {
    const trimmed = (override ?? rawText).trim();
    if (!trimmed || isProcessing) return;
    if (override !== undefined) setRawText(trimmed);
    await submitVia(trimmed, () => onResolve(trimmed));
  };

  const handleBarcodeConfirm = async (line: string, macros: BarcodeMacros | null) => {
    const trimmed = line.trim();
    if (!trimmed || isProcessing) return;
    setRawText(trimmed);
    if (macros && onResolveBarcode) {
      // Exact macros from Open Food Facts — no AI parse, no meal quota.
      await submitVia(trimmed, () => onResolveBarcode({ rawText: trimmed, macros }));
    } else {
      await submitVia(trimmed, () => onResolve(trimmed));
    }
  };

  return (
    <>
    <View style={styles.card}>
      <View style={styles.row}>
        <TextInput
          ref={ref}
          style={[styles.input, { color: colors.text }]}
          placeholder={placeholder}
          placeholderTextColor={colors.textMuted}
          value={rawText}
          onChangeText={handleChangeText}
          onSubmitEditing={() => handleSubmit()}
          returnKeyType="done"
          blurOnSubmit
          multiline
        />

        {/* Photo meal logging — full-screen camera route ("Snap a Meal").
            The parent pre-gates quota before navigating. */}
        {onCameraPress && !isProcessing && !isResolved ? (
          <Pressable
            onPress={onCameraPress}
            hitSlop={10}
            accessibilityRole="button"
            accessibilityLabel="Snap a photo of your meal"
            style={({ pressed }) => [
              styles.barcodeButton,
              {
                backgroundColor: isDark ? 'rgba(255,255,255,0.10)' : 'rgba(11,18,32,0.06)',
                borderColor: isDark ? 'rgba(255,255,255,0.14)' : 'rgba(11,18,32,0.10)',
                transform: [{ scale: pressed ? 0.94 : 1 }],
              },
            ]}
          >
            <Ionicons name="camera-outline" size={20} color={colors.text} />
          </Pressable>
        ) : null}

        {/* Barcode scan — opens the camera, looks up the product on Open Food
            Facts, and writes a structured line into the input which we auto-
            submit through the same parse pipeline. No backend changes needed. */}
        {!isProcessing && !isResolved ? (
          <Pressable
            onPress={() => setScannerOpen(true)}
            hitSlop={10}
            accessibilityRole="button"
            accessibilityLabel="Scan barcode"
            style={({ pressed }) => [
              styles.barcodeButton,
              {
                backgroundColor: isDark ? 'rgba(255,255,255,0.10)' : 'rgba(11,18,32,0.06)',
                borderColor: isDark ? 'rgba(255,255,255,0.14)' : 'rgba(11,18,32,0.10)',
                transform: [{ scale: pressed ? 0.94 : 1 }],
              },
            ]}
          >
            <Ionicons name="barcode-outline" size={20} color={colors.text} />
          </Pressable>
        ) : null}

        <View style={styles.actionArea}>
          {isProcessing ? (
            <ActivityIndicator size="small" color={colors.textMuted} />
          ) : isResolved && parsed ? (
            <View style={styles.macroInline}>
              <Text style={[styles.macroInlineKcal, { color: colors.text }]}>
                {Math.round(parsed.calories)} kcal
              </Text>
              <Text style={[styles.macroInlineMacros, { color: colors.textMuted }]}>
                {Math.round(parsed.protein)}P · {Math.round(parsed.carbs)}C · {Math.round(parsed.fats)}F
              </Text>
            </View>
          ) : (
            <Pressable
              onPress={() => handleSubmit()}
              disabled={isEmpty}
              hitSlop={10}
              accessibilityRole="button"
              accessibilityLabel="Log meal"
              accessibilityState={{ disabled: isEmpty }}
              style={({ pressed }) => [
                styles.sendButton,
                {
                  backgroundColor: isEmpty ? colors.backgroundTertiary : colors.primary,
                  transform: [{ scale: pressed ? 0.94 : 1 }],
                  opacity: isEmpty ? 0.6 : 1,
                },
              ]}
            >
              <Ionicons
                name="arrow-up"
                size={18}
                color={isEmpty ? colors.textTertiary : '#FFFFFF'}
              />
            </Pressable>
          )}
        </View>
      </View>
    </View>
    <BarcodeScannerModal
      visible={scannerOpen}
      onClose={() => setScannerOpen(false)}
      onConfirm={(line, macros) => {
        setScannerOpen(false);
        void handleBarcodeConfirm(line, macros);
      }}
    />
    </>
  );
});

SmartLogLine.displayName = 'SmartLogLine';

const styles = StyleSheet.create({
  card: {
    paddingVertical: 4,
    backgroundColor: 'transparent',
  },
  row: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 12,
    minHeight: 44,
  },
  input: {
    fontSize: 15,
    fontFamily: 'Montserrat_400Regular',
    paddingVertical: 2,
    paddingHorizontal: 0,
    flex: 1,
    minHeight: 24,
    maxHeight: 100,
    backgroundColor: 'transparent',
  },
  actionArea: {
    minWidth: 36,
    alignItems: 'flex-end',
    justifyContent: 'center',
  },
  sendButton: {
    width: 36,
    height: 36,
    borderRadius: 20,
    alignItems: 'center',
    justifyContent: 'center',
  },
  barcodeButton: {
    width: 36,
    height: 36,
    borderRadius: 20,
    borderWidth: 1,
    alignItems: 'center',
    justifyContent: 'center',
  },
  macroInline: {
    alignItems: 'flex-end',
  },
  macroInlineKcal: {
    fontSize: 13,
    fontFamily: 'Montserrat_600SemiBold',
  },
  macroInlineMacros: {
    fontSize: 11,
    fontFamily: 'Montserrat_500Medium',
    marginTop: 1,
  },
});

export default SmartLogLine;
