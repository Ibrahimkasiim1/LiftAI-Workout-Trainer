// hooks/useRequireAuth.ts
/**
 * Custom hook to require authentication
 * 
 * Automatically checks for a valid session and redirects to auth if missing.
 * Returns the session and loading state.
 * 
 * Usage:
 * ```
 * const { session, loading } = useRequireAuth();
 * if (loading) return <LoadingScreen />;
 * // session is guaranteed non-null here
 * ```
 */

import { Session } from '@supabase/supabase-js';
import { useEffect, useState } from 'react';
import { Alert } from 'react-native';
import { replaceWithSignedOutRoot } from '../utils/authNavigation';
import { getSession } from '../utils/supabase';

export function useRequireAuth() {
    const [session, setSession] = useState<Session | null>(null);
    const [loading, setLoading] = useState(true);

    useEffect(() => {
        const checkAuth = async () => {
            try {
                const currentSession = await getSession();

                if (!currentSession) {
                    Alert.alert('Error', 'Session expired. Please sign in again.');
                    replaceWithSignedOutRoot();
                } else {
                    setSession(currentSession);
                }
            } catch (error) {
                console.error('Error checking authentication:', error);
                Alert.alert('Error', 'An error occurred. Please sign in again.');
                replaceWithSignedOutRoot();
            } finally {
                setLoading(false);
            }
        };

        checkAuth();
    }, []);

    return { session, loading };
}
