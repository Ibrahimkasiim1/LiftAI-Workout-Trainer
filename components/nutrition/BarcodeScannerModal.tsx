import { Ionicons } from '@expo/vector-icons';
import { CameraView, useCameraPermissions } from 'expo-camera';
import * as Haptics from 'expo-haptics';
import React, { useCallback, useEffect, useRef, useState } from 'react';
import {
  ActivityIndicator,
  Modal,
  Pressable,
  StyleSheet,
  Text,
  View,
} from 'react-native';
import { useSafeAreaInsets } from 'react-native-safe-area-context';

import { getThemeColors } from '../../constants/theme';
import { useTheme } from '../../context/ThemeContext';

// ── Open Food Facts ────────────────────────────────────────────────────────────
// Free, no-key API. ~3M products. We pull just enough to render a confirmation
// card and build a natural-language line for the existing nutrition logger.

type OFFProduct = {
  name: string;
  brand: string | null;
  servingText: string | null;  // e.g. "330 ml" or "30 g"
  servingGrams: number | null; // numeric quantity when parseable
  kcalPerServing: number | null;
  proteinPerServing: number | null;
  carbsPerServing: number | null;
  fatsPerServing: number | null;
};

async function fetchOpenFoodFacts(barcode: string): Promise<OFFProduct | null> {
  try {
    const url = `https://world.openfoodfacts.org/api/v2/product/${barcode}.json?fields=product_name,brands,serving_size,serving_quantity,nutriments`;
    const res = await fetch(url, { headers: { 'User-Agent': 'LiftAI/1.0' } });
    if (!res.ok) return null;
    const json = await res.json();
    if (json.status !== 1 || !json.product) return null;
    const p = json.product;
    const n = p.nutriments ?? {};
    const servingGrams =
      typeof p.serving_quantity === 'number'
        ? p.serving_quantity
        : typeof p.serving_quantity === 'string'
          ? parseFloat(p.serving_quantity)
          : null;
    return {
      name: p.product_name || 'Unknown product',
      brand: p.brands || null,
      servingText: p.serving_size || null,
      servingGrams: Number.isFinite(servingGrams) ? servingGrams : null,
      kcalPerServing: numOrNull(n['energy-kcal_serving'] ?? n.energy_kcal_serving),
      proteinPerServing: numOrNull(n.proteins_serving),
      carbsPerServing: numOrNull(n.carbohydrates_serving),
      fatsPerServing: numOrNull(n.fat_serving),
    };
  } catch {
    return null;
  }
}

function numOrNull(v: unknown): number | null {
  const n = typeof v === 'number' ? v : typeof v === 'string' ? parseFloat(v) : NaN;
  return Number.isFinite(n) ? n : null;
}

// Build a single natural-language line the existing logger AI can parse. We
// include the macros inline when we have them — most LLMs will respect numbers
// given directly, which keeps the parse accurate (and cheap).
function buildLogLine(product: OFFProduct, servings: number): string {
  const label = [product.brand, product.name].filter(Boolean).join(' ').trim() || 'product';
  const servingPart = product.servingText
    ? `${servings} × ${product.servingText} serving${servings > 1 ? 's' : ''} of ${label}`
    : `${servings} serving${servings > 1 ? 's' : ''} of ${label}`;
  const macros: string[] = [];
  if (product.kcalPerServing != null) macros.push(`${Math.round(product.kcalPerServing * servings)} kcal`);
  if (product.proteinPerServing != null) macros.push(`${round1(product.proteinPerServing * servings)}g protein`);
  if (product.carbsPerServing != null) macros.push(`${round1(product.carbsPerServing * servings)}g carbs`);
  if (product.fatsPerServing != null) macros.push(`${round1(product.fatsPerServing * servings)}g fat`);
  return macros.length > 0 ? `${servingPart} (${macros.join(', ')})` : servingPart;
}

function round1(n: number): number {
  return Math.round(n * 10) / 10;
}

// ── Component ──────────────────────────────────────────────────────────────────

/** Exact macros for the scanned product × servings, when OFF had complete
 *  per-serving data. Lets the logger skip the AI parse (and its quota). */
export type BarcodeMacros = {
  calories: number;
  protein: number;
  carbs: number;
  fats: number;
};

type Props = {
  visible: boolean;
  onClose: () => void;
  onConfirm: (logLine: string, macros: BarcodeMacros | null) => void;
};

