import AsyncStorage from '@react-native-async-storage/async-storage';
import { Ionicons } from '@expo/vector-icons';
import { useQueryClient } from '@tanstack/react-query';
import { CameraView, useCameraPermissions } from 'expo-camera';
import * as Haptics from 'expo-haptics';
import { Image } from 'expo-image';
import { manipulateAsync, SaveFormat } from 'expo-image-manipulator';
import * as ImagePicker from 'expo-image-picker';
import { useLocalSearchParams, useRouter } from 'expo-router';
import React, { useCallback, useEffect, useRef, useState } from 'react';
import {
  ActivityIndicator,
  Keyboard,
  KeyboardAvoidingView,
  Linking,
  Platform,
  Pressable,
  StyleSheet,
  Text,
  TextInput,
  useWindowDimensions,
  View,
} from 'react-native';
import Animated, {
  Easing,
  FadeIn,
  useAnimatedStyle,
  useSharedValue,
  withRepeat,
  withTiming,
} from 'react-native-reanimated';
import { useSafeAreaInsets } from 'react-native-safe-area-context';

import BarcodeScannerModal from '../../components/nutrition/BarcodeScannerModal';
import PlateReviewSheet from '../../components/nutrition/PlateReviewSheet';
import { toast } from '../../components/ui/Toast';
import { getThemeColors } from '../../constants/theme';
import { useTheme } from '../../context/ThemeContext';
import { useProGate } from '../../hooks/useProGate';
import { useRequireAuth } from '../../hooks/useRequireAuth';
import {
  backendClient,
  isQuotaExceededError,
  type MealPhotoAnalysis,
  type MealPhotoItem,
} from '../../src/api/backendClient';
import { posthog } from '../../src/config/posthog';
import { usePhotoLogHandoff } from '../../stores/usePhotoLogHandoff';
import { supabase } from '../../utils/supabase';
import {
  captureMealWithDepth,
  isLiDARAvailable,
  type MealDepthMeta,
} from '../../modules/lift-depth-camera';

const TIPS_SEEN_KEY = '@meal_photo_tips_seen_v1';
const ANALYZE_LABELS = [
  'Looking at your plate…',
  'Identifying foods…',
  'Estimating portions…',
  'Counting the macros…',
];

type Phase = 'camera' | 'analyzing' | 'review' | 'failed';
type FailReason = 'no_food' | 'unclear' | 'error' | 'premium';

/**
 * Photo food logging ("Snap a Meal") — full-screen capture + Plate review.
 *
 * New scan:  ?date=YYYY-MM-DD   camera → analyze → PlateReviewSheet → confirm
 * Edit mode: ?logId=<uuid>      loads a saved photo log straight into the
 *                               Plate card; save updates the same row.
 *
 * The client-side quota pre-gate runs in the nutrition tab BEFORE navigating
 * here (don't let users take a photo they can't use); the server stays the
 * source of truth and a 429 here still routes to /quota-limit.
 */
