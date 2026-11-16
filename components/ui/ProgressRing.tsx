// components/ui/ProgressRing.tsx
//
// Circular progress ring — the countdown ring from the paywall's Dynamic
// Island mock, promoted for app-wide use (rest timers, completion states).

import React from 'react';
import Svg, { Circle } from 'react-native-svg';

const BRAND_BLUE = '#2E90FA';

interface ProgressRingProps {
    /** Outer diameter in points. */
    size?: number;
    /** 0–1 fraction of the ring to fill. */
    progress?: number;
    /** Stroke width. */
    stroke?: number;
    /** Fill color — stay in the blue family per the design system. */
    color?: string;
    /** Track color behind the fill. */
    trackColor?: string;
}

export default function ProgressRing({
    size = 44,
    progress = 0.65,
    stroke = 4,
    color = BRAND_BLUE,
    trackColor = 'rgba(255,255,255,0.16)',
}: ProgressRingProps) {
    const r = (size - stroke) / 2;
    const c = 2 * Math.PI * r;
    const clamped = Math.max(0, Math.min(1, progress));
    return (
        <Svg width={size} height={size}>
            <Circle
                cx={size / 2}
                cy={size / 2}
                r={r}
                stroke={trackColor}
                strokeWidth={stroke}
                fill="none"
            />
            <Circle
                cx={size / 2}
                cy={size / 2}
                r={r}
                stroke={color}
                strokeWidth={stroke}
                fill="none"
                strokeLinecap="round"
                strokeDasharray={`${c}`}
                strokeDashoffset={c * (1 - clamped)}
                transform={`rotate(-90 ${size / 2} ${size / 2})`}
            />
        </Svg>
    );
}
