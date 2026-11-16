// utils/weightConverter.ts
/**
 * Weight Converter Utility Module
 * 
 * OVERVIEW:
 * This module handles all weight unit conversions and weight unit preference management.
 * It provides functions to convert between kilograms (kg) and pounds (lbs), retrieve and
 * update user's preferred weight unit, and format weight values for display. The app stores
 * all weights in kg in the database, but displays them in the user's preferred unit.
 */
import { getSession, supabase } from './supabase';

// Conversion constants
const KG_TO_LBS = 2.20462;
const LBS_TO_KG = 0.453592;

/**
 * Get user's preferred weight unit from database
 * Defaults to 'kg' if not set or no session
 */
export const getWeightUnit = async (): Promise<'kg' | 'lbs'> => {
  try {
    const session = await getSession();
    if (!session) {
      return 'kg'; // Default to kg if no session
    }

    const { data, error } = await supabase
      .from('user_profiles')
      .select('weight_unit')
      .eq('id', session.user.id)
      .single();

    if (error || !data || !data.weight_unit) {
      console.warn('Could not fetch weight unit preference, defaulting to kg');
      return 'kg';
    }

    return data.weight_unit as 'kg' | 'lbs';
  } catch (error) {
    console.error('Error fetching weight unit:', error);
    return 'kg';
  }
};

/**
 * Update user's preferred weight unit in database
 */
export const setWeightUnit = async (unit: 'kg' | 'lbs'): Promise<{ success: boolean; error?: string }> => {
  try {
    const session = await getSession();
    if (!session) {
      return { success: false, error: 'No active session' };
    }

    const { error } = await supabase
      .from('user_profiles')
      .update({ weight_unit: unit })
      .eq('id', session.user.id);

    if (error) {
      console.error('Error updating weight unit:', error);
      return { success: false, error: error.message };
    }

    console.log('Weight unit updated to:', unit);
    return { success: true };
  } catch (error) {
    console.error('Error updating weight unit:', error);
    return { success: false, error: 'Failed to update weight unit' };
  }
};

/**
 * Convert weight from one unit to another
 * @param value - Weight value to convert
 * @param fromUnit - Source unit
 * @param toUnit - Target unit
 * @returns Converted weight value
 */
export const convertWeight = (
  value: number,
  fromUnit: 'kg' | 'lbs',
  toUnit: 'kg' | 'lbs'
): number => {
  if (fromUnit === toUnit) return value;

  if (fromUnit === 'kg' && toUnit === 'lbs') {
    return value * KG_TO_LBS;
  } else {
    return value * LBS_TO_KG;
  }
};

/**
 * Format weight value with unit label
 * @param value - Weight value
 * @param unit - Unit to display
 * @param decimals - Number of decimal places (default: 1)
 * @returns Formatted string like "50 kg" or "110.2 lbs"
 */
export const formatWeight = (
  value: number,
  unit: 'kg' | 'lbs',
  decimals: number = 1
): string => {
  return `${value.toFixed(decimals)} ${unit}`;
};

/**
 * Convert weight value to user's preferred unit
 * Useful when displaying database values (stored in kg) to user
 * @param valueInKg - Weight stored in database (kg)
 * @param userPreferredUnit - User's preferred display unit
 * @returns Converted weight value
 */
export const toUserUnit = (
  valueInKg: number,
  userPreferredUnit: 'kg' | 'lbs'
): number => {
  return convertWeight(valueInKg, 'kg', userPreferredUnit);
};

/**
 * Convert weight value from user's unit to kg (for database storage)
 * @param value - Weight in user's preferred unit
 * @param userUnit - User's current unit
 * @returns Weight in kg for database storage
 */
export const toKg = (
  value: number,
  userUnit: 'kg' | 'lbs'
): number => {
  return convertWeight(value, userUnit, 'kg');
};

