#!/usr/bin/env node

/**
 * Phase 2 - Clone ExerciseDB dataset from API (no app integration).
 *
 * Outputs:
 * 1) Raw API payload array
 * 2) Normalized array mapped to Lift3-style fields
 *
 * Usage:
 *   node scripts/clone-exercisedb-api.js
 *   node scripts/clone-exercisedb-api.js --limit 200
 *   node scripts/clone-exercisedb-api.js --output data/exercisedb-v1-raw.json
 */

const fs = require("fs");
const path = require("path");

try {
  require("dotenv").config({ path: path.join(__dirname, "..", ".env") });
} catch (_e) {
  // Continue if dotenv is unavailable in some environments.
}

const fetchImpl = globalThis.fetch || require("node-fetch");

const args = process.argv.slice(2);
const outputIndex = args.indexOf("--output");
const limitIndex = args.indexOf("--limit");
const offsetIndex = args.indexOf("--offset");

const outputRawPath =
  outputIndex !== -1
    ? path.resolve(process.cwd(), args[outputIndex + 1])
    : path.join(__dirname, "..", "data", "exercisedb-v1-raw.json");

const maxRecords =
  limitIndex !== -1 ? parseInt(args[limitIndex + 1], 10) : Number.POSITIVE_INFINITY;

const startOffset = offsetIndex !== -1 ? parseInt(args[offsetIndex + 1], 10) : 0;

const API_KEY =
  process.env.EXPO_PUBLIC_EXERCISEDB_API_KEY ||
  process.env.RAPIDAPI_KEY ||
  process.env.EXERCISEDB_API_KEY;
const API_HOST = "exercisedb.p.rapidapi.com";
const BASE_URL = `https://${API_HOST}`;
const PAGE_SIZE = 10;
const RATE_LIMIT_DELAY_MS = 700;

if (!API_KEY) {
  throw new Error(
    "Missing API key. Set one of: EXPO_PUBLIC_EXERCISEDB_API_KEY, RAPIDAPI_KEY, EXERCISEDB_API_KEY"
  );
}

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

async function fetchPage(limit, offset) {
  const url = new URL(`${BASE_URL}/exercises`);
  url.searchParams.set("limit", String(limit));
  url.searchParams.set("offset", String(offset));

  const response = await fetchImpl(url.toString(), {
    method: "GET",
    headers: {
      "X-RapidAPI-Key": API_KEY,
      "X-RapidAPI-Host": API_HOST,
    },
  });

  if (!response.ok) {
    const body = await response.text();
    throw new Error(`ExerciseDB API error ${response.status}: ${body}`);
  }

  return response.json();
}

function normalize(exercise) {
  return {
    id: exercise.id,
    name: exercise.name,
    bodyPart: exercise.bodyPart,
    equipment: exercise.equipment,
    target: exercise.target,
    secondaryMuscles: Array.isArray(exercise.secondaryMuscles) ? exercise.secondaryMuscles : [],
    instructions: Array.isArray(exercise.instructions) ? exercise.instructions : [],
    gifUrl: exercise.gifUrl || null,
  };
}

async function main() {
  console.log("═".repeat(60));
  console.log("  ExerciseDB API Clone (Phase 2)");
  console.log("═".repeat(60));
  console.log(`Output (raw): ${outputRawPath}`);

  const outputDir = path.dirname(outputRawPath);
  if (!fs.existsSync(outputDir)) {
    fs.mkdirSync(outputDir, { recursive: true });
  }

  const raw = [];
  let offset = Math.max(0, startOffset);

  while (raw.length < maxRecords) {
    const take = Math.min(PAGE_SIZE, maxRecords - raw.length);
    const page = await fetchPage(take, offset);

    if (!Array.isArray(page) || page.length === 0) {
      break;
    }

    raw.push(...page);
    console.log(`Fetched ${page.length} records (total: ${raw.length})`);

    if (page.length < PAGE_SIZE) {
      break;
    }

    offset += page.length;
    await sleep(RATE_LIMIT_DELAY_MS);
  }

  const normalized = raw.map(normalize);
  const normalizedPath = outputRawPath.replace(/\.json$/i, "-normalized.json");
  const metaPath = outputRawPath.replace(/\.json$/i, "-meta.json");

  fs.writeFileSync(outputRawPath, JSON.stringify(raw, null, 2));
  fs.writeFileSync(normalizedPath, JSON.stringify(normalized, null, 2));
  fs.writeFileSync(
    metaPath,
    JSON.stringify(
      {
        source: "ExerciseDB via RapidAPI",
        fetchedAt: new Date().toISOString(),
        totalRecords: raw.length,
        apiHost: API_HOST,
        pageSize: PAGE_SIZE,
        startOffset,
      },
      null,
      2
    )
  );

  console.log("");
  console.log(`Saved raw dataset: ${outputRawPath}`);
  console.log(`Saved normalized dataset: ${normalizedPath}`);
  console.log(`Saved metadata: ${metaPath}`);
  console.log("Phase 2 complete.");
}

main().catch((error) => {
  console.error("Fatal error:", error.message);
  process.exit(1);
});

