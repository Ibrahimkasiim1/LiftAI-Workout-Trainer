/**
 * Exercise GIF Utilities
 * 
 * Helper functions for fetching exercise GIFs from Supabase Storage
 */

import { supabase } from './supabase';

/**
 * Get public URL for an exercise GIF from Supabase Storage
 * 
 * @param gifPath - Path to GIF in storage (e.g., "exercises/barbell-squat.gif")
 * @returns Public URL to the GIF, or empty string if path is invalid
 */
export function getExerciseGifUrl(gifPath: string | null | undefined): string {
    if (!gifPath) {
        console.warn('No gif_path provided');
        return '';
    }

    try {
        const { data } = supabase.storage
            .from('exercise-gifs')
            .getPublicUrl(gifPath);

        return data.publicUrl;
    } catch (error) {
        console.error('Error getting exercise GIF URL:', error);
        return '';
    }
}

/**
 * Prefetch multiple exercise GIFs
 * Useful for preloading workout GIFs before starting
 * 
 * @param gifPaths - Array of GIF paths
 * @returns Array of public URLs
 */
export function prefetchExerciseGifs(gifPaths: Array<string | null | undefined>): string[] {
    return gifPaths
        .filter((path): path is string => !!path)
        .map(getExerciseGifUrl);
}

/**
 * Check if a GIF URL is valid (exists in storage)
 * 
 * @param gifPath - Path to check
 * @returns Promise<boolean>
 */
export async function validateGifExists(gifPath: string): Promise<boolean> {
    if (!gifPath) return false;

    try {
        const { data, error } = await supabase.storage
            .from('exercise-gifs')
            .list(gifPath.split('/').slice(0, -1).join('/'), {
                search: gifPath.split('/').pop() || '',
            });

        return !error && data !== null && data.length > 0;
    } catch (error) {
        console.error('Error validating GIF:', error);
        return false;
    }
}