export default function PhotoLogScreen() {
  const { isDark } = useTheme();
  const colors = getThemeColors(isDark);
  const insets = useSafeAreaInsets();
  const router = useRouter();
  const queryClient = useQueryClient();
  const { session } = useRequireAuth();
  const userId = session?.user?.id;
  const params = useLocalSearchParams<{ date?: string; logId?: string }>();
  const editLogId = typeof params.logId === 'string' && params.logId.length > 0 ? params.logId : null;
  const logDate = typeof params.date === 'string' ? params.date : undefined;

  const [permission, requestPermission] = useCameraPermissions();
  const cameraRef = useRef<CameraView>(null);

  // Snap-a-Meal is Pro-only. The gate deliberately sits AFTER capture (see
  // analyze()) so the paywall lands at the moment of desire, photo in hand.
  const { isPro, showPaywall } = useProGate();

  const [phase, setPhase] = useState<Phase>(editLogId ? 'review' : 'camera');
  const [failReason, setFailReason] = useState<FailReason>('error');
  const [captured, setCaptured] = useState<{ uri: string; base64: string } | null>(null);
  // LiDAR path (iPhone Pro): capture goes through the native depth camera
  // instead of expo-camera; the depth scale rides along to the analyzer.
  const [lidarSupported] = useState(() => isLiDARAvailable());
  const [depthMeta, setDepthMeta] = useState<MealDepthMeta | null>(null);
  const [caption, setCaption] = useState('');
  const [flash, setFlash] = useState<'off' | 'on'>('off');
  const [tipsVisible, setTipsVisible] = useState(false);
  const [capturing, setCapturing] = useState(false);
  const [analysis, setAnalysis] = useState<MealPhotoAnalysis | null>(null);
  const [fixCount, setFixCount] = useState(0);
  const [analyzeLabelIdx, setAnalyzeLabelIdx] = useState(0);
  const [scannerOpen, setScannerOpen] = useState(false);
  // Edit mode: hydrated from the saved log row.
  const [editSeed, setEditSeed] = useState<{
    mealName: string;
    items: MealPhotoItem[];
    photoUri: string | null;
  } | null>(null);

  // ── Permission auto-request + one-time tips ────────────────────────────────

  useEffect(() => {
    posthog.capture('meal_photo_opened', { mode: editLogId ? 'edit' : 'new' });
  }, [editLogId]);

  useEffect(() => {
    if (!editLogId && permission && !permission.granted && permission.canAskAgain) {
      void requestPermission();
    }
  }, [editLogId, permission, requestPermission]);

  useEffect(() => {
    if (editLogId) return;
    void AsyncStorage.getItem(TIPS_SEEN_KEY).then((seen) => {
      if (!seen) setTipsVisible(true);
    });
  }, [editLogId]);

  const dismissTips = useCallback(() => {
    setTipsVisible(false);
    void AsyncStorage.setItem(TIPS_SEEN_KEY, '1');
  }, []);

  // ── Edit mode hydration ────────────────────────────────────────────────────

  useEffect(() => {
    if (!editLogId || !userId) return;
    let cancelled = false;
    (async () => {
      const { data, error } = await supabase
        .from('nutrition_logs')
        .select('raw_text, items, image_path')
        .eq('id', editLogId)
        .eq('user_id', userId)
        .single();
      if (cancelled) return;
      // Cast through unknown: the generated DB types predate the photo
      // columns (source/image_path/items) added in migration 20260719010000.
      const row = data as unknown as {
        raw_text: string;
        items: MealPhotoItem[] | null;
        image_path: string | null;
      } | null;
      if (error || !row || !Array.isArray(row.items)) {
        toast.error("Couldn't open this meal");
        router.back();
        return;
      }
      let photoUri: string | null = null;
      if (row.image_path) {
        const { data: signed } = await supabase.storage
          .from('meal-photos')
          .createSignedUrl(row.image_path, 3600);
        photoUri = signed?.signedUrl ?? null;
      }
      if (cancelled) return;
      setEditSeed({ mealName: row.raw_text, items: row.items, photoUri });
    })();
    return () => {
      cancelled = true;
    };
  }, [editLogId, userId, router]);

  // ── Analyzing overlay: cycling labels + scan line ──────────────────────────

  useEffect(() => {
    if (phase !== 'analyzing') return;
    setAnalyzeLabelIdx(0);
    const timer = setInterval(
      () => setAnalyzeLabelIdx((i) => (i + 1) % ANALYZE_LABELS.length),
      1600
    );
    return () => clearInterval(timer);
  }, [phase]);

  const { height: windowHeight } = useWindowDimensions();
  const scanY = useSharedValue(0);
  useEffect(() => {
    if (phase === 'analyzing') {
      scanY.value = 0;
      scanY.value = withRepeat(
        withTiming(1, { duration: 1400, easing: Easing.inOut(Easing.quad) }),
        -1,
        true
      );
    }
  }, [phase, scanY]);
  const scanTravel = windowHeight * 0.72;
  const scanLineStyle = useAnimatedStyle(() => ({
    transform: [{ translateY: scanY.value * scanTravel }],
  }));

  // ── Capture / gallery / analyze ────────────────────────────────────────────

  /** Downscale to ≤1024px longest side, JPEG q0.7 → ~100–250 KB base64. */
  const compress = useCallback(
    async (uri: string, width: number, height: number) => {
      const longest = Math.max(width || 0, height || 0);
      const actions =
        longest > 1024
          ? [width >= height ? { resize: { width: 1024 } } : { resize: { height: 1024 } }]
          : [];
      const result = await manipulateAsync(uri, actions, {
        compress: 0.7,
        format: SaveFormat.JPEG,
        base64: true,
      });
      return { uri: result.uri, base64: result.base64 ?? '' };
    },
    []
  );

  const analyze = useCallback(
    async (
      image: { uri: string; base64: string },
      opts?: {
        fix?: { analysisId: string; note: string; prior: MealPhotoAnalysis };
        depth?: MealDepthMeta | null;
      }
    ) => {
      // Premium gate — after the shot, before any AI spend. The photo stays
      // in state, so upgrading flows straight into "Scan photo" on the same
      // capture. (Server enforces this too; this check just saves the trip.)
      if (!isPro) {
        posthog.capture('meal_photo_premium_gate_shown', { source: 'client' });
        setFailReason('premium');
        setPhase('failed');
        showPaywall('photo_logging');
        return;
      }
      setPhase('analyzing');
      Keyboard.dismiss();
      const startedAt = Date.now();
      // Prefer the depth passed with a fresh capture (state hasn't committed
      // yet on that first call); retries and fixes fall back to state.
      const depth = opts?.depth !== undefined ? opts.depth : depthMeta;
      try {
        const response = await backendClient.analyzeMealPhoto({
          image_base64: image.base64,
          caption: caption.trim() || undefined,
          date: logDate,
          depth: depth
            ? {
                lidar: true,
                subject_distance_cm: Math.round(depth.subjectDistanceCm),
                field_width_cm:
                  depth.fieldWidthCm != null ? Math.round(depth.fieldWidthCm) : null,
              }
            : undefined,
          fix: opts?.fix
            ? {
                analysis_id: opts.fix.analysisId,
                note: opts.fix.note,
                prior_result: opts.fix.prior,
              }
            : undefined,
        });
        const result = response.analysis;
        if (!response.success || !result) {
          throw new Error(response.error || 'analysis_failed');
        }
        if (result.photo_quality !== 'ok') {
          posthog.capture('meal_photo_failed', { reason: result.photo_quality });
          // Quota already refunded server-side for initial scans.
          setFailReason(result.photo_quality);
          setPhase('failed');
          return;
        }
        posthog.capture('meal_photo_analyzed', {
          latency_ms: Date.now() - startedAt,
          confidence: result.confidence,
          item_count: result.items.length,
          packaged: result.flags.packaged,
          blended: result.flags.blended,
          multi_plate: result.flags.multi_plate,
          is_fix: !!opts?.fix,
          has_depth: !!depth,
        });
        setAnalysis(result);
        if (opts?.fix) setFixCount((c) => c + 1);
        setPhase('review');
        void Haptics.impactAsync(Haptics.ImpactFeedbackStyle.Light);
      } catch (err) {
        // Server-side premium enforcement (defense in depth — normally the
        // client gate above fires first).
        if (err instanceof Error && err.message === 'premium_required') {
          posthog.capture('meal_photo_premium_gate_shown', { source: 'server' });
          setFailReason('premium');
          setPhase('failed');
          showPaywall('photo_logging');
          return;
        }
        if (isQuotaExceededError(err)) {
          router.replace({
            pathname: '/quota-limit',
            params: {
              feature: 'nutrition_ai',
              reason: err.reason ?? 'meal_limit',
              // Premium 12h soft-cap carries a reopen time — quota-limit
              // renders the countdown copy from it.
              ...(err.retry_at ? { retryAt: err.retry_at } : {}),
            },
          });
          return;
        }
        posthog.capture('meal_photo_failed', { reason: 'error' });
        if (opts?.fix) {
          // Keep the review sheet alive — the fix just didn't land.
          toast.error("Couldn't apply the fix", 'Adjust the items directly instead.');
          setPhase('review');
          return;
        }
        // Keep the captured photo so retry doesn't need a new shot.
        setFailReason('error');
        setPhase('failed');
      }
    },
    [caption, logDate, router, isPro, showPaywall, depthMeta]
  );

  const handleShutter = useCallback(async () => {
    if (capturing) return;
    // LiDAR devices: the native depth camera owns capture (its own
    // AVCaptureSession, not expo-camera). It returns the photo plus measured
    // scale; null means the user cancelled.
    if (lidarSupported) {
      setCapturing(true);
      try {
        const result = await captureMealWithDepth();
        if (!result?.uri) return;
        void Haptics.impactAsync(Haptics.ImpactFeedbackStyle.Medium);
        const image = await compress(result.uri, result.width ?? 0, result.height ?? 0);
        setCaptured(image);
        setDepthMeta(result.depth);
        posthog.capture('meal_photo_captured', {
          has_caption: caption.trim().length > 0,
          from_gallery: false,
          lidar: true,
          has_depth: !!result.depth,
        });
        await analyze(image, { depth: result.depth });
      } catch (err) {
        console.error('Depth capture failed:', err);
        toast.error("Couldn't take the photo", 'Try again.');
      } finally {
        setCapturing(false);
      }
      return;
    }

    if (!cameraRef.current) return;
    setCapturing(true);
    try {
      const photo = await cameraRef.current.takePictureAsync({ quality: 1 });
      if (!photo?.uri) throw new Error('no photo');
      void Haptics.impactAsync(Haptics.ImpactFeedbackStyle.Medium);
      const image = await compress(photo.uri, photo.width ?? 0, photo.height ?? 0);
      setCaptured(image);
      setDepthMeta(null);
      posthog.capture('meal_photo_captured', {
        has_caption: caption.trim().length > 0,
        from_gallery: false,
        lidar: false,
      });
      await analyze(image, { depth: null });
    } catch (err) {
      console.error('Capture failed:', err);
      toast.error("Couldn't take the photo", 'Try again.');
    } finally {
      setCapturing(false);
    }
  }, [capturing, compress, analyze, caption, lidarSupported]);

  const handlePickFromGallery = useCallback(async () => {
    if (capturing) return;
    try {
      const result = await ImagePicker.launchImageLibraryAsync({
        mediaTypes: ['images'],
        quality: 1,
      });
      const asset = result.assets?.[0];
      if (result.canceled || !asset?.uri) return;
      setCapturing(true);
      const image = await compress(asset.uri, asset.width ?? 0, asset.height ?? 0);
      setCaptured(image);
      setDepthMeta(null); // gallery photos have no depth
      posthog.capture('meal_photo_captured', {
        has_caption: caption.trim().length > 0,
        from_gallery: true,
      });
      await analyze(image, { depth: null });
    } catch (err) {
      console.error('Gallery pick failed:', err);
      toast.error("Couldn't load that photo");
    } finally {
      setCapturing(false);
    }
  }, [capturing, compress, analyze, caption]);

  const handleRetake = useCallback(() => {
    posthog.capture('meal_photo_retake');
    setAnalysis(null);
    setCaptured(null);
    setDepthMeta(null);
    setFixCount(0);
    setPhase('camera');
  }, []);

  const handleFix = useCallback(
    async (note: string) => {
      if (!captured || !analysis?.analysis_id) return;
      await analyze(captured, {
        fix: { analysisId: analysis.analysis_id, note, prior: analysis },
      });
    },
    [captured, analysis, analyze]
  );

  // ── Confirm ────────────────────────────────────────────────────────────────

  const handleLog = useCallback(
    async (payload: { mealName: string; items: Omit<MealPhotoItem, 'confidence'>[] }) => {
      try {
        const response = await backendClient.confirmMealPhoto({
          analysis_id: editLogId ? undefined : analysis?.analysis_id ?? undefined,
          log_id: editLogId ?? undefined,
          meal_name: payload.mealName,
          date: logDate,
          items: payload.items,
        });
        if (!response.success || !response.log) {
          throw new Error(response.error || 'Failed to save');
        }
        // Same invalidation as parseNutritionAndPersist — prefix-matches every
        // date/week so the new row and the week strip both refresh.
        queryClient.invalidateQueries({ queryKey: ['nutrition_logs'] });
        queryClient.invalidateQueries({ queryKey: ['nutrition_logs_week'] });

        // Un-fixed clarification → hand the pills to the meal list (PRD §4.5).
        if (!editLogId && analysis?.clarification && fixCount === 0) {
          usePhotoLogHandoff.getState().set({
            logId: response.log.id,
            clarification: analysis.clarification,
          });
        }

        posthog.capture('meal_photo_confirmed', {
          kcal: response.parsed?.calories ?? 0,
          item_count: payload.items.length,
          fix_count: fixCount,
          mode: editLogId ? 'edit' : 'new',
        });
        void Haptics.notificationAsync(Haptics.NotificationFeedbackType.Success);
        toast.success(
          editLogId ? 'Meal updated' : 'Meal logged',
          `${response.parsed?.calories ?? 0} kcal · ${response.parsed?.protein ?? 0}P · ${response.parsed?.carbs ?? 0}C · ${response.parsed?.fats ?? 0}F`
        );
        router.back();
      } catch (err) {
        console.error('Confirm failed:', err);
        toast.error("Couldn't save the meal", 'Your edits are still here — try again.');
      }
    },
    [analysis, editLogId, fixCount, logDate, queryClient, router]
  );

  // Packaged-food handoff: exact numbers via the existing barcode scanner
  // (free, no quota). Only offered when the model flagged a packaged product.
  const handleBarcodeConfirm = useCallback(
    async (line: string, macros: { calories: number; protein: number; carbs: number; fats: number } | null) => {
      setScannerOpen(false);
      if (!macros) {
        toast.info('No nutrition data for that barcode', 'Keeping the photo estimate.');
        return;
      }
      try {
        const response = await backendClient.logNutritionStructured({
          raw_text: line,
          ...macros,
          date: logDate,
        });
        if (!response.success) throw new Error(response.error || 'failed');
        queryClient.invalidateQueries({ queryKey: ['nutrition_logs'] });
        queryClient.invalidateQueries({ queryKey: ['nutrition_logs_week'] });
        posthog.capture('meal_photo_barcode_handoff');
        void Haptics.notificationAsync(Haptics.NotificationFeedbackType.Success);
        toast.success('Meal logged', `${Math.round(macros.calories)} kcal (barcode)`);
        router.back();
      } catch {
        toast.error("Couldn't save the barcode log");
      }
    },
    [logDate, queryClient, router]
  );

  const handleParseItem = useCallback(async (text: string): Promise<MealPhotoItem | null> => {
    try {
      const response = await backendClient.parseMealItem(text);
      return response.success && response.item ? response.item : null;
    } catch (err) {
      if (isQuotaExceededError(err)) {
        toast.error('Daily AI budget used up', 'Try again after the reset.');
      } else {
        toast.error("Couldn't parse that item");
      }
      return null;
    }
  }, []);

  const handleClose = useCallback(() => {
    router.back();
  }, [router]);

  // ── Render ─────────────────────────────────────────────────────────────────

  const isEdit = !!editLogId;
  const showCamera = !isEdit && phase === 'camera';
  const frozenUri = isEdit ? editSeed?.photoUri ?? null : captured?.uri ?? null;

  return (
    <View style={styles.container}>
      {/* Background: live camera, frozen capture, or dark backdrop.
          LiDAR devices never mount expo-camera here — the native depth
          capture (presented on shutter tap) needs sole ownership of the
          camera, so the stage behind the chrome is a static branded view. */}
      {showCamera && permission?.granted && lidarSupported ? (
        <View style={[StyleSheet.absoluteFill, styles.lidarStage]}>
          <View style={styles.lidarBadge}>
            <Ionicons name="scan-outline" size={15} color="#5AA6FF" />
            <Text style={styles.lidarBadgeText}>LiDAR depth scan</Text>
          </View>
          <Text style={styles.lidarStageText}>
            Tap the shutter to open the camera.{'\n'}Depth measures your portions for a sharper estimate.
          </Text>
        </View>
      ) : showCamera && permission?.granted ? (
        <CameraView
          ref={cameraRef}
          style={StyleSheet.absoluteFill}
          facing="back"
          flash={flash}
        />
      ) : frozenUri ? (
        <Image source={{ uri: frozenUri }} style={StyleSheet.absoluteFill} contentFit="cover" />
      ) : (
        <View style={[StyleSheet.absoluteFill, { backgroundColor: '#0B0F17' }]} />
      )}

      {/* Dim overlay for non-camera phases */}
      {phase !== 'camera' ? (
        <View style={[StyleSheet.absoluteFill, { backgroundColor: 'rgba(0,0,0,0.35)' }]} />
      ) : null}

      {/* Tapping anywhere outside the caption input dismisses the keyboard.
          Sits under the header/chrome (rendered later), so buttons still work. */}
      <Pressable
        style={StyleSheet.absoluteFill}
        onPress={Keyboard.dismiss}
        accessible={false}
        importantForAccessibility="no"
      />

      {/* Header */}
      <View style={[styles.header, { paddingTop: insets.top + 8 }]}>
        <Pressable
          onPress={handleClose}
          hitSlop={12}
          style={styles.headerBtn}
          accessibilityRole="button"
          accessibilityLabel="Close"
        >
          <Ionicons name="close" size={26} color="#FFFFFF" />
        </Pressable>
        <Text style={styles.headerTitle}>{isEdit ? 'Edit meal' : 'Snap a meal'}</Text>
        {showCamera && permission?.granted && !lidarSupported ? (
          <Pressable
            onPress={() => setFlash((f) => (f === 'off' ? 'on' : 'off'))}
            hitSlop={12}
            style={styles.headerBtn}
            accessibilityRole="button"
            accessibilityLabel={flash === 'off' ? 'Turn flash on' : 'Turn flash off'}
          >
            <Ionicons
              name={flash === 'off' ? 'flash-off-outline' : 'flash'}
              size={22}
              color={flash === 'on' ? '#2E90FA' : '#FFFFFF'}
            />
          </Pressable>
        ) : (
          <View style={styles.headerBtn} />
        )}
      </View>

      {/* ── Camera phase ── */}
      {showCamera ? (
        permission?.granted ? (
          <KeyboardAvoidingView
            style={styles.cameraChrome}
            behavior={Platform.OS === 'ios' ? 'padding' : undefined}
            pointerEvents="box-none"
          >
            {/* One-time photo tips */}
            {tipsVisible ? (
              <Animated.View entering={FadeIn} style={styles.tipsCard}>
                <Ionicons name="bulb-outline" size={16} color="#2E90FA" />
                <Text style={styles.tipsText}>
                  {lidarSupported
                    ? 'Aim straight down at your plate so the depth scan can size your portions.'
                    : 'Top-down or 45° works best. Get everything in frame — don’t stack food.'}
                </Text>
                <Pressable onPress={dismissTips} hitSlop={10} accessibilityLabel="Dismiss tips">
                  <Ionicons name="close" size={16} color="rgba(255,255,255,0.7)" />
                </Pressable>
              </Animated.View>
            ) : null}

            <View style={[styles.bottomChrome, { paddingBottom: insets.bottom + 18 }]}>
              {/* Optional caption — the single highest-leverage accuracy input */}
              <View style={styles.captionWrap}>
                <Ionicons name="chatbubble-ellipses-outline" size={15} color="rgba(255,255,255,0.6)" />
                <TextInput
                  style={styles.captionInput}
                  value={caption}
                  onChangeText={setCaption}
                  placeholder="Add a detail (optional) — “cooked in butter”"
                  placeholderTextColor="rgba(255,255,255,0.55)"
                  maxLength={200}
                  returnKeyType="done"
                />
              </View>

              <View style={styles.shutterRow}>
                <Pressable
                  onPress={handlePickFromGallery}
                  style={styles.sideBtn}
                  accessibilityRole="button"
                  accessibilityLabel="Choose from gallery"
                >
                  <Ionicons name="images-outline" size={24} color="#FFFFFF" />
                </Pressable>

                <Pressable
                  onPress={handleShutter}
                  disabled={capturing}
                  style={({ pressed }) => [
                    styles.shutterOuter,
                    { transform: [{ scale: pressed ? 0.94 : 1 }], opacity: capturing ? 0.6 : 1 },
                  ]}
                  accessibilityRole="button"
                  accessibilityLabel="Take photo"
                >
                  {capturing ? (
                    <ActivityIndicator color="#0B0F17" />
                  ) : (
                    <View style={styles.shutterInner} />
                  )}
                </Pressable>

                <View style={styles.sideBtn} />
              </View>
            </View>
          </KeyboardAvoidingView>
        ) : (
          // Permission denied / undetermined
          <View style={styles.permissionWrap}>
            <Ionicons name="camera-outline" size={48} color="rgba(255,255,255,0.6)" />
            <Text style={styles.permissionTitle}>Camera access needed</Text>
            <Text style={styles.permissionText}>
              Point your camera at your food and the AI logs calories and macros for you.
            </Text>
            <Pressable
              onPress={() =>
                permission?.canAskAgain ? void requestPermission() : void Linking.openSettings()
              }
              style={styles.permissionBtn}
              accessibilityRole="button"
            >
              <Text style={styles.permissionBtnText}>
                {permission?.canAskAgain ? 'Allow camera' : 'Open Settings'}
              </Text>
            </Pressable>
            <Pressable onPress={handlePickFromGallery} hitSlop={8} accessibilityRole="button">
              <Text style={styles.permissionAlt}>Or pick a photo from your library</Text>
            </Pressable>
          </View>
        )
      ) : null}

      {/* ── Analyzing phase ── */}
      {phase === 'analyzing' ? (
        <View style={styles.analyzeWrap} pointerEvents="none">
          <Animated.View style={[styles.scanLine, scanLineStyle]} />
          <View style={[styles.analyzeCard, { marginBottom: insets.bottom + 40 }]}>
            <ActivityIndicator color="#2E90FA" />
            <Animated.Text key={analyzeLabelIdx} entering={FadeIn} style={styles.analyzeLabel}>
              {ANALYZE_LABELS[analyzeLabelIdx]}
            </Animated.Text>
          </View>
        </View>
      ) : null}

      {/* ── Failed phase (no food / unclear / error) ── */}
      {phase === 'failed' ? (
        <View style={[styles.failWrap, { paddingBottom: insets.bottom + 24 }]}>
          {/* Opaque surface — the theme's alpha card token would be
              see-through over the captured photo behind this card. */}
          <View style={[styles.failCard, { backgroundColor: isDark ? '#12161D' : '#FFFFFF' }]}>
            <Ionicons
              name={
                failReason === 'premium'
                  ? 'sparkles'
                  : failReason === 'error'
                    ? 'cloud-offline-outline'
                    : 'search-outline'
              }
              size={34}
              color={failReason === 'premium' ? colors.primary : colors.textTertiary}
            />
            <Text style={[styles.failTitle, { color: colors.text }]}>
              {failReason === 'premium'
                ? 'Snap-a-Meal is a Pro feature'
                : failReason === 'no_food'
                  ? "Couldn't find food in this shot"
                  : failReason === 'unclear'
                    ? 'Too dark or blurry to read'
                    : "Couldn't reach the AI"}
            </Text>
            <Text style={[styles.failText, { color: colors.textTertiary }]}>
              {failReason === 'premium'
                ? "Your photo's ready — unlock Pro and it becomes itemized calories and macros in seconds."
                : failReason === 'error'
                  ? 'Your photo is saved — try again without retaking.'
                  : "No worries — nothing was used from today's allowance."}
            </Text>
            <View style={styles.failActions}>
              {failReason === 'premium' ? (
                // After an upgrade, isPro flips and the same button becomes
                // "Scan photo" — the captured shot is still in state.
                <Pressable
                  onPress={() => {
                    if (isPro && captured) {
                      void analyze(captured);
                    } else {
                      posthog.capture('meal_photo_premium_cta_tapped');
                      showPaywall('photo_logging');
                    }
                  }}
                  style={[styles.failPrimaryBtn, { backgroundColor: colors.text }]}
                  accessibilityRole="button"
                >
                  <Text style={[styles.failPrimaryText, { color: colors.background }]}>
                    {isPro && captured ? 'Scan photo' : 'Unlock Pro'}
                  </Text>
                </Pressable>
              ) : failReason === 'error' && captured ? (
                <Pressable
                  onPress={() => void analyze(captured)}
                  style={[styles.failPrimaryBtn, { backgroundColor: colors.text }]}
                  accessibilityRole="button"
                >
                  <Text style={[styles.failPrimaryText, { color: colors.background }]}>Try again</Text>
                </Pressable>
              ) : (
                <Pressable
                  onPress={handleRetake}
                  style={[styles.failPrimaryBtn, { backgroundColor: colors.text }]}
                  accessibilityRole="button"
                >
                  <Text style={[styles.failPrimaryText, { color: colors.background }]}>Retake</Text>
                </Pressable>
              )}
              <Pressable
                onPress={failReason === 'error' ? handleRetake : handleClose}
                style={[styles.failSecondaryBtn, { borderColor: colors.border }]}
                accessibilityRole="button"
              >
                <Text style={[styles.failSecondaryText, { color: colors.text }]}>
                  {failReason === 'error' ? 'Retake' : 'Type it instead'}
                </Text>
              </Pressable>
            </View>
          </View>
        </View>
      ) : null}

      {/* ── Review phase: the Plate card ── */}
      {phase === 'review' && !isEdit && analysis ? (
        <PlateReviewSheet
          mode="new"
          photoUri={captured?.uri ?? null}
          mealName={analysis.meal_name ?? 'Meal'}
          items={analysis.items}
          confidence={analysis.confidence}
          clarification={analysis.clarification}
          flags={analysis.flags}
          fixesRemaining={analysis.fixes_remaining}
          onLog={handleLog}
          onRetake={handleRetake}
          onFix={handleFix}
          onScanBarcode={() => setScannerOpen(true)}
          onParseItem={handleParseItem}
          onEdited={(type) => posthog.capture('meal_photo_edited', { edit_type: type })}
        />
      ) : null}
      {phase === 'review' && isEdit ? (
        editSeed ? (
          <PlateReviewSheet
            mode="edit"
            photoUri={editSeed.photoUri}
            mealName={editSeed.mealName}
            items={editSeed.items}
            confidence="high"
            clarification={null}
            flags={{ packaged: false, blended: false, multi_plate: false }}
            fixesRemaining={0}
            onLog={handleLog}
            onRetake={handleClose}
            onParseItem={handleParseItem}
            onEdited={(type) => posthog.capture('meal_photo_edited', { edit_type: type, mode: 'edit' })}
          />
        ) : (
          <View style={styles.editLoading}>
            <ActivityIndicator color="#2E90FA" />
          </View>
        )
      ) : null}

      <BarcodeScannerModal
        visible={scannerOpen}
        onClose={() => setScannerOpen(false)}
        onConfirm={(line, macros) => void handleBarcodeConfirm(line, macros)}
      />
    </View>
  );
}

