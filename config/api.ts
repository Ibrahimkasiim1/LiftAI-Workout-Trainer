// config/api.ts
/**
 * API Configuration
 * Centralized API endpoint definitions
 */

import Constants from 'expo-constants';
import { Platform } from 'react-native';

// Port the local backend (`npm run dev`) listens on.
const DEV_PORT = '3001';

// Pull the dev machine's host (LAN IP) from the Metro bundler URL. On a physical
// device `localhost` resolves to the phone itself, so we must target the
// computer's LAN IP instead — Expo exposes it via the bundler host.
const getDevLanHost = (): string | null => {
  const hostUri =
    Constants.expoConfig?.hostUri ||
    // Expo Go / older runtimes
    (Constants as any).expoGoConfig?.debuggerHost ||
    (Constants as any).manifest?.debuggerHost ||
    (Constants as any).manifest2?.extra?.expoClient?.hostUri ||
    '';
  const raw = String(hostUri);
  const noScheme = raw.includes('://') ? raw.split('://')[1] : raw;
  const host = noScheme.split('/')[0].split(':')[0].trim();
  if (!host || host === 'localhost' || host === '127.0.0.1') return null;
  return host;
};

// Determine base URL based on environment
export const getApiUrl = (): string => {
  // If EXPO_PUBLIC_API_URL is set, always use it (even in development).
  // This allows testing with a hosted backend during development.
  const envApiUrl = process.env.EXPO_PUBLIC_API_URL;
  if (envApiUrl) {
    return envApiUrl;
  }

  // Development: target the local backend.
  if (__DEV__) {
    // Physical device → use the dev machine's LAN IP (reachable over Wi-Fi).
    const lanHost = getDevLanHost();
    if (lanHost) {
      return `http://${lanHost}:${DEV_PORT}`;
    }
    // Simulators/emulators where the loopback maps to the host machine.
    if (Platform.OS === 'android') {
      return `http://10.0.2.2:${DEV_PORT}`;
    }
    return `http://localhost:${DEV_PORT}`;
  }

  // Production builds must set EXPO_PUBLIC_API_URL.
  return 'https://api.example.com';
};

/**
 * API Endpoints
 */
export const API_ENDPOINTS = {
  // Onboarding (does NOT use LangGraph agents)
  GENERATE_PLAN: '/api/generate-plan',

  // Chat endpoints (uses LangGraph conversational agent; matches backend routes)
  CHAT: '/chat',
  CHAT_STREAM: '/chat/stream',
  NUTRITION_LOG: '/nutrition/log',

  // Workout management
  SAVE_WORKOUT: '/api/workouts/save',
  GET_WORKOUTS: '/api/workouts',

  // Plan management
  GET_PLAN: '/api/plans/current',
  UPDATE_PLAN: '/api/plans/update',
} as const;

export type ApiEndpoint = typeof API_ENDPOINTS[keyof typeof API_ENDPOINTS];

/**
 * Helper to build full URL
 */
export const buildApiUrl = (endpoint: ApiEndpoint): string => {
  return `${getApiUrl()}${endpoint}`;
};