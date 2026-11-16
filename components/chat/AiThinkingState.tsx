import React, { useMemo } from 'react';
import { StyleSheet, Text, View } from 'react-native';
import Animated, { FadeIn, FadeOut } from 'react-native-reanimated';
import { ChatAiParticles } from './ChatAiParticles';

type Props = {
    /** SSE-derived LangGraph node label (e.g. "Analyzing your request…"). */
    graphNodeMessage?: string | null;
    /** SSE-derived tool_start label (most specific, e.g. "Building your workout…"). */
    toolHint?: string | null;
    /**
     * Live, request-specific status streamed from the model (its own `preamble`
     * / the dynamic tool label). Highest priority — rendered as-is. This is what
     * makes the indicator read like the coach reasoning about THIS request
     * rather than a canned "thinking…" line.
     */
    currentStatus?: string | null;
    isDark?: boolean;
};

const IDLE_PLACEHOLDER = 'Thinking through your request…';

export function AiThinkingState({
    graphNodeMessage,
    toolHint,
    currentStatus,
    isDark = true,
}: Props) {
    const primaryLine = useMemo(() => {
        const explicit = currentStatus?.trim();
        if (explicit) return explicit;
        const tool = toolHint?.trim();
        if (tool) return tool;
        const graph = graphNodeMessage?.trim();
        if (graph) return graph;
        return IDLE_PLACEHOLDER;
    }, [currentStatus, toolHint, graphNodeMessage]);

    const textColor = isDark ? 'rgba(255,255,255,0.92)' : 'rgba(17,17,17,0.92)';

    return (
        <View style={styles.row}>
            <View style={styles.iconWrap}>
                <ChatAiParticles size={22} />
            </View>
            <Animated.View
                key={primaryLine}
                entering={FadeIn.duration(260)}
                exiting={FadeOut.duration(160)}
                style={styles.textWrap}
            >
                <Text style={[styles.primary, { color: textColor }]} numberOfLines={2}>
                    {primaryLine}
                </Text>
            </Animated.View>
        </View>
    );
}

const styles = StyleSheet.create({
    row: {
        flexDirection: 'row',
        alignItems: 'center',
        paddingVertical: 12,
        paddingHorizontal: 2,
        minHeight: 40,
    },
    iconWrap: {
        width: 28,
        height: 28,
        marginRight: 12,
        alignItems: 'center',
        justifyContent: 'center',
    },
    textWrap: { flex: 1 },
    primary: {
        fontSize: 15,
        lineHeight: 21,
        fontFamily: 'Montserrat_500Medium',
        fontWeight: '500',
        letterSpacing: 0.1,
    },
});
