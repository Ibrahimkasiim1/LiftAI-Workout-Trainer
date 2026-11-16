/**
 * Workout Error Boundary
 * 
 * React error boundary component that wraps the TikTok workout UI to prevent
 * catastrophic crashes from propagating to the entire app.
 * 
 * Handles common failure scenarios:
 * - Missing or invalid exercise GIF paths
 * - Network failures during image loading
 * - Malformed exercise data from backend
 * - Component rendering errors
 * 
 * Provides graceful fallback UI with options to:
 * - View error details (dev mode)
 * - Retry the workout
 * - Exit to safety
 */

import { Ionicons } from '@expo/vector-icons';
import React, { Component, ErrorInfo, ReactNode } from 'react';
import { ScrollView, StyleSheet, Text, TouchableOpacity, View } from 'react-native';

interface Props {
    children: ReactNode;
    onError?: (error: Error, errorInfo: ErrorInfo) => void;
    onRetry?: () => void;
    onExit?: () => void;
}

interface State {
    hasError: boolean;
    error: Error | null;
    errorInfo: ErrorInfo | null;
}

export class WorkoutErrorBoundary extends Component<Props, State> {
    constructor(props: Props) {
        super(props);
        this.state = {
            hasError: false,
            error: null,
            errorInfo: null,
        };
    }

    static getDerivedStateFromError(error: Error): State {
        // Update state so the next render will show the fallback UI
        return {
            hasError: true,
            error,
            errorInfo: null,
        };
    }

    componentDidCatch(error: Error, errorInfo: ErrorInfo) {
        // Log error to console (could be sent to error reporting service)
        console.error('WORKOUT ERROR BOUNDARY CAUGHT:', error);
        console.error('Component stack:', errorInfo.componentStack);

        this.setState({
            error,
            errorInfo,
        });

        // Call parent error handler if provided
        this.props.onError?.(error, errorInfo);
    }

    handleRetry = () => {
        this.setState({
            hasError: false,
            error: null,
            errorInfo: null,
        });
        this.props.onRetry?.();
    };

    handleExit = () => {
        this.props.onExit?.();
    };

    render() {
        if (this.state.hasError) {
            return (
                <View style={styles.container}>
                    <View style={styles.content}>
                        {/* Error Icon */}
                        <View style={styles.iconContainer}>
                            <Ionicons name="warning-outline" size={80} color="#EF4444" />
                        </View>

                        {/* Error Title */}
                        <Text style={styles.title}>Workout Error</Text>

                        {/* Error Message */}
                        <Text style={styles.message}>
                            Something went wrong while loading your workout.
                            This could be due to missing exercise data or a network issue.
                        </Text>

                        {/* Dev Error Details */}
                        {__DEV__ && this.state.error && (
                            <ScrollView style={styles.errorDetails}>
                                <Text style={styles.errorTitle}>Error Details (Dev Mode):</Text>
                                <Text style={styles.errorText}>{this.state.error.toString()}</Text>
                                {this.state.errorInfo && (
                                    <Text style={styles.errorStack}>
                                        {this.state.errorInfo.componentStack}
                                    </Text>
                                )}
                            </ScrollView>
                        )}

                        {/* Action Buttons. Retry always renders: handleRetry
                            resets the boundary state (remounting children) on
                            its own — onRetry is an optional extra hook, not
                            the switch that turns the button on. */}
                        <View style={styles.buttonContainer}>
                            <TouchableOpacity
                                style={[styles.button, styles.retryButton]}
                                onPress={this.handleRetry}
                            >
                                <Ionicons name="refresh-outline" size={20} color="#FFFFFF" />
                                <Text style={styles.buttonText}>Retry Workout</Text>
                            </TouchableOpacity>

                            {this.props.onExit && (
                                <TouchableOpacity
                                    style={[styles.button, styles.exitButton]}
                                    onPress={this.handleExit}
                                >
                                    <Ionicons name="home-outline" size={20} color="#0F172A" />
                                    <Text style={[styles.buttonText, styles.exitButtonText]}>
                                        Exit to Dashboard
                                    </Text>
                                </TouchableOpacity>
                            )}
                        </View>

                        {/* Help Text */}
                        <Text style={styles.helpText}>
                            If this error persists, please contact support or try generating a new workout.
                        </Text>
                    </View>
                </View>
            );
        }

        return this.props.children;
    }
}

// Light palette — the workout player is a light surface by design rule, and
// this fallback must read as part of the player, not a theme break.
const styles = StyleSheet.create({
    container: {
        flex: 1,
        backgroundColor: '#FFFFFF',
        justifyContent: 'center',
        alignItems: 'center',
        padding: 20,
    },
    content: {
        width: '100%',
        maxWidth: 400,
        alignItems: 'center',
    },
    iconContainer: {
        marginBottom: 24,
    },
    title: {
        fontSize: 28,
        fontWeight: 'bold',
        color: '#0F172A',
        marginBottom: 16,
        textAlign: 'center',
    },
    message: {
        fontSize: 16,
        color: '#64748B',
        marginBottom: 24,
        textAlign: 'center',
        lineHeight: 24,
    },
    errorDetails: {
        maxHeight: 200,
        width: '100%',
        backgroundColor: '#F3F5F9',
        borderRadius: 8,
        padding: 12,
        marginBottom: 24,
    },
    errorTitle: {
        fontSize: 14,
        fontWeight: 'bold',
        color: '#EF4444',
        marginBottom: 8,
    },
    errorText: {
        fontSize: 12,
        color: '#B91C1C',
        fontFamily: 'monospace',
        marginBottom: 8,
    },
    errorStack: {
        fontSize: 10,
        color: '#64748B',
        fontFamily: 'monospace',
    },
    buttonContainer: {
        width: '100%',
        gap: 12,
    },
    button: {
        flexDirection: 'row',
        alignItems: 'center',
        justifyContent: 'center',
        padding: 16,
        borderRadius: 12,
        gap: 8,
    },
    retryButton: {
        backgroundColor: '#111111',
    },
    exitButton: {
        backgroundColor: '#FFFFFF',
        borderWidth: 1,
        borderColor: 'rgba(0,0,0,0.12)',
    },
    buttonText: {
        fontSize: 16,
        fontWeight: '600',
        color: '#FFFFFF',
    },
    exitButtonText: {
        color: '#0F172A',
    },
    helpText: {
        fontSize: 12,
        color: '#94A3B4',
        marginTop: 24,
        textAlign: 'center',
        lineHeight: 18,
    },
});
