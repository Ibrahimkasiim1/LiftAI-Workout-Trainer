#!/usr/bin/env node

/**
 * Exercise GIF Downloader
 * 
 * This script downloads all exercise GIF images from the RapidAPI ExerciseDB
 * and saves them locally in organized folders.
 * 
 * Features:
 * - Downloads GIFs for all exercises in the database
 * - Organizes by body part for easy browsing
 * - Handles rate limiting and retries
 * - Resumes from last download if interrupted
 * - Shows progress and statistics
 * 
 * Usage:
 *   node scripts/download-exercise-gifs.js
 *   node scripts/download-exercise-gifs.js --output custom/path (default: data/exercise-gifs)
 *   node scripts/download-exercise-gifs.js --source data/custom-exercises.json
 *   node scripts/download-exercise-gifs.js --limit 50 (for testing)
 *   node scripts/download-exercise-gifs.js --api-key YOUR_API_KEY
 */

const fs = require('fs');
const path = require('path');
const https = require('https');
const http = require('http');

// Try to load .env file if it exists
try {
    require('dotenv').config({ path: path.join(__dirname, '..', '.env') });
} catch (e) {
    // dotenv not installed or .env doesn't exist, continue with system env vars
}

// Parse command line arguments
const args = process.argv.slice(2);
const outputPathIndex = args.indexOf('--output');
const sourceIndex = args.indexOf('--source');
const limitIndex = args.indexOf('--limit');
const apiKeyIndex = args.indexOf('--api-key');
const retryFailedOnly = args.includes('--retry-failed-only');
const max429Index = args.indexOf('--max-429');
const failedPathIndex = args.indexOf('--failed-path');

const OUTPUT_DIR = outputPathIndex !== -1
    ? args[outputPathIndex + 1]
    : path.join(__dirname, '..', 'data', 'exercise-gifs');

const SOURCE_FILE = sourceIndex !== -1
    ? args[sourceIndex + 1]
    : path.join(__dirname, '..', 'data', 'exercises-enriched.json');

const DOWNLOAD_LIMIT = limitIndex !== -1
    ? parseInt(args[limitIndex + 1], 10)
    : Infinity;
const MAX_CONSECUTIVE_429 = max429Index !== -1
    ? parseInt(args[max429Index + 1], 10)
    : 8;
const FAILED_PATH = failedPathIndex !== -1
    ? args[failedPathIndex + 1]
    : path.join(OUTPUT_DIR, 'failed-downloads.json');

const API_KEY = apiKeyIndex !== -1
    ? args[apiKeyIndex + 1]
    : (process.env.RAPIDAPI_KEY || process.env.EXPO_PUBLIC_EXERCISEDB_API_KEY || process.env.EXERCISEDB_API_KEY);

if (!API_KEY) {
    console.error(
        'Missing API key. Pass --api-key <key> or set one of: RAPIDAPI_KEY, EXPO_PUBLIC_EXERCISEDB_API_KEY, EXERCISEDB_API_KEY'
    );
    process.exit(1);
}

// Configuration
const CONCURRENT_DOWNLOADS = 1; // Keep low to avoid RapidAPI throttling
const RETRY_ATTEMPTS = 8;
const RETRY_DELAY = 2000; // ms

// Progress tracking
let totalExercises = 0;
let processedExercises = 0;
let successfulDownloads = 0;
let failedDownloads = 0;
let skippedExercises = 0;
let consecutive429 = 0;
let quotaExhausted = false;
let failedIdSet = new Set();

/**
 * Sleep for specified milliseconds
 */
function sleep(ms) {
    return new Promise(resolve => setTimeout(resolve, ms));
}

function loadFailedIds(filePath) {
    try {
        if (!fs.existsSync(filePath)) return new Set();
        const raw = JSON.parse(fs.readFileSync(filePath, 'utf8'));
        const ids = Array.isArray(raw?.failedIds) ? raw.failedIds : [];
        return new Set(ids.map(String));
    } catch (_err) {
        return new Set();
    }
}

function saveFailedIds(filePath, failedIds) {
    const payload = {
        updatedAt: new Date().toISOString(),
        failedIds: [...failedIds].sort(),
        count: failedIds.size,
    };
    fs.writeFileSync(filePath, JSON.stringify(payload, null, 2));
}

/**
 * Download a file from URL to local path
 */
