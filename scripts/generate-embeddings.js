#!/usr/bin/env node

/**
 * Pinecone Embedding Pipeline Script
 * 
 * This script generates embeddings for exercises using OpenAI's embedding API
 * and upserts them to Pinecone for semantic search.
 * 
 * Prerequisites:
 * - Run fetch-exercises.js first to get exercise data
 * - Set environment variables:
 *   - OPENAI_API_KEY: Your OpenAI API key
 *   - PINECONE_API_KEY: Your Pinecone API key
 *   - PINECONE_INDEX: Pinecone index name (default: lift-exercises)
 * 
 * Usage:
 *   node scripts/generate-embeddings.js
 *   node scripts/generate-embeddings.js --input custom-path.json
 *   node scripts/generate-embeddings.js --batch-size 50
 *   node scripts/generate-embeddings.js --dry-run (test without upserting)
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
const OPENAI_API_KEY = process.env.OPENAI_API_KEY || process.env.EXPO_PUBLIC_OPENAI_API_KEY;
const PINECONE_API_KEY = process.env.PINECONE_API_KEY;
const PINECONE_INDEX = process.env.PINECONE_INDEX || 'lift-exercises';
const PINECONE_HOST = process.env.PINECONE_HOST; // e.g., 'lift-exercises-xxxxx.svc.pinecone.io'

const EMBEDDING_MODEL = 'text-embedding-3-small';
const EMBEDDING_DIMENSIONS = 1536;
const BATCH_SIZE = 100; // OpenAI can handle up to 2048 inputs, but Pinecone upserts work better in smaller batches
const RATE_LIMIT_DELAY = 500; // ms between batches

// Parse command line arguments
const args = process.argv.slice(2);
const inputPathIndex = args.indexOf('--input');
const batchSizeIndex = args.indexOf('--batch-size');
const dryRun = args.includes('--dry-run');

const INPUT_PATH = inputPathIndex !== -1 
  ? args[inputPathIndex + 1] 
  : path.join(__dirname, '..', 'data', 'exercises-enriched.json');

const CUSTOM_BATCH_SIZE = batchSizeIndex !== -1 
  ? parseInt(args[batchSizeIndex + 1], 10) 
  : BATCH_SIZE;

/**
 * Sleep for specified milliseconds
 */
function sleep(ms) {
  return new Promise(resolve => setTimeout(resolve, ms));
}

/**
 * Generate embedding text for an exercise
 */
function generateEmbeddingText(exercise) {
  const parts = [];
  
  // Name is most important
  parts.push(exercise.name);
  
  // Target muscle and body part
  parts.push(`${exercise.target || 'general'} exercise`);
  parts.push(`targeting ${exercise.bodyPart || 'full body'}`);
  
  // Equipment
  parts.push(`using ${exercise.equipment || 'body weight'}`);
  
  // Secondary muscles
  if (exercise.secondaryMuscles && exercise.secondaryMuscles.length > 0) {
    parts.push(`also works ${exercise.secondaryMuscles.join(', ')}`);
  }
  
  // Movement pattern
  if (exercise.movementPattern) {
    parts.push(`${exercise.movementPattern} movement`);
  }
  
  // First instruction (describes the movement)
  if (exercise.instructions && exercise.instructions.length > 0) {
    parts.push(exercise.instructions[0]);
  }
  
  // Difficulty
  if (exercise.difficulty) {
    parts.push(`${exercise.difficulty} difficulty`);
  }
  
  return parts.join('. ');
}

/**
 * Call OpenAI Embeddings API
 */
