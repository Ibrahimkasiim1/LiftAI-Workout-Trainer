// components/ui/Glow.tsx
//
// Soft radial glow used behind hero elements — the signature visual of the
// ConversionPaywall slides, promoted for app-wide use.
//
// RATION IT: at most ONE glow per screen, reserved for hero moments (today's
// workout card, a PR celebration, the rest timer, empty states). If
// everything glows, nothing does.
//
// Render inside a parent with `alignItems/justifyContent: 'center'` (or
// position it yourself); the glow is absolutely positioned and ignores
// touches.

import React, { useId } from 'react';
import { View } from 'react-native';
import Svg, { Defs, RadialGradient, Rect, Stop } from 'react-native-svg';

const BRAND_BLUE = '#2E90FA';

interface GlowProps {
    /** Diameter of the glow in points. */
    size?: number;
    /** Peak opacity at the center. */
    opacity?: number;
    /** Glow color — stay in the blue family per the design system. */
    color?: string;
}

export default function Glow({ size = 320, opacity = 0.5, color = BRAND_BLUE }: GlowProps) {
    // Unique gradient id so multiple glows never collide in the SVG defs.
    const id = useId().replace(/[^a-zA-Z0-9]/g, '');
    return (
        <View
            pointerEvents="none"
            style={{
                position: 'absolute',
                width: size,
                height: size,
                alignItems: 'center',
                justifyContent: 'center',
            }}
        >
            <Svg width={size} height={size}>
                <Defs>
                    <RadialGradient id={id} cx="50%" cy="50%" r="50%">
                        <Stop offset="0%" stopColor={color} stopOpacity={opacity} />
                        <Stop offset="55%" stopColor={color} stopOpacity={opacity * 0.22} />
                        <Stop offset="100%" stopColor={color} stopOpacity={0} />
                    </RadialGradient>
                </Defs>
                <Rect x="0" y="0" width={size} height={size} fill={`url(#${id})`} />
            </Svg>
        </View>
    );
}
