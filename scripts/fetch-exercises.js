#!/usr/bin/env node

/**
 * RapidAPI ExerciseDB Data Fetcher
 * 
 * This script fetches all exercise data from the RapidAPI ExerciseDB API
 * and outputs an enriched JSON file with full exercise details.
 * 
 * Features:
 * - Fetches all exercises with pagination
 * - Handles rate limiting (100 requests/min on free tier)
 * - Adds computed fields: popularityScore, easeScore, movementPattern
 * - Generates semantic descriptions for vector embeddings
 * 
 * Usage:
 *   node scripts/fetch-exercises.js
 *   node scripts/fetch-exercises.js --output custom-path.json
 *   node scripts/fetch-exercises.js --limit 100 (for testing)
 */

const fs = require('fs');
const path = require('path');

// Try to load .env file if it exists
try {
  require('dotenv').config({ path: path.join(__dirname, '..', '.env') });
} catch (e) {
  // dotenv not installed or .env doesn't exist, continue with system env vars
}

// Node 20+ has native fetch, but we need to ensure it's available
// If not, fall back to node-fetch
const fetch = globalThis.fetch || require('node-fetch');

// Configuration
const API_KEY =
    process.env.RAPIDAPI_KEY ||
    process.env.EXPO_PUBLIC_EXERCISEDB_API_KEY ||
    process.env.EXERCISEDB_API_KEY;

if (!API_KEY) {
    console.error(
        'Missing API key. Set one of: RAPIDAPI_KEY, EXPO_PUBLIC_EXERCISEDB_API_KEY, EXERCISEDB_API_KEY'
    );
    process.exit(1);
}
const API_HOST = 'exercisedb.p.rapidapi.com';
const BASE_URL = `https://${API_HOST}`;
const RATE_LIMIT_DELAY = 650; // ms between requests (slightly under 100/min)
const BATCH_SIZE = 100; // ExerciseDB returns max 100 per request

// Parse command line arguments
const args = process.argv.slice(2);
const outputPathIndex = args.indexOf('--output');
const limitIndex = args.indexOf('--limit');

const OUTPUT_PATH = outputPathIndex !== -1
  ? args[outputPathIndex + 1]
  : path.join(__dirname, '..', 'data', 'exercises-enriched.json');

const EXERCISE_LIMIT = limitIndex !== -1
  ? parseInt(args[limitIndex + 1], 10)
  : Infinity;

// Movement pattern classifications
const MOVEMENT_PATTERNS = {
  push: [
    'bench press', 'push-up', 'pushup', 'chest press', 'shoulder press',
    'overhead press', 'military press', 'dip', 'tricep', 'fly', 'flye',
    'incline press', 'decline press', 'arnold press', 'pike push'
  ],
  pull: [
    'row', 'pull-up', 'pullup', 'chin-up', 'chinup', 'lat pulldown',
    'pulldown', 'curl', 'bicep', 'face pull', 'reverse fly', 'upright row',
    'seated row', 'cable row', 'barbell row', 'dumbbell row'
  ],
  hinge: [
    'deadlift', 'hip hinge', 'good morning', 'romanian', 'stiff leg',
    'hip thrust', 'glute bridge', 'kettlebell swing', 'hyperextension',
    'back extension', 'pull through'
  ],
  squat: [
    'squat', 'leg press', 'lunge', 'split squat', 'step up', 'step-up',
    'goblet', 'front squat', 'hack squat', 'sissy squat', 'pistol squat',
    'bulgarian'
  ],
  carry: [
    'farmer', 'carry', 'walk', 'suitcase', 'overhead carry', 'waiter'
  ],
  isolation: [
    'curl', 'extension', 'raise', 'fly', 'flye', 'kickback', 'shrug',
    'calf raise', 'leg curl', 'leg extension', 'cable crossover',
    'lateral raise', 'front raise', 'rear delt', 'wrist curl'
  ],
  core: [
    'plank', 'crunch', 'sit-up', 'situp', 'ab', 'oblique', 'twist',
    'russian twist', 'leg raise', 'knee raise', 'woodchop', 'pallof',
    'dead bug', 'bird dog', 'hollow', 'v-up', 'mountain climber'
  ],
  cardio: [
    'run', 'jog', 'sprint', 'jump', 'burpee', 'jumping jack', 'skip',
    'cycle', 'rowing', 'climber', 'high knee', 'butt kick'
  ]
};

// Popular exercises for scoring
const POPULAR_EXERCISES = [
  'bench press', 'squat', 'deadlift', 'pull-up', 'push-up', 'row',
  'shoulder press', 'curl', 'tricep', 'lunge', 'plank', 'crunch',
  'lat pulldown', 'leg press', 'dumbbell press', 'barbell row'
];