function downloadFile(url, filepath) {
    return new Promise((resolve, reject) => {
        const protocol = url.startsWith('https') ? https : http;

        const file = fs.createWriteStream(filepath);

        protocol.get(url, (response) => {
            // Handle redirects
            if (response.statusCode === 301 || response.statusCode === 302) {
                file.close();
                fs.unlinkSync(filepath);
                return downloadFile(response.headers.location, filepath)
                    .then(resolve)
                    .catch(reject);
            }

            if (response.statusCode !== 200) {
                file.close();
                fs.unlinkSync(filepath);
                const err = new Error(`Failed to download: ${response.statusCode}`);
                err.statusCode = response.statusCode;
                err.retryAfter = response.headers['retry-after'];
                return reject(err);
            }

            response.pipe(file);

            file.on('finish', () => {
                file.close();
                resolve(filepath);
            });
        }).on('error', (err) => {
            file.close();
            fs.unlinkSync(filepath);
            reject(err);
        });
    });
}

/**
 * Download a GIF with retry logic
 */
async function downloadGifWithRetry(exercise, outputPath, attempt = 1) {
    try {
        await downloadFile(exercise.gifUrl, outputPath);
        return { success: true, statusCode: 200 };
    } catch (error) {
        if (attempt < RETRY_ATTEMPTS) {
            if (error && error.statusCode === 429) {
                // Exponential-ish backoff for aggressive API throttling windows.
                const retryAfterHeader = Number(error.retryAfter);
                const retryAfterMs = Number.isFinite(retryAfterHeader) && retryAfterHeader > 0
                    ? retryAfterHeader * 1000
                    : 0;
                const cooldownMs = Math.max(retryAfterMs, Math.min(120000, 15000 * attempt));
                console.log(`   429 throttled, cooling down ${Math.round(cooldownMs / 1000)}s before retry`);
                await sleep(cooldownMs);
            }
            console.log(`    Retry ${attempt}/${RETRY_ATTEMPTS} for ${exercise.name}`);
            await sleep(RETRY_DELAY);
            return downloadGifWithRetry(exercise, outputPath, attempt + 1);
        }
        console.error(`   Failed to download ${exercise.name}: ${error.message}`);
        return { success: false, statusCode: error?.statusCode || 0 };
    }
}

/**
 * Sanitize filename to be filesystem-safe
 */
function sanitizeFilename(name) {
    return name
        .toLowerCase()
        .replace(/[^a-z0-9]+/g, '-')
        .replace(/^-+|-+$/g, '');
}

/**
 * Process a single exercise
 */
async function processExercise(exercise, outputDir) {
    processedExercises++;

    // Prefer direct gifUrl from dataset to avoid RapidAPI image endpoint rate limits.
    // Fallback to legacy endpoint only if gifUrl is missing.
    const gifUrl =
        exercise.gifUrl ||
        `https://exercisedb.p.rapidapi.com/image?exerciseId=${exercise.id}&resolution=360&rapidapi-key=${API_KEY}`;

    // Create filename from exercise ID and name
    const filename = `${exercise.id}_${sanitizeFilename(exercise.name)}.gif`;
    const bodyPartDir = path.join(outputDir, sanitizeFilename(exercise.bodyPart || 'other'));
    const outputPath = path.join(bodyPartDir, filename);

    // Skip if already exists
    if (fs.existsSync(outputPath)) {
        skippedExercises++;
        console.log(` [${processedExercises}/${totalExercises}] Skipped ${exercise.name} (already exists)`);
        return { success: true, statusCode: 200 };
    }

    // Ensure directory exists
    if (!fs.existsSync(bodyPartDir)) {
        fs.mkdirSync(bodyPartDir, { recursive: true });
    }

    // Download the GIF
    console.log(` [${processedExercises}/${totalExercises}] Downloading ${exercise.name}...`);
    const result = await downloadGifWithRetry({ ...exercise, gifUrl }, outputPath);

    if (result.success) {
        consecutive429 = 0;
        failedIdSet.delete(String(exercise.id));
        successfulDownloads++;
        console.log(`   Saved to ${path.relative(outputDir, outputPath)}`);
    } else {
        failedDownloads++;
        failedIdSet.add(String(exercise.id));
        if (result.statusCode === 429) {
            consecutive429++;
            if (consecutive429 >= MAX_CONSECUTIVE_429) {
                quotaExhausted = true;
            }
        } else {
            consecutive429 = 0;
        }
    }

    return result;
}

/**
 * Process exercises in batches with concurrency control
 */
