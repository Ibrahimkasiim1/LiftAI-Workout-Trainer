import PostHog from 'posthog-react-native'
import Constants from 'expo-constants'

// Configuration loaded from app.config.js extras via expo-constants
// Environment variables are read at build time in app.config.js
const apiKey = Constants.expoConfig?.extra?.posthogProjectToken as string | undefined
const host = Constants.expoConfig?.extra?.posthogHost as string | undefined
const isPostHogConfigured = Boolean(apiKey && apiKey !== 'phc_your_project_token_here')

if (__DEV__) {
  console.log('PostHog config:', {
    apiKey: apiKey ? 'SET' : 'NOT SET',
    host,
    isConfigured: isPostHogConfigured,
  })
}

if (!isPostHogConfigured) {
  console.warn(
    'PostHog project token not configured. Analytics will be disabled. ' +
      'Set POSTHOG_PROJECT_TOKEN in your .env file to enable analytics.'
  )
}

/**
 * PostHog client instance for Expo
 *
 * Configuration loaded from app.config.js extras via expo-constants.
 *
 * @see https://posthog.com/docs/libraries/react-native
 */
export const posthog = new PostHog(apiKey || 'placeholder_key', {
  ...(host ? { host } : {}),

  // Disable PostHog if project token is not configured
  disabled: !isPostHogConfigured,

  // Capture app lifecycle events
  captureAppLifecycleEvents: true,

  // Session replay (posthog-react-native-session-replay native module — needs
  // a dev/EAS build, silently inert in Expo Go). Text inputs are masked so
  // weights/emails/messages never leave the device as pixels.
  enableSessionReplay: true,
  sessionReplayConfig: {
    maskAllTextInputs: true,
    maskAllImages: false,
    captureLog: false,
    captureNetworkTelemetry: false,
  },

  // Batching: queue events and flush periodically to optimize battery usage
  flushAt: 20,
  flushInterval: 10000,
  maxBatchSize: 100,
  maxQueueSize: 1000,

  // Feature flags
  preloadFeatureFlags: true,
  sendFeatureFlagEvent: true,
  featureFlagsRequestTimeoutMs: 10000,

  // Network settings
  requestTimeout: 10000,
  fetchRetryCount: 3,
  fetchRetryDelay: 3000,
})

export const isPostHogEnabled = isPostHogConfigured

/**
 * `identify` typings reject typical `$set` user fields; this keeps call sites simple.
 */
export function identifyUserForAnalytics(
  userId: string,
  traits: { $set?: Record<string, unknown>; $set_once?: Record<string, unknown> }
) {
  posthog.identify(userId, traits as any)
}