// Equipment complexity for ease scoring
const EQUIPMENT_COMPLEXITY = {
  'body weight': 1,
  'assisted': 2,
  'band': 2,
  'stability ball': 2,
  'medicine ball': 2,
  'dumbbell': 3,
  'kettlebell': 3,
  'barbell': 4,
  'ez barbell': 4,
  'cable': 4,
  'leverage machine': 5,
  'smith machine': 5,
  'sled machine': 5,
  'roller': 3,
  'rope': 3,
  'resistance band': 2,
  'bosu ball': 3,
  'weighted': 4,
  'olympic barbell': 5,
  'trap bar': 4,
  'tire': 5,
  'hammer': 4,
  'wheel roller': 3
};

/**
 * Sleep for specified milliseconds
 */
function sleep(ms) {
  return new Promise(resolve => setTimeout(resolve, ms));
}

/**
 * Make API request with error handling
 */
async function fetchFromAPI(endpoint, params = {}) {
  const url = new URL(`${BASE_URL}${endpoint}`);
  Object.entries(params).forEach(([key, value]) => {
    url.searchParams.append(key, value);
  });

  const response = await fetch(url.toString(), {
    method: 'GET',
    headers: {
      'X-RapidAPI-Key': API_KEY,
      'X-RapidAPI-Host': API_HOST,
    },
  });

  if (!response.ok) {
    throw new Error(`API request failed: ${response.status} ${response.statusText}`);
  }

  return response.json();
}

/**
 * Determine movement pattern for an exercise
 */
function getMovementPattern(exercise) {
  const name = exercise.name.toLowerCase();
  const target = (exercise.target || '').toLowerCase();
  const bodyPart = (exercise.bodyPart || '').toLowerCase();

  // Check each pattern
  for (const [pattern, keywords] of Object.entries(MOVEMENT_PATTERNS)) {
    if (keywords.some(keyword => name.includes(keyword))) {
      return pattern;
    }
  }

  // Fallback based on body part / target
  if (['chest', 'triceps', 'shoulders'].includes(bodyPart) ||
    ['pectorals', 'triceps', 'delts'].includes(target)) {
    return 'push';
  }
  if (['back', 'biceps'].includes(bodyPart) ||
    ['lats', 'biceps', 'traps'].includes(target)) {
    return 'pull';
  }
  if (['upper legs', 'lower legs'].includes(bodyPart) ||
    ['quads', 'hamstrings', 'glutes', 'calves'].includes(target)) {
    if (name.includes('curl') || name.includes('extension')) {
      return 'isolation';
    }
    return 'squat';
  }
  if (['waist'].includes(bodyPart) || ['abs', 'obliques'].includes(target)) {
    return 'core';
  }
  if (['cardio'].includes(bodyPart)) {
    return 'cardio';
  }

  return 'isolation'; // Default
}

/**
 * Calculate popularity score (0-10)
 */
function calculatePopularityScore(exercise) {
  let score = 5; // Base score

  const name = exercise.name.toLowerCase();

  // Boost for popular exercises
  if (POPULAR_EXERCISES.some(pop => name.includes(pop))) {
    score += 3;
  }

  // Boost for body weight exercises (accessible)
  if (exercise.equipment === 'body weight') {
    score += 1;
  }

  // Boost for compound movements
  const pattern = getMovementPattern(exercise);
  if (['push', 'pull', 'squat', 'hinge'].includes(pattern)) {
    score += 1;
  }

  // Cap at 10
  return Math.min(Math.max(score, 0), 10);
}

/**
 * Calculate ease score (1-10, higher = easier to learn)
 */
function calculateEaseScore(exercise) {
  let score = 7; // Base score

  // Equipment complexity
  const equipment = exercise.equipment?.toLowerCase() || 'body weight';
  const complexity = EQUIPMENT_COMPLEXITY[equipment] || 3;
  score -= (complexity - 3); // Adjust based on equipment

  // Difficult movements
  const name = exercise.name.toLowerCase();
  const difficultKeywords = ['clean', 'snatch', 'jerk', 'muscle-up', 'pistol', 'planche', 'handstand', 'front lever', 'back lever'];
  if (difficultKeywords.some(keyword => name.includes(keyword))) {
    score -= 3;
  }

  // Simple movements
  const simpleKeywords = ['curl', 'raise', 'crunch', 'plank'];
  if (simpleKeywords.some(keyword => name.includes(keyword))) {
    score += 1;
  }

  // Body weight exercises are generally easier to learn
  if (equipment === 'body weight') {
    score += 1;
  }

  // Cap between 1-10
  return Math.min(Math.max(score, 1), 10);
}

/**
 * Determine difficulty level
 */
