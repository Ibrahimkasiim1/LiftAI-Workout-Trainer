// app/quota-limit.tsx
//
// Native form-sheet shown when the backend returns 429 for a quota-gated AI
// action (presented with system detents/grabber — see app/_layout.tsx).
// Pushed by components/QuotaLimitSheet.tsx; `feature` param decides which
// slide leads the ConversionPaywall when the user taps the CTA.
//
// A limit hit is the highest-intent conversion moment in the app — the copy
// frames it as momentum, not punishment.

import { Ionicons } from '@expo/vector-icons';
import { useLocalSearchParams, useRouter } from 'expo-router';
import React, { useEffect, useState } from 'react';
import { StyleSheet, Text, TouchableOpacity, View } from 'react-native';

import { getThemeColors } from '../constants/theme';
import { useSubscription } from '../context/SubscriptionContext';
import { useTheme } from '../context/ThemeContext';
import type { GatedFeature } from '../hooks/useProGate';
import { presentPaywall } from '../services/PaywallService';
import { posthog } from '../src/config/posthog';
import { formatResetClock, formatResetCountdown, getNextQuotaReset } from '../utils/quotaReset';

/** Reason-specific copy. Free limits sell the upgrade; the premium cooldown
 *  never pitches — those users already pay, they just get a friendly wait. */
function copyForReason(reason: string): { title: string; body: string } {
    switch (reason) {
        case 'chat_limit':
            return {
                title: "That's your 3 free coach chats",
                body:
                    "You've used all 3 of today's free coach messages — the conversation was clearly worth having. " +
                    'Pro makes the coach unlimited, so you never have to stop mid-question.',
            };
        case 'meal_limit':
            return {
                title: "Today's free AI meal log is used",
                body:
                    'Free covers 1 AI meal log per day. Pro logs every meal — breakfast to midnight snack — ' +
                    'by just typing or saying what you ate.',
            };
        default:
            return {
                title: "You're on a roll",
                body:
                    "You've used all of today's free AI — that's the point of having a coach. " +
                    'Pro removes the daily limits so you never have to stop mid-session.',
            };
    }
}

export default function QuotaLimitScreen() {
    const router = useRouter();
    const { isDark } = useTheme();
    const colors = getThemeColors(isDark);
    const { checkSubscription } = useSubscription();
    const params = useLocalSearchParams<{ feature?: string; reason?: string; retryAt?: string }>();
    const feature = (params.feature ?? 'chat') as GatedFeature;
    const reason = params.reason ?? 'quota_exceeded';
    const isPremiumCooldown = reason === 'premium_cooldown';

    // Re-render once a minute so the countdown stays live.
    const [, setTick] = useState(0);
    useEffect(() => {
        const id = setInterval(() => setTick((t) => t + 1), 60_000);
        return () => clearInterval(id);
    }, []);

    useEffect(() => {
        posthog.capture('quota_limit_hit', { feature, reason });
    }, [feature, reason]);

    // Free limits reset at local midnight; the premium window reopens at retry_at.
    const retryAtParsed = params.retryAt ? new Date(params.retryAt) : null;
    const resetAt =
        isPremiumCooldown && retryAtParsed && !Number.isNaN(retryAtParsed.getTime())
            ? retryAtParsed
            : getNextQuotaReset();

    const handleUpgrade = () => {
        router.back();
        // Let the sheet's native dismissal finish before the paywall modal
        // presents — iOS can't present while another controller is dismissing.
        setTimeout(() => {
            void presentPaywall('soft', feature, async () => checkSubscription(true));
        }, 400);
    };

    const { title, body } = isPremiumCooldown
        ? {
              title: 'The coach needs a quick breather',
              body:
                  "You've been putting the coach through a serious session — your AI usage in the last few hours " +
                  'is unusually high. Nothing is lost and nothing changes: everything stays unlimited, the coach ' +
                  'just needs a short rest before the next round.',
          }
        : copyForReason(reason);

    return (
        <View style={[styles.sheet, { backgroundColor: colors.background }]}>
            <View style={[styles.iconWrap, { backgroundColor: isDark ? 'rgba(46,144,250,0.13)' : 'rgba(46,144,250,0.10)' }]}>
                <Ionicons name={isPremiumCooldown ? 'cafe' : 'flash'} size={28} color={colors.primary} />
            </View>

            <Text style={[styles.title, { color: colors.text }]}>{title}</Text>

            <Text style={[styles.body, { color: colors.textSecondary ?? colors.text }]}>{body}</Text>

            <Text style={[styles.meta, { color: colors.textSecondary ?? colors.text }]}>
                {isPremiumCooldown ? 'Back' : 'Resets'} in {formatResetCountdown(resetAt)} · at {formatResetClock(resetAt)}
            </Text>

            {!isPremiumCooldown && (
                <TouchableOpacity
                    style={[styles.upgradeBtn, { backgroundColor: colors.primary }]}
                    onPress={handleUpgrade}
                    activeOpacity={0.85}
                >
                    <Text style={styles.upgradeBtnText}>Go unlimited with Pro</Text>
                </TouchableOpacity>
            )}

            <TouchableOpacity style={styles.dismissBtn} onPress={() => router.back()} activeOpacity={0.7}>
                <Text style={[styles.dismissBtnText, { color: colors.textSecondary ?? colors.text }]}>
                    {isPremiumCooldown ? 'Got it' : 'Maybe later'}
                </Text>
            </TouchableOpacity>
        </View>
    );
}

const styles = StyleSheet.create({
    sheet: {
        flex: 1,
        paddingHorizontal: 24,
        paddingTop: 28,
        paddingBottom: 36,
        alignItems: 'center',
    },
    iconWrap: {
        width: 64,
        height: 64,
        borderRadius: 999,
        alignItems: 'center',
        justifyContent: 'center',
        marginBottom: 16,
    },
    title: {
        fontSize: 20,
        fontWeight: '700',
        textAlign: 'center',
        marginBottom: 8,
    },
    body: {
        fontSize: 15,
        lineHeight: 22,
        textAlign: 'center',
        marginBottom: 12,
        paddingHorizontal: 8,
    },
    meta: {
        fontSize: 13,
        textAlign: 'center',
        marginBottom: 24,
    },
    upgradeBtn: {
        alignSelf: 'stretch',
        borderRadius: 16,
        paddingVertical: 16,
        alignItems: 'center',
        marginBottom: 8,
    },
    upgradeBtnText: {
        color: '#FFF',
        fontSize: 17,
        fontWeight: '700',
    },
    dismissBtn: {
        paddingVertical: 12,
    },
    dismissBtnText: {
        fontSize: 14,
        fontWeight: '600',
    },
});
