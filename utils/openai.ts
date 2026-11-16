/**
 * OpenAI Utility Functions
 * 
 * Exercise database loading implementation
 */

import { supabase } from './supabase';

/**
 * Load exercise database from Supabase
 * Fetches all exercises and maps them to the frontend format
 */
export async function loadExerciseDatabase(): Promise<any[]> {
    try {
        const { data, error } = await supabase
            .from('exercises')
            .select('*')
            .order('name');

        if (error) {
            console.error('Error loading exercise database:', error);
            return [];
        }

        if (!data || data.length === 0) {
            console.warn('No exercises found in database');
            return [];
        }

        // Map database fields to frontend format
        const exercises = data.map(exercise => ({
            id: exercise.id,
            name: exercise.name,
            bodyPart: exercise.body_part || 'general',
            equipment: exercise.equipment || 'bodyweight',
            target: exercise.target_muscle || exercise.body_part || 'general',
            secondaryMuscles: exercise.secondary_muscles || [],
            instructions: exercise.instructions || [],
            description: exercise.description || '',
            difficulty: exercise.difficulty || 'intermediate',
            category: exercise.category || 'strength',
            gif_path: exercise.gif_path || null,
            // Optional: Add popularity/ease scores if available
            popularityScore: 0,
            easeScore: 0,
        }));

        console.log(`Loaded ${exercises.length} exercises from database`);
        return exercises;
    } catch (error) {
        console.error('Unexpected error loading exercise database:', error);
        return [];
    }
}