function determineDifficulty(exercise) {
  const easeScore = calculateEaseScore(exercise);
  const equipment = exercise.equipment?.toLowerCase() || 'body weight';
  const name = exercise.name.toLowerCase();

  // Expert level exercises
  const expertKeywords = ['clean', 'snatch', 'jerk', 'muscle-up', 'pistol', 'planche', 'handstand', 'front lever', 'back lever', 'iron cross'];
  if (expertKeywords.some(keyword => name.includes(keyword))) {
    return 'expert';
  }

  // Beginner exercises
  if (easeScore >= 7 && ['body weight', 'dumbbell', 'band', 'assisted'].includes(equipment)) {
    return 'beginner';
  }

  // Expert exercises
  if (easeScore <= 4) {
    return 'expert';
  }

  return 'intermediate';
}

/**
 * Determine category
 */
function determineCategory(exercise) {
  const bodyPart = (exercise.bodyPart || '').toLowerCase();
  const name = exercise.name.toLowerCase();

  if (bodyPart === 'cardio' || name.includes('jump') || name.includes('burpee') || name.includes('run')) {
    return 'cardio';
  }

  if (name.includes('stretch') || name.includes('yoga') || name.includes('flexibility')) {
    return 'flexibility';
  }

  if (name.includes('balance') || name.includes('stability')) {
    return 'balance';
  }

  return 'strength';
}

/**
 * Generate semantic description for vector embedding
 */
function generateSemanticDescription(exercise) {
  const parts = [];

  parts.push(exercise.name);
  parts.push(`targets ${exercise.target || 'multiple muscles'}`);
  parts.push(`using ${exercise.equipment || 'body weight'}`);

  if (exercise.secondaryMuscles && exercise.secondaryMuscles.length > 0) {
    parts.push(`also works ${exercise.secondaryMuscles.slice(0, 3).join(', ')}`);
  }

  if (exercise.instructions && exercise.instructions.length > 0) {
    // First instruction usually describes the starting position
    parts.push(exercise.instructions[0]);
  }

  return parts.join('. ');
}

/**
 * Enrich exercise with computed fields
 */
function enrichExercise(exercise) {
  const movementPattern = getMovementPattern(exercise);
  const popularityScore = calculatePopularityScore(exercise);
  const easeScore = calculateEaseScore(exercise);
  const difficulty = determineDifficulty(exercise);
  const category = determineCategory(exercise);
  const semanticDescription = generateSemanticDescription(exercise);

  return {
    id: exercise.id,
    name: exercise.name,
    bodyPart: exercise.bodyPart,
    equipment: exercise.equipment,
    target: exercise.target,
    secondaryMuscles: exercise.secondaryMuscles || [],
    instructions: exercise.instructions || [],
    gifUrl: exercise.gifUrl,
    // Computed fields
    difficulty,
    category,
    movementPattern,
    popularityScore,
    easeScore,
    semanticDescription,
  };
}

/**
 * Fetch all exercises with pagination
 */
async function fetchAllExercises() {
  console.log('Starting ExerciseDB data fetch...');
  console.log(`Using API Key: ${API_KEY.substring(0, 10)}...`);
  console.log(`Output path: ${OUTPUT_PATH}`);

  const allExercises = [];
  let offset = 0;
  let hasMore = true;

  while (hasMore && allExercises.length < EXERCISE_LIMIT) {
    try {
      console.log(`Fetching exercises ${offset} to ${offset + BATCH_SIZE}...`);

      const exercises = await fetchFromAPI('/exercises', {
        limit: BATCH_SIZE,
        offset: offset,
      });

      if (!exercises || exercises.length === 0) {
        hasMore = false;
        break;
      }

      // Enrich each exercise
      const enrichedExercises = exercises.map(enrichExercise);
      allExercises.push(...enrichedExercises);

      console.log(`Fetched ${exercises.length} exercises (total: ${allExercises.length})`);

      if (exercises.length < BATCH_SIZE) {
        hasMore = false;
      } else {
        offset += BATCH_SIZE;
        // Rate limiting delay
        await sleep(RATE_LIMIT_DELAY);
      }
    } catch (error) {
      console.error(`Error fetching exercises at offset ${offset}:`, error.message);

      // If rate limited, wait longer and retry
      if (error.message.includes('429')) {
        console.log('Rate limited, waiting 60 seconds...');
        await sleep(60000);
        continue;
      }

      throw error;
    }
  }

  return allExercises;
}

/**
 * Fetch metadata lists (body parts, equipment, targets)
 */
