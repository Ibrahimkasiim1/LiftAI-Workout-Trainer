// components/paywall/ConversionPaywall.tsx
//
// LiftAI's native paywall: an auto-advancing feature carousel with a sticky
// plan selector and CTA. Replaces the RevenueCat template paywall — purchases
// still go through the RevenueCat SDK (`Purchases.purchasePackage`), so
// entitlements, the webhook → Supabase tier sync, and restore flows are
// untouched.
//
// Context-aware: the slide for the feature the user just tried to use is
// shown first (see paywallSlides.getSlidesForContext). Every meaningful step
// is captured in PostHog so gate-level conversion is finally measurable.
//
// Remote iteration without app releases: the optional PostHog feature-flag
// payload `paywall_config` may contain { "preselect": "MONTHLY",
// "lead_slide": "coach" } to override the preselected plan / default lead
// slide for experiments. Context-specific lead slides always win over the
// flag — relevance beats experiments.

import { Ionicons } from '@expo/vector-icons';
import React, { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import {
    ActivityIndicator,
    FlatList,
    Image,
    Linking,
    StyleSheet,
    Text,
    TouchableOpacity,
    View,
    ViewToken,
    useWindowDimensions,
} from 'react-native';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import Purchases, { PurchasesPackage } from 'react-native-purchases';

import { useSubscription } from '../../context/SubscriptionContext';
import { posthog } from '../../src/config/posthog';
import { toast } from '../ui/Toast';
import {
    PaywallSlide,
    PaywallSlideId,
    getSlidesForContext,
} from './paywallSlides';

const TERMS_URL = 'https://liftaiapp.com/terms.html';
const PRIVACY_URL = 'https://liftaiapp.com/privacy.html';

const BLUE = '#2E90FA';
const BLUE_LIGHT = '#5AA6FF';
const AUTO_ADVANCE_MS = 3500;
const PAYWALL_VARIANT = 'native_carousel_v2';

export interface ConversionPaywallResult {
    purchased: boolean;
    restored: boolean;
    cancelled: boolean;
}

interface Props {
    /** GatedFeature or PaywallSource — decides which slide leads. */
    contextKey: string;
    /** 'hard' delays the close button a beat; both modes stay dismissible. */
    mode?: 'soft' | 'hard';
    /** Optional outcome line shown above the carousel (onboarding). */
    outcomeHeadline?: string;
    onResult: (result: ConversionPaywallResult) => void;
}

// ---------------------------------------------------------------------------
// Pricing helpers
// ---------------------------------------------------------------------------

/** Approximate weeks covered by each RevenueCat package type. */
const WEEKS_PER_PACKAGE: Record<string, number> = {
    ANNUAL: 52,
    SIX_MONTH: 26,
    THREE_MONTH: 13,
    TWO_MONTH: 8.7,
    MONTHLY: 4.33,
    WEEKLY: 1,
};

const PACKAGE_TITLES: Record<string, string> = {
    ANNUAL: 'Yearly',
    SIX_MONTH: '6 Months',
    THREE_MONTH: '3 Months',
    TWO_MONTH: '2 Months',
    MONTHLY: 'Monthly',
    WEEKLY: 'Weekly',
    LIFETIME: 'Lifetime',
};

const PERIOD_SUFFIX: Record<string, string> = {
    ANNUAL: '/yr',
    SIX_MONTH: '/6 mo',
    THREE_MONTH: '/3 mo',
    TWO_MONTH: '/2 mo',
    MONTHLY: '/mo',
    WEEKLY: '/wk',
};

/** "$59.99" → "$"; falls back to the currency code. */
function currencySymbol(priceString: string, currencyCode: string): string {
    const symbol = priceString.replace(/[\d.,\s]/g, '');
    return symbol || `${currencyCode} `;
}

function formatAmount(amount: number, symbol: string): string {
    return `${symbol}${amount.toFixed(2)}`;
}

interface PlanOption {
    pkg: PurchasesPackage;
    title: string;
    /** e.g. "$59.99/yr" */
    priceLine: string;
    /** e.g. "$1.15/wk" — the anchoring line. Null for lifetime. */
    perWeekLine: string | null;
    /** e.g. "$0.16" — the daily cost, the strongest "basically nothing" anchor. */
    perDayLine: string | null;
    /** e.g. "SAVE 62%" on the best-value plan. */
    badge: string | null;
    trialDays: number | null;
}

function trialDaysOf(pkg: PurchasesPackage): number | null {
    const intro = pkg.product.introPrice;
    if (!intro || intro.price !== 0) return null;
    const units = intro.periodNumberOfUnits;
    switch (intro.periodUnit) {
        case 'DAY': return units;
        case 'WEEK': return units * 7;
        case 'MONTH': return units * 30;
        case 'YEAR': return units * 365;
        default: return null;
    }
}

function buildPlanOptions(packages: PurchasesPackage[]): PlanOption[] {
    const known = packages.filter((p) => PACKAGE_TITLES[p.packageType]);
    const usable = known.length > 0 ? known : packages;

    // Longest commitment first — annual on top is the standard anchor layout.
    const order = ['LIFETIME', 'ANNUAL', 'SIX_MONTH', 'THREE_MONTH', 'TWO_MONTH', 'MONTHLY', 'WEEKLY'];
    const sorted = [...usable].sort(
        (a, b) => order.indexOf(a.packageType) - order.indexOf(b.packageType)
    );

    const perWeek = (p: PurchasesPackage): number | null => {
        const weeks = WEEKS_PER_PACKAGE[p.packageType];
        return weeks ? p.product.price / weeks : null;
    };

    // Savings vs the most expensive per-week rate among the other plans.
    const rates = sorted
        .map((p) => ({ p, rate: perWeek(p) }))
        .filter((x): x is { p: PurchasesPackage; rate: number } => x.rate != null);
    const maxRate = rates.length > 1 ? Math.max(...rates.map((x) => x.rate)) : null;

    return sorted.map((pkg) => {
        const symbol = currencySymbol(pkg.product.priceString, pkg.product.currencyCode);
        const rate = perWeek(pkg);
        let badge: string | null = null;
        if (maxRate && rate != null && rate < maxRate) {
            const pct = Math.round((1 - rate / maxRate) * 100);
            if (pct >= 10) badge = `BEST VALUE · SAVE ${pct}%`;
        }
        // Prefer RevenueCat's locale-formatted per-week string: it uses the
        // storefront's currency formatter, so symbol placement, decimal
        // separator, and decimal count are right per country (e.g. "1,15 €",
        // "¥150" with no decimals). Fall back to the manual format only when
        // the SDK omits it.
        const showPerWeek = rate != null && pkg.packageType !== 'WEEKLY';
        const perWeekAmount =
            pkg.product.pricePerWeekString ?? (rate != null ? formatAmount(rate, symbol) : null);
        return {
            pkg,
            title: PACKAGE_TITLES[pkg.packageType] ?? pkg.product.title,
            priceLine: `${pkg.product.priceString}${PERIOD_SUFFIX[pkg.packageType] ?? ''}`,
            perWeekLine: showPerWeek && perWeekAmount ? `${perWeekAmount}/wk` : null,
            perDayLine: rate != null ? formatAmount(rate / 7, symbol) : null,
            badge,
            trialDays: trialDaysOf(pkg),
        };
    });
}

// ---------------------------------------------------------------------------
// Component
// ---------------------------------------------------------------------------

export default function ConversionPaywall({
    contextKey,
    mode = 'soft',
    outcomeHeadline,
    onResult,
}: Props) {
    const { width, height } = useWindowDimensions();
    const insets = useSafeAreaInsets();

    // Shrink the slide visual on shorter screens so the plan selector, CTA,
    // and footer always fit without scrolling. Visuals are authored at 230pt.
    // The outcome headline is the hero on onboarding, so it borrows more
    // vertical space from the carousel visual.
    const visualHeight = Math.max(130, Math.min(230, height * 0.26 - (outcomeHeadline ? 56 : 0)));
    const visualScale = visualHeight / 230;
    const compact = height < 750;
    const {
        currentOffering,
        refreshOfferings,
        restorePurchases,
        checkSubscription,
        revenueCatUsable,
    } = useSubscription();

    // --- Remote config (PostHog flag payload, optional) -------------------
    const flagConfig = useMemo(() => {
        try {
            const payload = posthog.getFeatureFlagPayload('paywall_config');
            if (payload && typeof payload === 'object') {
                return payload as { preselect?: string; lead_slide?: PaywallSlideId };
            }
        } catch { /* flags unavailable — use defaults */ }
        return {};
    }, []);

    // --- Slides: context lead wins; the experiment flag only sets the
    // default order for contexts without a specific feature.
    const slides = useMemo<PaywallSlide[]>(
        () => getSlidesForContext(contextKey, flagConfig.lead_slide ?? null),
        [contextKey, flagConfig.lead_slide]
    );

    // --- Plans ---------------------------------------------------------------
    const [offeringsFailed, setOfferingsFailed] = useState(false);
    const plans = useMemo(
        () => (currentOffering ? buildPlanOptions(currentOffering.availablePackages) : []),
        [currentOffering]
    );
    const [selectedId, setSelectedId] = useState<string | null>(null);

    useEffect(() => {
        if (!currentOffering && revenueCatUsable) {
            refreshOfferings().catch(() => setOfferingsFailed(true));
        }
    }, [currentOffering, revenueCatUsable, refreshOfferings]);

    // Don't leave the user staring at a spinner if offerings never arrive —
    // flip to the retry state so the screen always has a way forward.
    useEffect(() => {
        if (plans.length > 0) return;
        const t = setTimeout(() => setOfferingsFailed(true), 12_000);
        return () => clearTimeout(t);
    }, [plans.length]);

    // Preselect: flag override → annual → first plan.
    useEffect(() => {
        if (plans.length === 0 || selectedId) return;
        const preferred =
            (flagConfig.preselect && plans.find((p) => p.pkg.packageType === flagConfig.preselect)) ||
            plans.find((p) => p.pkg.packageType === 'ANNUAL') ||
            plans[0];
        setSelectedId(preferred.pkg.identifier);
    }, [plans, selectedId, flagConfig.preselect]);

    const selectedPlan = plans.find((p) => p.pkg.identifier === selectedId) ?? null;

    // --- Trial eligibility ----------------------------------------------------
    // A lapsed subscriber who already consumed the intro offer must NOT see
    // "Start My 7-Day Free Trial" — StoreKit would charge them immediately
    // (refund requests + App Review 3.1.2 risk). Consumed-trial ineligibility
    // is reported deterministically from the receipt as INELIGIBLE, so only
    // that status hides the trial; UNKNOWN (no readable receipt — in this
    // funnel, overwhelmingly fresh installs) keeps the trial copy, and the
    // StoreKit payment sheet always shows the true terms either way.
    const [ineligibleProductIds, setIneligibleProductIds] = useState<Set<string>>(new Set());
    useEffect(() => {
        const trialProductIds = plans
            .filter((p) => p.trialDays != null)
            .map((p) => p.pkg.product.identifier);
        if (trialProductIds.length === 0 || !revenueCatUsable) return;
        let cancelled = false;
        void (async () => {
            try {
                const eligibility = await Purchases.checkTrialOrIntroductoryPriceEligibility(trialProductIds);
                if (cancelled) return;
                const ineligible = new Set(
                    Object.entries(eligibility)
                        .filter(([, e]) =>
                            e.status === Purchases.INTRO_ELIGIBILITY_STATUS.INTRO_ELIGIBILITY_STATUS_INELIGIBLE)
                        .map(([id]) => id)
                );
                if (ineligible.size > 0) setIneligibleProductIds(ineligible);
            } catch {
                // Eligibility unavailable — keep the default (trial) copy.
            }
        })();
        return () => { cancelled = true; };
    }, [plans, revenueCatUsable]);

    const isTrialEligible = (plan: PlanOption) =>
        !ineligibleProductIds.has(plan.pkg.product.identifier);

    // --- Analytics bookkeeping ----------------------------------------------
    const mountedAtRef = useRef(Date.now());
    const slidesSeenRef = useRef<Set<PaywallSlideId>>(new Set([slides[0]?.id].filter(Boolean) as PaywallSlideId[]));
    const resultSentRef = useRef(false);

    const secondsOnScreen = () => Math.round((Date.now() - mountedAtRef.current) / 1000);

    useEffect(() => {
        posthog.capture('paywall_viewed', {
            context: contextKey,
            mode,
            variant: PAYWALL_VARIANT,
            first_slide: slides[0]?.id,
        });
        // Intentionally once per presentation.
        // eslint-disable-next-line react-hooks/exhaustive-deps
    }, []);

    const finish = useCallback(
        (result: ConversionPaywallResult) => {
            if (resultSentRef.current) return;
            resultSentRef.current = true;
            if (result.cancelled) {
                posthog.capture('paywall_dismissed', {
                    context: contextKey,
                    variant: PAYWALL_VARIANT,
                    seconds_on_screen: secondsOnScreen(),
                    slides_seen: slidesSeenRef.current.size,
                    selected_package_type: selectedPlan?.pkg.packageType ?? null,
                });
            }
            onResult(result);
        },
        [contextKey, onResult, selectedPlan]
    );

    // --- Carousel ------------------------------------------------------------
    const listRef = useRef<FlatList<PaywallSlide>>(null);
    const indexRef = useRef(0);
    const [activeIndex, setActiveIndex] = useState(0);
    const autoAdvancePausedRef = useRef(false);

    useEffect(() => {
        const timer = setInterval(() => {
            if (autoAdvancePausedRef.current || slides.length < 2) return;
            const next = (indexRef.current + 1) % slides.length;
            listRef.current?.scrollToOffset({ offset: next * width, animated: true });
        }, AUTO_ADVANCE_MS);
        return () => clearInterval(timer);
    }, [slides.length, width]);

    const onViewableItemsChanged = useRef(
        ({ viewableItems }: { viewableItems: ViewToken[] }) => {
            const visible = viewableItems.find((v) => v.isViewable);
            if (visible?.index == null) return;
            indexRef.current = visible.index;
            setActiveIndex(visible.index);
            const slide = visible.item as PaywallSlide;
            if (!slidesSeenRef.current.has(slide.id)) {
                slidesSeenRef.current.add(slide.id);
                posthog.capture('paywall_slide_viewed', {
                    slide_id: slide.id,
                    index: visible.index,
                    context: contextKey,
                });
            }
        }
    );
    const viewabilityConfig = useRef({ itemVisiblePercentThreshold: 60 });

    // --- Close affordance ------------------------------------------------------
    const [closeVisible, setCloseVisible] = useState(mode === 'soft');
    useEffect(() => {
        if (mode === 'hard') {
            const t = setTimeout(() => setCloseVisible(true), 2500);
            return () => clearTimeout(t);
        }
    }, [mode]);

    // --- Purchase / restore -----------------------------------------------------
    const [purchasing, setPurchasing] = useState(false);
    const [restoring, setRestoring] = useState(false);
    // Purchase/restore feedback rendered INSIDE the paywall. Toasts mount in
    // the root layout, and on iOS this paywall is presented in a native RN
    // Modal that sits above them — so any toast fired here is invisible and
    // a failed purchase looks like "tapped, nothing happened".
    const [notice, setNotice] = useState<{ kind: 'error' | 'info'; text: string } | null>(null);

    const handleSelectPlan = (plan: PlanOption) => {
        setSelectedId(plan.pkg.identifier);
        setNotice(null);
        posthog.capture('plan_selected', {
            context: contextKey,
            package_type: plan.pkg.packageType,
            product_id: plan.pkg.product.identifier,
        });
    };

    const handlePurchase = async () => {
        if (!selectedPlan || purchasing) return;
        setNotice(null);
        setPurchasing(true);
        autoAdvancePausedRef.current = true;
        const { pkg } = selectedPlan;
        posthog.capture('purchase_started', {
            context: contextKey,
            package_type: pkg.packageType,
            product_id: pkg.product.identifier,
            price: pkg.product.price,
            currency: pkg.product.currencyCode,
        });
        try {
            await Purchases.purchasePackage(pkg);
            await checkSubscription(true);
            const props = {
                context: contextKey,
                package_type: pkg.packageType,
                product_id: pkg.product.identifier,
                price: pkg.product.price,
                currency: pkg.product.currencyCode,
                seconds_on_screen: secondsOnScreen(),
                variant: PAYWALL_VARIANT,
            };
            posthog.capture('purchase_completed', props);
            // Legacy event name kept so existing dashboards keep working.
            posthog.capture('subscription_purchased', { context: contextKey });
            finish({ purchased: true, restored: false, cancelled: false });
        } catch (e: any) {
            if (e?.userCancelled) {
                posthog.capture('purchase_failed', { context: contextKey, reason: 'cancelled' });
            } else {
                posthog.capture('purchase_failed', {
                    context: contextKey,
                    reason: e?.message ?? 'unknown',
                });
                setNotice({
                    kind: 'error',
                    text: `Purchase failed — nothing was charged. ${e?.message ? String(e.message) : 'Please try again.'}`,
                });
            }
        } finally {
            setPurchasing(false);
        }
    };

    const handleRestore = async () => {
        if (restoring) return;
        setNotice(null);
        setRestoring(true);
        try {
            const result = await restorePurchases();
            if (result.success && result.isSubscribed) {
                posthog.capture('purchases_restored', { context: contextKey });
                // Toast is fine here — the paywall closes, so the root-level
                // toast host is visible again by the time it shows.
                toast.success('Purchases restored', 'Your Pro access is active.');
                finish({ purchased: false, restored: true, cancelled: false });
                return;
            }
            if (result.success) {
                setNotice({
                    kind: 'info',
                    text: 'No active subscription found for this Apple ID.',
                });
            } else {
                setNotice({ kind: 'error', text: `Restore failed. ${result.error || 'Please try again.'}` });
            }
        } catch (e: any) {
            // Without this, a throw from restorePurchases leaves the user with
            // a spinner that just stops and no explanation.
            posthog.capture('purchases_restore_failed', {
                context: contextKey,
                reason: e?.message ?? 'unknown',
            });
            setNotice({ kind: 'error', text: 'Restore failed. Check your connection and try again.' });
        } finally {
            setRestoring(false);
        }
    };

    // --- CTA copy -----------------------------------------------------------------
    // Two jobs here: make the free trial impossible to miss ("nothing to
    // lose"), and shrink the price to its daily cost — the number that makes
    // the commitment feel like pocket change.
    const trialDays =
        selectedPlan && isTrialEligible(selectedPlan) ? selectedPlan.trialDays : null;
    const perDay = selectedPlan?.perDayLine ?? null;
    // No-trial label must read unmistakably as a PURCHASE — a bare "Continue"
    // was being tapped by users expecting to continue on the free plan.
    const ctaLabel = trialDays
        ? `Start My ${trialDays}-Day Free Trial`
        : 'Unlock Pro';
    // Both variants must state auto-renewal explicitly (App Review 3.1.2).
    const disclosure = selectedPlan
        ? trialDays
            ? `${trialDays} days free, then ${selectedPlan.priceLine}${perDay ? ` (about ${perDay} a day)` : ''}. Auto-renews, cancel anytime.`
            : `${selectedPlan.priceLine}${perDay ? `, about ${perDay} a day` : ''}. Auto-renews, cancel anytime.`
        : ' ';

    // --- Render ------------------------------------------------------------------
    const renderSlide = ({ item }: { item: PaywallSlide }) => (
        <View style={[styles.slide, { width }]}>
            {/* Visuals are authored at a 230pt stage; scale them into the
                space this screen actually has so nothing pushes off-screen. */}
            <View style={{ height: visualHeight, justifyContent: 'center' }}>
                <View style={{ transform: [{ scale: visualScale }] }}>
                    {item.renderVisual()}
                </View>
            </View>
            <Text style={[styles.slideHeadline, compact && styles.slideHeadlineCompact]}>
                {item.headline}
            </Text>
            <Text style={styles.slideSub} numberOfLines={2}>{item.sub}</Text>
        </View>
    );

    const plansUnavailable = !revenueCatUsable || offeringsFailed;

    return (
        <View
            style={[
                styles.container,
                {
                    paddingTop: Math.max(insets.top, 16),
                    paddingBottom: Math.max(insets.bottom, 16),
                },
            ]}
        >
            {/* Header */}
            <View style={styles.header}>
                <Image
                    source={require('../../img/Logo/White-Logo.png')}
                    style={styles.brandLogo}
                />

                {closeVisible && (
                    <TouchableOpacity
                        style={[styles.closeBtn, (purchasing || restoring) && styles.closeBtnDisabled]}
                        onPress={() => finish({ purchased: false, restored: false, cancelled: true })}
                        // Never dismissible mid-transaction: closing while the
                        // StoreKit sheet is up would navigate the decline path
                        // while the purchase may still complete — the user
                        // pays and sees the free flow.
                        disabled={purchasing || restoring}
                        accessibilityRole="button"
                        accessibilityState={{ disabled: purchasing || restoring }}
                        accessibilityLabel="Close paywall"
                        hitSlop={{ top: 12, bottom: 12, left: 12, right: 12 }}
                    >
                        <Ionicons name="close" size={20} color="rgba(255,255,255,0.55)" />
                    </TouchableOpacity>
                )}
            </View>

            {/* Social proof — a 5-star row right under the header. */}
            <View style={styles.starsRow}>
                {[0, 1, 2, 3, 4].map((i) => (
                    <Ionicons key={i} name="star" size={13} color={BLUE_LIGHT} />
                ))}
                <Text style={styles.starsText}>5-star rated</Text>
            </View>

            {/* Onboarding leads with the user's own outcome — the headline is
                the hero, the carousel is supporting evidence below it. */}
            {outcomeHeadline ? (
                <Text style={styles.outcomeHeadline}>{outcomeHeadline}</Text>
            ) : null}

            {/* Feature carousel */}
            <View style={styles.carouselWrap}>
                <FlatList
                    ref={listRef}
                    data={slides}
                    keyExtractor={(s) => s.id}
                    renderItem={renderSlide}
                    horizontal
                    pagingEnabled
                    showsHorizontalScrollIndicator={false}
                    onScrollBeginDrag={() => { autoAdvancePausedRef.current = true; }}
                    onViewableItemsChanged={onViewableItemsChanged.current}
                    viewabilityConfig={viewabilityConfig.current}
                    getItemLayout={(_, i) => ({ length: width, offset: width * i, index: i })}
                />
                <View style={styles.dotsRow}>
                    {slides.map((s, i) => (
                        <View
                            key={s.id}
                            style={[
                                styles.dot,
                                i === activeIndex && styles.dotActive,
                            ]}
                        />
                    ))}
                </View>
            </View>

            {/* Sticky purchase area */}
            <View style={styles.purchaseArea}>
                {plansUnavailable ? (
                    <View style={styles.plansFallback}>
                        <Text style={styles.plansFallbackText}>
                            Plans are unavailable right now. Check your connection and try again.
                        </Text>
                        <TouchableOpacity
                            style={styles.retryBtn}
                            onPress={() => {
                                setOfferingsFailed(false);
                                refreshOfferings().catch(() => setOfferingsFailed(true));
                            }}
                        >
                            <Text style={styles.retryBtnText}>Retry</Text>
                        </TouchableOpacity>
                    </View>
                ) : plans.length === 0 ? (
                    <View style={styles.plansLoading}>
                        <ActivityIndicator size="small" color={BLUE} />
                    </View>
                ) : (
                    <View style={styles.planList}>
                        {plans.map((plan) => {
                            const selected = plan.pkg.identifier === selectedId;
                            return (
                                <TouchableOpacity
                                    key={plan.pkg.identifier}
                                    style={[styles.planRow, selected && styles.planRowSelected]}
                                    onPress={() => handleSelectPlan(plan)}
                                    activeOpacity={0.85}
                                >
                                    {plan.badge && (
                                        <View style={styles.planBadge}>
                                            <Text style={styles.planBadgeText}>{plan.badge}</Text>
                                        </View>
                                    )}
                                    <View style={[styles.radio, selected && styles.radioSelected]}>
                                        {selected && <View style={styles.radioInner} />}
                                    </View>
                                    <View style={styles.planTitleCol}>
                                        <Text style={styles.planTitle}>{plan.title}</Text>
                                        {plan.trialDays && isTrialEligible(plan) ? (
                                            <Text style={styles.planTrial}>{plan.trialDays}-day free trial</Text>
                                        ) : null}
                                    </View>
                                    <View style={styles.planPriceCol}>
                                        <Text style={styles.planPrice}>{plan.priceLine}</Text>
                                        {plan.perWeekLine && (
                                            <Text style={styles.planPerWeek}>
                                                {/* Annual anchors on the daily cost — the
                                                    smallest honest number we can show. */}
                                                {plan.pkg.packageType === 'ANNUAL' && plan.perDayLine
                                                    ? `${plan.perDayLine}/day`
                                                    : plan.perWeekLine}
                                            </Text>
                                        )}
                                    </View>
                                </TouchableOpacity>
                            );
                        })}
                    </View>
                )}

                {notice ? (
                    <View style={styles.noticeRow}>
                        <Ionicons
                            name={notice.kind === 'error' ? 'alert-circle' : 'information-circle'}
                            size={14}
                            color={notice.kind === 'error' ? '#F97066' : BLUE_LIGHT}
                        />
                        <Text
                            style={[styles.noticeText, notice.kind === 'error' && styles.noticeTextError]}
                        >
                            {notice.text}
                        </Text>
                    </View>
                ) : null}

                <TouchableOpacity
                    style={[styles.cta, (!selectedPlan || purchasing || plansUnavailable) && styles.ctaDisabled]}
                    onPress={handlePurchase}
                    disabled={!selectedPlan || purchasing || plansUnavailable}
                    activeOpacity={0.85}
                >
                    {purchasing ? (
                        <ActivityIndicator size="small" color="#000000" />
                    ) : (
                        <Text style={styles.ctaText}>{ctaLabel}</Text>
                    )}
                </TouchableOpacity>
                <Text style={styles.disclosure}>{disclosure}</Text>

                {/* Explicit stay-on-free escape hatch — dismisses the paywall
                    and returns to where the user came from. Gated on the same
                    visibility as the X so hard mode keeps its delay. */}
                {closeVisible && (
                    <TouchableOpacity
                        onPress={() => finish({ purchased: false, restored: false, cancelled: true })}
                        disabled={purchasing}
                        hitSlop={{ top: 8, bottom: 8 }}
                        accessibilityRole="button"
                        accessibilityLabel="Continue with the free plan"
                        style={styles.continueFreeBtn}
                    >
                        <Text style={styles.continueFreeText}>Continue free</Text>
                    </TouchableOpacity>
                )}

                <View style={styles.footerRow}>
                    <TouchableOpacity onPress={handleRestore} disabled={restoring || purchasing} hitSlop={{ top: 8, bottom: 8 }}>
                        {restoring ? (
                            <ActivityIndicator size="small" color={BLUE_LIGHT} />
                        ) : (
                            <Text style={styles.footerLink}>Restore</Text>
                        )}
                    </TouchableOpacity>
                    <Text style={styles.footerDot}>·</Text>
                    <TouchableOpacity onPress={() => Linking.openURL(TERMS_URL)} hitSlop={{ top: 8, bottom: 8 }}>
                        <Text style={styles.footerLink}>Terms</Text>
                    </TouchableOpacity>
                    <Text style={styles.footerDot}>·</Text>
                    <TouchableOpacity onPress={() => Linking.openURL(PRIVACY_URL)} hitSlop={{ top: 8, bottom: 8 }}>
                        <Text style={styles.footerLink}>Privacy</Text>
                    </TouchableOpacity>
                </View>
            </View>
        </View>
    );
}

// ---------------------------------------------------------------------------
// Styles — the paywall is intentionally always dark: black stage, blue glow
// accents, monochrome (white) CTA per the design system.
// ---------------------------------------------------------------------------

const styles = StyleSheet.create({
    container: {
        flex: 1,
        backgroundColor: '#000000',
    },
    header: {
        flexDirection: 'row',
        alignItems: 'center',
        justifyContent: 'space-between',
        paddingHorizontal: 20,
        paddingTop: 8,
        minHeight: 36,
    },
    brandLogo: {
        width: 84,
        height: 30,
        resizeMode: 'contain',
    },
    closeBtn: {
        width: 30,
        height: 30,
        borderRadius: 999,
        backgroundColor: 'rgba(255,255,255,0.08)',
        alignItems: 'center',
        justifyContent: 'center',
    },
    closeBtnDisabled: {
        opacity: 0.35,
    },
    starsRow: {
        flexDirection: 'row',
        alignItems: 'center',
        justifyContent: 'center',
        gap: 3,
        marginTop: 6,
    },
    starsText: {
        fontFamily: 'Montserrat_600SemiBold',
        fontSize: 12,
        color: 'rgba(255,255,255,0.65)',
        marginLeft: 5,
    },
    outcomeHeadline: {
        fontFamily: 'Montserrat_700Bold',
        fontSize: 26,
        lineHeight: 33,
        color: '#FFFFFF',
        textAlign: 'center',
        paddingHorizontal: 24,
        marginTop: 12,
    },
    carouselWrap: {
        flex: 1,
        justifyContent: 'center',
        paddingTop: 8,
        overflow: 'hidden',
    },
    slide: {
        alignItems: 'center',
        justifyContent: 'center',
        paddingHorizontal: 28,
    },
    slideHeadline: {
        fontFamily: 'Montserrat_700Bold',
        fontSize: 21,
        lineHeight: 28,
        color: '#FFFFFF',
        textAlign: 'center',
        marginTop: 14,
    },
    slideHeadlineCompact: {
        fontSize: 18,
        lineHeight: 24,
        marginTop: 8,
    },
    slideSub: {
        fontFamily: 'Montserrat_500Medium',
        fontSize: 13.5,
        lineHeight: 20,
        color: 'rgba(255,255,255,0.55)',
        textAlign: 'center',
        marginTop: 8,
        maxWidth: 320,
    },
    dotsRow: {
        flexDirection: 'row',
        justifyContent: 'center',
        gap: 7,
        marginTop: 14,
    },
    dot: {
        width: 6,
        height: 6,
        borderRadius: 999,
        backgroundColor: 'rgba(255,255,255,0.22)',
    },
    dotActive: {
        backgroundColor: BLUE,
        width: 18,
    },
    purchaseArea: {
        paddingHorizontal: 20,
        paddingTop: 16,
    },
    plansLoading: {
        height: 150,
        alignItems: 'center',
        justifyContent: 'center',
    },
    plansFallback: {
        height: 150,
        alignItems: 'center',
        justifyContent: 'center',
        gap: 12,
        paddingHorizontal: 16,
    },
    plansFallbackText: {
        fontFamily: 'Montserrat_500Medium',
        fontSize: 13,
        lineHeight: 19,
        color: 'rgba(255,255,255,0.55)',
        textAlign: 'center',
    },
    retryBtn: {
        borderWidth: 1,
        borderColor: 'rgba(255,255,255,0.25)',
        borderRadius: 999,
        paddingVertical: 8,
        paddingHorizontal: 24,
    },
    retryBtnText: {
        fontFamily: 'Montserrat_600SemiBold',
        fontSize: 13,
        color: '#FFFFFF',
    },
    planList: {
        gap: 10,
    },
    planRow: {
        flexDirection: 'row',
        alignItems: 'center',
        gap: 12,
        borderWidth: 1.5,
        borderColor: 'rgba(255,255,255,0.14)',
        borderRadius: 16,
        paddingVertical: 13,
        paddingHorizontal: 16,
    },
    planRowSelected: {
        borderColor: BLUE,
        backgroundColor: 'rgba(46,144,250,0.08)',
    },
    planBadge: {
        position: 'absolute',
        top: -9,
        right: 14,
        backgroundColor: BLUE,
        borderRadius: 8,
        paddingHorizontal: 8,
        paddingVertical: 2.5,
    },
    planBadgeText: {
        fontFamily: 'Montserrat_700Bold',
        fontSize: 9,
        letterSpacing: 0.6,
        color: '#FFFFFF',
    },
    radio: {
        width: 20,
        height: 20,
        borderRadius: 999,
        borderWidth: 1.5,
        borderColor: 'rgba(255,255,255,0.35)',
        alignItems: 'center',
        justifyContent: 'center',
    },
    radioSelected: {
        borderColor: BLUE,
    },
    radioInner: {
        width: 10,
        height: 10,
        borderRadius: 999,
        backgroundColor: BLUE,
    },
    planTitleCol: {
        flex: 1,
    },
    planTitle: {
        fontFamily: 'Montserrat_600SemiBold',
        fontSize: 15,
        color: '#FFFFFF',
    },
    planTrial: {
        fontFamily: 'Montserrat_500Medium',
        fontSize: 11.5,
        color: BLUE_LIGHT,
        marginTop: 2,
    },
    planPriceCol: {
        alignItems: 'flex-end',
    },
    planPrice: {
        fontFamily: 'Montserrat_700Bold',
        fontSize: 15,
        color: '#FFFFFF',
    },
    planPerWeek: {
        fontFamily: 'Montserrat_500Medium',
        fontSize: 11.5,
        color: 'rgba(255,255,255,0.45)',
        marginTop: 2,
    },
    cta: {
        backgroundColor: '#FFFFFF',
        borderRadius: 16,
        paddingVertical: 16,
        alignItems: 'center',
        justifyContent: 'center',
        marginTop: 14,
        minHeight: 54,
    },
    ctaDisabled: {
        opacity: 0.5,
    },
    ctaText: {
        fontFamily: 'Montserrat_700Bold',
        fontSize: 16,
        color: '#000000',
    },
    disclosure: {
        fontFamily: 'Montserrat_500Medium',
        fontSize: 11.5,
        color: 'rgba(255,255,255,0.45)',
        textAlign: 'center',
        marginTop: 10,
        minHeight: 14,
    },
    noticeRow: {
        flexDirection: 'row',
        alignItems: 'center',
        justifyContent: 'center',
        gap: 6,
        marginBottom: 8,
        paddingHorizontal: 8,
    },
    noticeText: {
        fontFamily: 'Montserrat_600SemiBold',
        fontSize: 12,
        color: 'rgba(255,255,255,0.75)',
        flexShrink: 1,
        textAlign: 'center',
    },
    noticeTextError: {
        color: '#F97066',
    },
    continueFreeBtn: {
        alignSelf: 'center',
        marginTop: 8,
        paddingVertical: 4,
        paddingHorizontal: 12,
    },
    continueFreeText: {
        fontFamily: 'Montserrat_600SemiBold',
        fontSize: 13.5,
        color: 'rgba(255,255,255,0.65)',
        textDecorationLine: 'underline',
    },
    footerRow: {
        flexDirection: 'row',
        alignItems: 'center',
        justifyContent: 'center',
        gap: 10,
        marginTop: 10,
        paddingBottom: 4,
    },
    footerLink: {
        fontFamily: 'Montserrat_500Medium',
        fontSize: 12.5,
        color: 'rgba(255,255,255,0.55)',
    },
    footerDot: {
        color: 'rgba(255,255,255,0.3)',
        fontSize: 12,
    },
});