async function generateEmbeddings(texts) {
  try {
    const response = await fetch('https://api.openai.com/v1/embeddings', {
      method: 'POST',
      headers: {
        'Authorization': `Bearer ${OPENAI_API_KEY}`,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({
        model: EMBEDDING_MODEL,
        input: texts,
        dimensions: EMBEDDING_DIMENSIONS,
      }),
    });

    if (!response.ok) {
      const error = await response.text();
      throw new Error(`OpenAI API error: ${response.status} - ${error}`);
    }

    const data = await response.json();
    return data.data.map(item => item.embedding);
  } catch (error) {
    if (error.message.includes('fetch')) {
      throw new Error(`Network error calling OpenAI API: ${error.message}. Check your internet connection and API key.`);
    }
    throw error;
  }
}

/**
 * Initialize Pinecone client (using REST API)
 */
async function initPinecone() {
  if (!PINECONE_API_KEY) {
    throw new Error('PINECONE_API_KEY environment variable is required');
  }
  
  // Get index host from Pinecone API if not provided
  let host = PINECONE_HOST;
  
  if (!host) {
    console.log('Looking up Pinecone index host...');
    
    const response = await fetch(`https://api.pinecone.io/indexes/${PINECONE_INDEX}`, {
      headers: {
        'Api-Key': PINECONE_API_KEY,
      },
    });
    
    if (!response.ok) {
      if (response.status === 404) {
        console.log('Index not found, creating new index...');
        await createPineconeIndex();
        // Wait for index to be ready
        await sleep(30000);
        return initPinecone(); // Retry
      }
      throw new Error(`Failed to get index info: ${response.status}`);
    }
    
    const indexInfo = await response.json();
    host = indexInfo.host;
    console.log(`Found index host: ${host}`);
  }
  
  return { host };
}

/**
 * Create Pinecone index
 */
async function createPineconeIndex() {
  const response = await fetch('https://api.pinecone.io/indexes', {
    method: 'POST',
    headers: {
      'Api-Key': PINECONE_API_KEY,
      'Content-Type': 'application/json',
    },
    body: JSON.stringify({
      name: PINECONE_INDEX,
      dimension: EMBEDDING_DIMENSIONS,
      metric: 'cosine',
      spec: {
        serverless: {
          cloud: 'aws',
          region: 'us-east-1',
        },
      },
    }),
  });

  if (!response.ok) {
    const error = await response.text();
    throw new Error(`Failed to create Pinecone index: ${response.status} - ${error}`);
  }

  console.log(`Created Pinecone index: ${PINECONE_INDEX}`);
}

/**
 * Upsert vectors to Pinecone
 */
async function upsertToPinecone(host, vectors) {
  const response = await fetch(`https://${host}/vectors/upsert`, {
    method: 'POST',
    headers: {
      'Api-Key': PINECONE_API_KEY,
      'Content-Type': 'application/json',
    },
    body: JSON.stringify({
      vectors: vectors,
      namespace: 'exercises',
    }),
  });

  if (!response.ok) {
    const error = await response.text();
    throw new Error(`Pinecone upsert error: ${response.status} - ${error}`);
  }

  return response.json();
}

/**
 * Process exercises in batches
 */
async function processExercises(exercises, pineconeHost) {
  const totalBatches = Math.ceil(exercises.length / CUSTOM_BATCH_SIZE);
  let processedCount = 0;
  let errorCount = 0;
  
  console.log(`Processing ${exercises.length} exercises in ${totalBatches} batches`);
  console.log(`   Batch size: ${CUSTOM_BATCH_SIZE}`);
  console.log(`   Dry run: ${dryRun}`);
  console.log('');
  
  for (let i = 0; i < exercises.length; i += CUSTOM_BATCH_SIZE) {
    const batchNum = Math.floor(i / CUSTOM_BATCH_SIZE) + 1;
    const batch = exercises.slice(i, i + CUSTOM_BATCH_SIZE);
    
    console.log(`Processing batch ${batchNum}/${totalBatches} (${batch.length} exercises)...`);
    
    try {
      // Generate embedding texts
      const texts = batch.map(generateEmbeddingText);
      
      // Generate embeddings
      const embeddings = await generateEmbeddings(texts);
      
      // Prepare vectors for Pinecone
      const vectors = batch.map((exercise, idx) => ({
        id: exercise.id || `exercise-${i + idx}`,
        values: embeddings[idx],
        metadata: {
          name: exercise.name,
          bodyPart: exercise.bodyPart || '',
          equipment: exercise.equipment || '',
          target: exercise.target || '',
          difficulty: exercise.difficulty || 'intermediate',
          category: exercise.category || 'strength',
          movementPattern: exercise.movementPattern || 'isolation',
          popularityScore: exercise.popularityScore || 5,
          easeScore: exercise.easeScore || 5,
          secondaryMuscles: (exercise.secondaryMuscles || []).join(','),
          hasInstructions: (exercise.instructions && exercise.instructions.length > 0) ? 'true' : 'false',
          hasGif: exercise.gifUrl ? 'true' : 'false',
        },
      }));
      
      // Upsert to Pinecone (unless dry run)
      if (!dryRun) {
        await upsertToPinecone(pineconeHost, vectors);
      }
      
      processedCount += batch.length;
      console.log(`   Batch ${batchNum} complete (${processedCount}/${exercises.length} total)`);
      
      // Rate limiting
      if (i + CUSTOM_BATCH_SIZE < exercises.length) {
        await sleep(RATE_LIMIT_DELAY);
      }
      
    } catch (error) {
      console.error(`   Error in batch ${batchNum}:`, error.message);
      if (error.stack) {
        console.error(`   Stack trace:`, error.stack.split('\n').slice(0, 3).join('\n'));
      }
      errorCount += batch.length;
      
      // If first batch fails, stop immediately to avoid wasting API calls
      if (batchNum === 1) {
        console.error('\n First batch failed - stopping to prevent wasting API calls.');
        console.error('Please check:');
        console.error('1. Your OPENAI_API_KEY is valid');
        console.error('2. You have internet connection');
        console.error('3. OpenAI API is accessible from your network\n');
        break;
      }
      
      // Continue with next batch
      await sleep(2000);
    }
  }
  
  return { processedCount, errorCount };
}

/**
 * Main execution
 */
async function main() {
  try {
    console.log('═'.repeat(60));
    console.log('  Pinecone Embedding Pipeline');
    console.log('═'.repeat(60));
    console.log('');
    
    // Validate environment
    if (!OPENAI_API_KEY) {
      throw new Error('OPENAI_API_KEY environment variable is required');
    }
    
    if (!PINECONE_API_KEY && !dryRun) {
      throw new Error('PINECONE_API_KEY environment variable is required (or use --dry-run)');
    }
    
    // Test OpenAI API key with a small request
    console.log('Testing OpenAI API connection...');
    try {
      const testEmbedding = await generateEmbeddings(['test']);
      console.log('OpenAI API key is valid\n');
    } catch (error) {
      throw new Error(`OpenAI API test failed: ${error.message}\nPlease check your OPENAI_API_KEY in .env file`);
    }
    
    // Load exercise data
    console.log(`Loading exercises from: ${INPUT_PATH}`);
    
    if (!fs.existsSync(INPUT_PATH)) {
      throw new Error(`Input file not found: ${INPUT_PATH}\nRun fetch-exercises.js first.`);
    }
    
    const data = JSON.parse(fs.readFileSync(INPUT_PATH, 'utf-8'));
    const exercises = data.exercises || data; // Support both enriched format and array
    
    console.log(`Loaded ${exercises.length} exercises`);
    console.log('');
    
    // Initialize Pinecone
    let pineconeHost = null;
    if (!dryRun) {
      const pinecone = await initPinecone();
      pineconeHost = pinecone.host;
    } else {
      console.log('DRY RUN MODE - Skipping Pinecone initialization');
    }
    console.log('');
    
    // Process exercises
    const startTime = Date.now();
    const { processedCount, errorCount } = await processExercises(exercises, pineconeHost);
    const duration = ((Date.now() - startTime) / 1000).toFixed(1);
    
    console.log('');
    console.log('═'.repeat(60));
    console.log('  Pipeline Complete!');
    console.log('═'.repeat(60));
    console.log('');
    console.log(`Results:`);
    console.log(`   Processed: ${processedCount} exercises`);
    console.log(`   Errors: ${errorCount} exercises`);
    console.log(`   Duration: ${duration} seconds`);
    console.log(`   Index: ${PINECONE_INDEX}`);
    console.log('');
    
    if (dryRun) {
      console.log('DRY RUN - No data was uploaded to Pinecone');
      console.log('   Run without --dry-run to actually upload embeddings');
    }
    
  } catch (error) {
    console.error('');
    console.error('Fatal error:', error.message);
    console.error(error.stack);
    process.exit(1);
  }
}

// Run main function
main();