async function fetchMetadata() {
  console.log('Fetching metadata lists...');

  const [bodyPartList, equipmentList, targetList] = await Promise.all([
    fetchFromAPI('/exercises/bodyPartList'),
    fetchFromAPI('/exercises/equipmentList'),
    fetchFromAPI('/exercises/targetList'),
  ]);

  console.log(`Body parts: ${bodyPartList.length}`);
  console.log(`Equipment types: ${equipmentList.length}`);
  console.log(`Target muscles: ${targetList.length}`);

  return { bodyPartList, equipmentList, targetList };
}

/**
 * Generate statistics about the dataset
 */
function generateStats(exercises) {
  const stats = {
    totalExercises: exercises.length,
    byBodyPart: {},
    byEquipment: {},
    byTarget: {},
    byDifficulty: {},
    byCategory: {},
    byMovementPattern: {},
    averagePopularityScore: 0,
    averageEaseScore: 0,
  };

  let totalPopularity = 0;
  let totalEase = 0;

  exercises.forEach(ex => {
    // Count by body part
    stats.byBodyPart[ex.bodyPart] = (stats.byBodyPart[ex.bodyPart] || 0) + 1;

    // Count by equipment
    stats.byEquipment[ex.equipment] = (stats.byEquipment[ex.equipment] || 0) + 1;

    // Count by target
    stats.byTarget[ex.target] = (stats.byTarget[ex.target] || 0) + 1;

    // Count by difficulty
    stats.byDifficulty[ex.difficulty] = (stats.byDifficulty[ex.difficulty] || 0) + 1;

    // Count by category
    stats.byCategory[ex.category] = (stats.byCategory[ex.category] || 0) + 1;

    // Count by movement pattern
    stats.byMovementPattern[ex.movementPattern] = (stats.byMovementPattern[ex.movementPattern] || 0) + 1;

    totalPopularity += ex.popularityScore;
    totalEase += ex.easeScore;
  });

  stats.averagePopularityScore = (totalPopularity / exercises.length).toFixed(2);
  stats.averageEaseScore = (totalEase / exercises.length).toFixed(2);

  return stats;
}

/**
 * Main execution
 */
async function main() {
  try {
    console.log('═'.repeat(60));
    console.log('  RapidAPI ExerciseDB Data Fetcher');
    console.log('═'.repeat(60));
    console.log('');

    // Fetch metadata first
    const metadata = await fetchMetadata();
    await sleep(RATE_LIMIT_DELAY);

    // Fetch all exercises
    const exercises = await fetchAllExercises();

    // Generate statistics
    const stats = generateStats(exercises);

    // Prepare output
    const output = {
      metadata: {
        fetchedAt: new Date().toISOString(),
        source: 'RapidAPI ExerciseDB',
        apiVersion: '1.0',
        ...metadata,
      },
      statistics: stats,
      exercises: exercises,
    };

    // Ensure output directory exists
    const outputDir = path.dirname(OUTPUT_PATH);
    if (!fs.existsSync(outputDir)) {
      fs.mkdirSync(outputDir, { recursive: true });
    }

    // Write to file
    fs.writeFileSync(OUTPUT_PATH, JSON.stringify(output, null, 2));

    console.log('');
    console.log('═'.repeat(60));
    console.log('  Fetch Complete!');
    console.log('═'.repeat(60));
    console.log('');
    console.log(`Statistics:`);
    console.log(`   Total exercises: ${stats.totalExercises}`);
    console.log(`   By difficulty: ${JSON.stringify(stats.byDifficulty)}`);
    console.log(`   By category: ${JSON.stringify(stats.byCategory)}`);
    console.log(`   Average popularity: ${stats.averagePopularityScore}`);
    console.log(`   Average ease: ${stats.averageEaseScore}`);
    console.log('');
    console.log(`Output written to: ${OUTPUT_PATH}`);
    console.log('');

    // Also write a simplified version for the app (backwards compatible)
    const simplifiedExercises = exercises.map(ex => ({
      id: ex.id,
      name: ex.name,
      bodyPart: ex.bodyPart,
      equipment: ex.equipment,
      target: ex.target,
      secondaryMuscles: ex.secondaryMuscles,
      instructions: ex.instructions,
      gifUrl: ex.gifUrl,
      difficulty: ex.difficulty,
      category: ex.category,
      movementPattern: ex.movementPattern,
      popularityScore: ex.popularityScore,
      easeScore: ex.easeScore,
    }));

    const simplifiedPath = OUTPUT_PATH.replace('.json', '-simplified.json');
    fs.writeFileSync(simplifiedPath, JSON.stringify(simplifiedExercises, null, 2));
    console.log(`Simplified version written to: ${simplifiedPath}`);

  } catch (error) {
    console.error('');
    console.error('Fatal error:', error.message);
    console.error(error.stack);
    process.exit(1);
  }
}

// Run main function
main();

