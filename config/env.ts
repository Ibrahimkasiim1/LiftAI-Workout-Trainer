import Constants from 'expo-constants';
import { Platform } from 'react-native';

/**
 * Represents the environment variables that are required/provided through Expo's
 * config extra. These values are populated from `app.config.js` or directly from
 * the system environment (useful when running tests or scripts outside of Expo).
 * 
 * Note: Pinecone has been removed - using Supabase exclusively for vector search
 */
export interface AppEnv {
  revenueCatApiKey?: string;
  supabaseUrl?: string;
  supabaseAnonKey?: string;
  exerciseDbApiKey?: string;
}

type ExtraConfig = Partial<AppEnv> & {
  revenueCatApiKeyIos?: string;
  revenueCatApiKeyAndroid?: string;
};

const expoExtra = (Constants.expoConfig?.extra ?? {}) as ExtraConfig;

const getValue = (key: keyof AppEnv, envVar: string): string | undefined => {
  return expoExtra[key] ?? process.env[envVar];
};

const platformRevenueCatKey = (): string | undefined => {
  if (Platform.OS === 'ios') {
    return (
      expoExtra.revenueCatApiKeyIos ??
      process.env.EXPO_PUBLIC_REVENUECAT_API_KEY_IOS ??
      getValue('revenueCatApiKey', 'EXPO_PUBLIC_REVENUECAT_API_KEY')
    );
  }
  if (Platform.OS === 'android') {
    return (
      expoExtra.revenueCatApiKeyAndroid ??
      process.env.EXPO_PUBLIC_REVENUECAT_API_KEY_ANDROID ??
      getValue('revenueCatApiKey', 'EXPO_PUBLIC_REVENUECAT_API_KEY')
    );
  }
  return getValue('revenueCatApiKey', 'EXPO_PUBLIC_REVENUECAT_API_KEY');
};

export const appEnv: AppEnv = {
  revenueCatApiKey: platformRevenueCatKey(),
  supabaseUrl: getValue('supabaseUrl', 'EXPO_PUBLIC_SUPABASE_URL'),
  supabaseAnonKey: getValue('supabaseAnonKey', 'EXPO_PUBLIC_SUPABASE_ANON_KEY'),
  exerciseDbApiKey: getValue('exerciseDbApiKey', 'EXPO_PUBLIC_EXERCISEDB_API_KEY'),
};

/**
 * ExerciseDB / RapidAPI key — must be supplied via env; never ship a fallback literal in the bundle.
 */
export const getExerciseDbApiKey = (): string => {
  const key =
    appEnv.exerciseDbApiKey?.trim() ||
    process.env.EXPO_PUBLIC_EXERCISEDB_API_KEY?.trim();
  if (!key) {
    throw new Error(
      'EXPO_PUBLIC_EXERCISEDB_API_KEY is missing. Set it in .env and rebuild the app.'
    );
  }
  return key;
};

// Re-export API_URL for backward compatibility
import { getApiUrl } from './api';
export const API_URL = getApiUrl();

// Removed: getPineconeConfig - now using Supabase vector search exclusively