type Phase = 'scanning' | 'looking-up' | 'confirm' | 'not-found';

export default function BarcodeScannerModal({ visible, onClose, onConfirm }: Props) {
  const { isDark } = useTheme();
  const colors = getThemeColors(isDark);
  const insets = useSafeAreaInsets();
  const [permission, requestPermission] = useCameraPermissions();

  const [phase, setPhase] = useState<Phase>('scanning');
  const [scannedCode, setScannedCode] = useState<string | null>(null);
  const [product, setProduct] = useState<OFFProduct | null>(null);
  const [servings, setServings] = useState(1);
  // Guard against expo-camera firing onBarcodeScanned multiple times in quick
  // succession for the same code while we're processing the first hit.
  const lockedRef = useRef(false);

  useEffect(() => {
    if (!visible) {
      setPhase('scanning');
      setScannedCode(null);
      setProduct(null);
      setServings(1);
      lockedRef.current = false;
    }
  }, [visible]);

  useEffect(() => {
    if (visible && permission && !permission.granted && permission.canAskAgain) {
      requestPermission();
    }
  }, [visible, permission, requestPermission]);

  const handleScan = useCallback(async ({ data }: { data: string }) => {
    if (lockedRef.current) return;
    lockedRef.current = true;
    setScannedCode(data);
    setPhase('looking-up');
    void Haptics.impactAsync(Haptics.ImpactFeedbackStyle.Medium);
    const result = await fetchOpenFoodFacts(data);
    if (result) {
      setProduct(result);
      setPhase('confirm');
    } else {
      setPhase('not-found');
    }
  }, []);

  const handleConfirm = () => {
    if (!product) return;
    // Complete per-serving data → exact macros; the logger can persist them
    // deterministically. Any gap (kcal missing etc.) → null, AI parse fallback.
    const macros: BarcodeMacros | null =
      product.kcalPerServing != null &&
      product.proteinPerServing != null &&
      product.carbsPerServing != null &&
      product.fatsPerServing != null
        ? {
            calories: round1(product.kcalPerServing * servings),
            protein: round1(product.proteinPerServing * servings),
            carbs: round1(product.carbsPerServing * servings),
            fats: round1(product.fatsPerServing * servings),
          }
        : null;
    onConfirm(buildLogLine(product, servings), macros);
    onClose();
  };

  const handleRescan = () => {
    setScannedCode(null);
    setProduct(null);
    setServings(1);
    setPhase('scanning');
    lockedRef.current = false;
  };

  return (
    <Modal
      visible={visible}
      animationType="slide"
      presentationStyle="fullScreen"
      onRequestClose={onClose}
    >
      <View style={[styles.container, { backgroundColor: colors.background }]}>
        {/* Header */}
        <View style={[styles.header, { paddingTop: insets.top + 8 }]}>
          <Pressable onPress={onClose} hitSlop={12} style={styles.headerBtn} accessibilityLabel="Close scanner">
            <Ionicons name="close" size={26} color={colors.text} />
          </Pressable>
          <Text style={[styles.headerTitle, { color: colors.text }]}>Scan barcode</Text>
          <View style={styles.headerBtn} />
        </View>

        {/* Camera / phase content */}
        {!permission ? (
          <View style={styles.centered}>
            <ActivityIndicator color={colors.primary} />
          </View>
        ) : !permission.granted ? (
          <View style={styles.centered}>
            <Ionicons name="camera-outline" size={48} color={colors.textTertiary} />
            <Text style={[styles.permissionTitle, { color: colors.text }]}>
              Camera access needed
            </Text>
            <Text style={[styles.permissionText, { color: colors.textTertiary }]}>
              Grant camera permission to scan barcodes on packaged foods.
            </Text>
            <Pressable
              onPress={requestPermission}
              style={[styles.permissionBtn, { backgroundColor: colors.primary }]}
            >
              <Text style={styles.primaryBtnText}>Allow camera</Text>
            </Pressable>
          </View>
        ) : (
          <View style={styles.cameraWrap}>
            {phase === 'scanning' ? (
              <CameraView
                style={StyleSheet.absoluteFill}
                facing="back"
                barcodeScannerSettings={{
                  barcodeTypes: ['ean13', 'ean8', 'upc_a', 'upc_e', 'code128'],
                }}
                onBarcodeScanned={handleScan}
              />
            ) : null}

            {/* Reticle overlay (purely cosmetic) */}
            {phase === 'scanning' ? (
              <View pointerEvents="none" style={styles.reticleWrap}>
                <View style={styles.reticle} />
                <Text style={styles.reticleHint}>Align barcode within the frame</Text>
              </View>
            ) : null}

            {/* Confirmation / states card */}
            {phase !== 'scanning' ? (
              <View style={[styles.sheet, { backgroundColor: colors.backgroundSecondary, paddingBottom: insets.bottom + 24 }]}>
                {phase === 'looking-up' ? (
                  <View style={styles.sheetCentered}>
                    <ActivityIndicator color={colors.primary} />
                    <Text style={[styles.sheetMuted, { color: colors.textMuted }]}>
                      Looking up {scannedCode}…
                    </Text>
                  </View>
                ) : phase === 'not-found' ? (
                  <>
                    <Text style={[styles.sheetTitle, { color: colors.text }]}>
                      Product not found
                    </Text>
                    <Text style={[styles.sheetMuted, { color: colors.textMuted }]}>
                      Barcode {scannedCode} isn’t in the Open Food Facts database. Try another item or type the meal in manually.
                    </Text>
                    <View style={styles.sheetActions}>
                      <Pressable onPress={handleRescan} style={[styles.secondaryBtn, { borderColor: colors.border }]}>
                        <Text style={[styles.secondaryBtnText, { color: colors.text }]}>Try again</Text>
                      </Pressable>
                      <Pressable onPress={onClose} style={[styles.primaryBtn, { backgroundColor: colors.primary }]}>
                        <Text style={styles.primaryBtnText}>Close</Text>
                      </Pressable>
                    </View>
                  </>
                ) : product ? (
                  <>
                    <Text style={[styles.sheetTitle, { color: colors.text }]} numberOfLines={2}>
                      {product.brand ? `${product.brand} · ` : ''}{product.name}
                    </Text>
                    {product.servingText ? (
                      <Text style={[styles.sheetMuted, { color: colors.textMuted }]}>
                        Serving: {product.servingText}
                      </Text>
                    ) : null}

                    {/* Macros preview */}
                    <View style={styles.macrosRow}>
                      <MacroCell label="kcal" value={mul(product.kcalPerServing, servings)} colors={colors} />
                      <MacroCell label="P" value={mul(product.proteinPerServing, servings, 1)} colors={colors} />
                      <MacroCell label="C" value={mul(product.carbsPerServing, servings, 1)} colors={colors} />
                      <MacroCell label="F" value={mul(product.fatsPerServing, servings, 1)} colors={colors} />
                    </View>

                    {/* Servings stepper */}
                    <View style={[styles.stepperRow, { borderColor: colors.border }]}>
                      <Text style={[styles.stepperLabel, { color: colors.textMuted }]}>Servings</Text>
                      <View style={styles.stepperControls}>
                        <Pressable
                          onPress={() => setServings((s) => Math.max(1, +(s - 0.5).toFixed(1)))}
                          hitSlop={10}
                          style={[styles.stepperBtn, { backgroundColor: colors.backgroundTertiary }]}
                        >
                          <Ionicons name="remove" size={18} color={colors.text} />
                        </Pressable>
                        <Text style={[styles.stepperValue, { color: colors.text }]}>{servings}</Text>
                        <Pressable
                          onPress={() => setServings((s) => +(s + 0.5).toFixed(1))}
                          hitSlop={10}
                          style={[styles.stepperBtn, { backgroundColor: colors.backgroundTertiary }]}
                        >
                          <Ionicons name="add" size={18} color={colors.text} />
                        </Pressable>
                      </View>
                    </View>

                    <View style={styles.sheetActions}>
                      <Pressable onPress={handleRescan} style={[styles.secondaryBtn, { borderColor: colors.border }]}>
                        <Text style={[styles.secondaryBtnText, { color: colors.text }]}>Rescan</Text>
                      </Pressable>
                      <Pressable onPress={handleConfirm} style={[styles.primaryBtn, { backgroundColor: colors.primary }]}>
                        <Text style={styles.primaryBtnText}>Log meal</Text>
                      </Pressable>
                    </View>
                  </>
                ) : null}
              </View>
            ) : null}
          </View>
        )}
      </View>
    </Modal>
  );
}

