import AsyncStorage from '@react-native-async-storage/async-storage';

// Stored while the user has submitted email/password but hasn't entered the
// OTP yet. Survives app kill so we can drop them back on the code-entry
// screen instead of the welcome page.

const KEY = '@lift3_pending_signup_v1';
// Supabase OTPs expire (default 1 hour). Drop the pending state after a
// generous TTL so a long-stale entry doesn't strand the user on the OTP
// screen with no way back to fresh sign-up.
const TTL_MS = 24 * 60 * 60 * 1000;

export interface PendingSignup {
  email: string;
  name?: string;
  createdAt: string;
}

function isPendingSignup(v: unknown): v is PendingSignup {
  if (!v || typeof v !== 'object') return false;
  const c = v as Partial<PendingSignup>;
  return typeof c.email === 'string' && c.email.length > 0 && typeof c.createdAt === 'string';
}

export async function readPendingSignup(): Promise<PendingSignup | null> {
  try {
    const raw = await AsyncStorage.getItem(KEY);
    if (!raw) return null;
    const parsed: unknown = JSON.parse(raw);
    if (!isPendingSignup(parsed)) return null;
    const ageMs = Date.now() - Date.parse(parsed.createdAt);
    if (!Number.isFinite(ageMs) || ageMs > TTL_MS) {
      await clearPendingSignup();
      return null;
    }
    return parsed;
  } catch (e) {
    console.warn('readPendingSignup failed:', e);
    return null;
  }
}

export async function writePendingSignup(email: string, name?: string): Promise<void> {
  try {
    const payload: PendingSignup = {
      email: email.trim().toLowerCase(),
      name: name?.trim() || undefined,
      createdAt: new Date().toISOString(),
    };
    await AsyncStorage.setItem(KEY, JSON.stringify(payload));
  } catch (e) {
    console.warn('writePendingSignup failed:', e);
  }
}

export async function clearPendingSignup(): Promise<void> {
  try {
    await AsyncStorage.removeItem(KEY);
  } catch (e) {
    console.warn('clearPendingSignup failed:', e);
  }
}