async function processBatch(exercises, startIndex, outputDir) {
    if (quotaExhausted) return;
    const batch = exercises.slice(startIndex, startIndex + CONCURRENT_DOWNLOADS);

    if (batch.length === 0) {
        return;
    }

    await Promise.all(batch.map(exercise => processExercise(exercise, outputDir)));

    // Small delay between batches to be respectful
    await sleep(500);

    // Process next batch
    if (!quotaExhausted && startIndex + CONCURRENT_DOWNLOADS < exercises.length) {
        await processBatch(exercises, startIndex + CONCURRENT_DOWNLOADS, outputDir);
    }
}

/**
 * Main execution
 */
async function main() {
    try {
        console.log('═'.repeat(60));
        console.log('  Exercise GIF Downloader');
        console.log('═'.repeat(60));
        console.log('');

        // Load exercise data
        console.log(`Loading exercise data from: ${SOURCE_FILE}`);

        if (!fs.existsSync(SOURCE_FILE)) {
            throw new Error(`Source file not found: ${SOURCE_FILE}\nPlease run fetch-exercises.js first to fetch exercise data.`);
        }

        const data = JSON.parse(fs.readFileSync(SOURCE_FILE, 'utf8'));
        let exercises = data.exercises || data;
        failedIdSet = loadFailedIds(FAILED_PATH);

        // Apply limit if specified
        if (DOWNLOAD_LIMIT < Infinity) {
            exercises = exercises.slice(0, DOWNLOAD_LIMIT);
        }

        if (retryFailedOnly) {
            exercises = exercises.filter(ex => failedIdSet.has(String(ex.id)));
            console.log(`Retry-failed-only mode active. Retrying ${exercises.length} exercises from ${FAILED_PATH}`);
        }

        totalExercises = exercises.length;

        console.log(`Loaded ${totalExercises} exercises`);
        console.log(`Output directory: ${OUTPUT_DIR}`);
        console.log(`Failed list path: ${FAILED_PATH}`);
        console.log('');

        // Ensure output directory exists
        if (!fs.existsSync(OUTPUT_DIR)) {
            fs.mkdirSync(OUTPUT_DIR, { recursive: true });
        }

        // Start downloading
        console.log('Starting downloads...');
        console.log('');

        const startTime = Date.now();

        // Process in batches
        await processBatch(exercises, 0, OUTPUT_DIR);
        saveFailedIds(FAILED_PATH, failedIdSet);

        const endTime = Date.now();
        const duration = ((endTime - startTime) / 1000).toFixed(2);

        // Final statistics
        console.log('');
        console.log('═'.repeat(60));
        console.log('  Download Complete!');
        console.log('═'.repeat(60));
        console.log('');
        console.log(`Statistics:`);
        console.log(`   Total exercises: ${totalExercises}`);
        console.log(`   Successfully downloaded: ${successfulDownloads}`);
        console.log(`   Skipped (already exist): ${skippedExercises}`);
        console.log(`   Failed: ${failedDownloads}`);
        console.log(`   Outstanding failed IDs: ${failedIdSet.size}`);
        console.log(`   Quota exhausted: ${quotaExhausted ? 'yes' : 'no'}`);
        console.log(`   Duration: ${duration}s`);
        console.log('');
        console.log(`GIFs saved to: ${OUTPUT_DIR}`);
        console.log(`Failed IDs saved to: ${FAILED_PATH}`);
        console.log('');

        // Create a manifest file
        const manifest = {
            downloadedAt: new Date().toISOString(),
            totalExercises,
            successfulDownloads,
            skippedExercises,
            failedDownloads,
            failedIdCount: failedIdSet.size,
            quotaExhausted,
            duration: `${duration}s`,
            outputDirectory: OUTPUT_DIR,
            failedPath: FAILED_PATH,
            byBodyPart: {}
        };

        // Count files by body part
        const bodyPartDirs = fs.readdirSync(OUTPUT_DIR);
        bodyPartDirs.forEach(dir => {
            const dirPath = path.join(OUTPUT_DIR, dir);
            if (fs.statSync(dirPath).isDirectory()) {
                const files = fs.readdirSync(dirPath).filter(f => f.endsWith('.gif'));
                manifest.byBodyPart[dir] = files.length;
            }
        });

        const manifestPath = path.join(OUTPUT_DIR, 'download-manifest.json');
        fs.writeFileSync(manifestPath, JSON.stringify(manifest, null, 2));
        console.log(`Manifest saved to: ${manifestPath}`);
        console.log('');

    } catch (error) {
        console.error('');
        console.error('Fatal error:', error.message);
        console.error(error.stack);
        process.exit(1);
    }
}

// Run main function
main();