function mul(v: number | null, mult: number, decimals = 0): string {
  if (v == null) return '—';
  const r = v * mult;
  return decimals === 0 ? `${Math.round(r)}` : `${Math.round(r * 10) / 10}`;
}

function MacroCell({ label, value, colors }: { label: string; value: string; colors: ReturnType<typeof getThemeColors> }) {
  return (
    <View style={[styles.macroCell, { backgroundColor: colors.backgroundTertiary }]}>
      <Text style={[styles.macroValue, { color: colors.text }]}>{value}</Text>
      <Text style={[styles.macroLabel, { color: colors.textMuted }]}>{label}</Text>
    </View>
  );
}

// ── Styles ─────────────────────────────────────────────────────────────────────

const styles = StyleSheet.create({
  container: { flex: 1 },
  header: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'space-between',
    paddingHorizontal: 16,
    paddingBottom: 12,
  },
  headerBtn: { width: 32, height: 32, alignItems: 'center', justifyContent: 'center' },
  headerTitle: { fontSize: 16, fontFamily: 'Montserrat_700Bold' },
  centered: { flex: 1, alignItems: 'center', justifyContent: 'center', padding: 32, gap: 12 },
  permissionTitle: { fontSize: 17, fontFamily: 'Montserrat_700Bold', marginTop: 8 },
  permissionText: { fontSize: 13, fontFamily: 'Montserrat_400Regular', textAlign: 'center', lineHeight: 19 },

  cameraWrap: { flex: 1, backgroundColor: '#000' },
  reticleWrap: { ...StyleSheet.absoluteFillObject, alignItems: 'center', justifyContent: 'center' },
  reticle: {
    width: 260,
    height: 160,
    borderWidth: 2,
    borderColor: '#FFFFFF',
    borderRadius: 20,
    backgroundColor: 'transparent',
  },
  reticleHint: {
    marginTop: 16,
    color: '#FFFFFF',
    fontSize: 13,
    fontFamily: 'Montserrat_500Medium',
    textShadowColor: 'rgba(0,0,0,0.6)',
    textShadowRadius: 4,
  },

  sheet: {
    position: 'absolute',
    left: 0,
    right: 0,
    bottom: 0,
    paddingHorizontal: 20,
    paddingTop: 20,
    borderTopLeftRadius: 24,
    borderTopRightRadius: 24,
    gap: 16,
  },
  sheetCentered: { alignItems: 'center', gap: 12, paddingVertical: 16 },
  sheetTitle: { fontSize: 17, fontFamily: 'Montserrat_700Bold' },
  sheetMuted: { fontSize: 13, fontFamily: 'Montserrat_500Medium', lineHeight: 18 },

  macrosRow: { flexDirection: 'row', gap: 8 },
  macroCell: { flex: 1, borderRadius: 12, paddingVertical: 12, alignItems: 'center', gap: 2 },
  macroValue: { fontSize: 16, fontFamily: 'Montserrat_700Bold', fontVariant: ['tabular-nums'] },
  macroLabel: { fontSize: 10, fontFamily: 'Montserrat_500Medium' },

  stepperRow: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'space-between',
    borderWidth: 1,
    borderRadius: 12,
    paddingHorizontal: 16,
    paddingVertical: 12,
  },
  stepperLabel: { fontSize: 13, fontFamily: 'Montserrat_600SemiBold' },
  stepperControls: { flexDirection: 'row', alignItems: 'center', gap: 16 },
  stepperBtn: { width: 30, height: 30, borderRadius: 16, alignItems: 'center', justifyContent: 'center' },
  stepperValue: {
    fontSize: 16,
    fontFamily: 'Montserrat_700Bold',
    fontVariant: ['tabular-nums'],
    minWidth: 36,
    textAlign: 'center',
  },

  sheetActions: { flexDirection: 'row', gap: 12, marginTop: 4 },
  primaryBtn: {
    flex: 1,
    borderRadius: 12,
    paddingVertical: 16,
    alignItems: 'center',
  },
  permissionBtn: {
    alignSelf: 'center',
    borderRadius: 12,
    paddingVertical: 12,
    paddingHorizontal: 28,
    alignItems: 'center',
    marginTop: 12,
  },
  primaryBtnText: { color: '#FFFFFF', fontSize: 15, fontFamily: 'Montserrat_700Bold' },
  secondaryBtn: {
    flex: 1,
    borderRadius: 12,
    paddingVertical: 16,
    alignItems: 'center',
    borderWidth: 1,
  },
  secondaryBtnText: { fontSize: 15, fontFamily: 'Montserrat_600SemiBold' },
});