// ── Styles ─────────────────────────────────────────────────────────────────

const styles = StyleSheet.create({
  container: { flex: 1, backgroundColor: '#000' },

  header: {
    position: 'absolute',
    top: 0,
    left: 0,
    right: 0,
    zIndex: 10,
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'space-between',
    paddingHorizontal: 16,
  },
  headerBtn: { width: 36, height: 36, alignItems: 'center', justifyContent: 'center' },
  headerTitle: {
    fontSize: 16,
    fontFamily: 'Montserrat_700Bold',
    color: '#FFFFFF',
    textShadowColor: 'rgba(0,0,0,0.5)',
    textShadowRadius: 6,
  },

  cameraChrome: { flex: 1, justifyContent: 'flex-end' },
  lidarStage: {
    backgroundColor: '#0B0F17',
    alignItems: 'center',
    justifyContent: 'center',
    gap: 14,
  },
  lidarBadge: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 7,
    borderWidth: 1,
    borderColor: 'rgba(46,144,250,0.4)',
    backgroundColor: 'rgba(46,144,250,0.10)',
    borderRadius: 999,
    paddingVertical: 8,
    paddingHorizontal: 16,
  },
  lidarBadgeText: {
    color: '#5AA6FF',
    fontSize: 12,
    fontFamily: 'Montserrat_700Bold',
    letterSpacing: 0.6,
  },
  lidarStageText: {
    color: 'rgba(255,255,255,0.6)',
    fontSize: 13,
    fontFamily: 'Montserrat_500Medium',
    textAlign: 'center',
    lineHeight: 19,
    paddingHorizontal: 40,
  },
  tipsCard: {
    position: 'absolute',
    top: 110,
    left: 20,
    right: 20,
    flexDirection: 'row',
    alignItems: 'center',
    gap: 8,
    backgroundColor: 'rgba(11,15,23,0.78)',
    borderColor: 'rgba(255,255,255,0.14)',
    borderWidth: StyleSheet.hairlineWidth,
    borderRadius: 14,
    paddingHorizontal: 12,
    paddingVertical: 10,
  },
  tipsText: {
    flex: 1,
    color: 'rgba(255,255,255,0.92)',
    fontSize: 12,
    fontFamily: 'Montserrat_500Medium',
    lineHeight: 17,
  },

  bottomChrome: { paddingHorizontal: 20, gap: 14 },
  captionWrap: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 8,
    backgroundColor: 'rgba(11,15,23,0.72)',
    borderColor: 'rgba(255,255,255,0.14)',
    borderWidth: StyleSheet.hairlineWidth,
    borderRadius: 999,
    paddingHorizontal: 14,
    paddingVertical: 10,
  },
  captionInput: {
    flex: 1,
    color: '#FFFFFF',
    fontSize: 13,
    fontFamily: 'Montserrat_500Medium',
    padding: 0,
  },
  shutterRow: { flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between' },
  sideBtn: { width: 52, height: 52, alignItems: 'center', justifyContent: 'center' },
  shutterOuter: {
    width: 74,
    height: 74,
    borderRadius: 37,
    backgroundColor: '#FFFFFF',
    borderWidth: 4,
    borderColor: 'rgba(255,255,255,0.35)',
    alignItems: 'center',
    justifyContent: 'center',
  },
  shutterInner: {
    width: 60,
    height: 60,
    borderRadius: 30,
    borderWidth: 2,
    borderColor: '#0B0F17',
  },

  permissionWrap: { flex: 1, alignItems: 'center', justifyContent: 'center', padding: 32, gap: 12 },
  permissionTitle: { fontSize: 17, fontFamily: 'Montserrat_700Bold', color: '#FFFFFF' },
  permissionText: {
    fontSize: 13,
    fontFamily: 'Montserrat_400Regular',
    color: 'rgba(255,255,255,0.7)',
    textAlign: 'center',
    lineHeight: 19,
  },
  permissionBtn: {
    backgroundColor: '#2E90FA',
    borderRadius: 12,
    paddingVertical: 13,
    paddingHorizontal: 28,
    marginTop: 8,
  },
  permissionBtnText: { color: '#FFFFFF', fontSize: 15, fontFamily: 'Montserrat_700Bold' },
  permissionAlt: {
    color: 'rgba(255,255,255,0.75)',
    fontSize: 13,
    fontFamily: 'Montserrat_600SemiBold',
    marginTop: 8,
    textDecorationLine: 'underline',
  },

  analyzeWrap: { ...StyleSheet.absoluteFillObject, alignItems: 'center', justifyContent: 'flex-end' },
  scanLine: {
    position: 'absolute',
    top: '10%',
    left: 24,
    right: 24,
    height: 2,
    borderRadius: 1,
    backgroundColor: '#2E90FA',
    shadowColor: '#2E90FA',
    shadowOpacity: 0.9,
    shadowRadius: 8,
    shadowOffset: { width: 0, height: 0 },
  },
  analyzeCard: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 10,
    backgroundColor: 'rgba(11,15,23,0.85)',
    borderColor: 'rgba(255,255,255,0.14)',
    borderWidth: StyleSheet.hairlineWidth,
    borderRadius: 999,
    paddingHorizontal: 18,
    paddingVertical: 12,
  },
  analyzeLabel: { color: '#FFFFFF', fontSize: 13, fontFamily: 'Montserrat_600SemiBold' },

  failWrap: { flex: 1, justifyContent: 'flex-end', paddingHorizontal: 16 },
  failCard: {
    borderRadius: 24,
    padding: 24,
    alignItems: 'center',
    gap: 8,
  },
  failTitle: { fontSize: 17, fontFamily: 'Montserrat_700Bold', textAlign: 'center' },
  failText: {
    fontSize: 13,
    fontFamily: 'Montserrat_400Regular',
    textAlign: 'center',
    lineHeight: 19,
  },
  failActions: { flexDirection: 'row', gap: 10, marginTop: 12, alignSelf: 'stretch' },
  failPrimaryBtn: {
    flex: 1,
    borderRadius: 12,
    paddingVertical: 14,
    alignItems: 'center',
  },
  failPrimaryText: { fontSize: 14, fontFamily: 'Montserrat_700Bold' },
  failSecondaryBtn: {
    flex: 1,
    borderRadius: 12,
    paddingVertical: 14,
    alignItems: 'center',
    borderWidth: 1,
  },
  failSecondaryText: { fontSize: 14, fontFamily: 'Montserrat_600SemiBold' },

  editLoading: { ...StyleSheet.absoluteFillObject, alignItems: 'center', justifyContent: 'center' },
});
