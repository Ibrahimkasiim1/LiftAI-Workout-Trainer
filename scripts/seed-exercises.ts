import { createClient } from '@supabase/supabase-js';
import 'dotenv/config';
import fs from 'fs';
import OpenAI from 'openai';
import path from 'path';
import { fileURLToPath } from 'url'; // Required for __dirname in ESM

// ESM fix for __dirname
const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

// 1. Setup Clients
const supabaseUrl = process.env.EXPO_PUBLIC_SUPABASE_URL!;
const supabaseServiceKey = process.env.SUPABASE_SERVICE_ROLE_KEY!;

if (!supabaseUrl || !supabaseServiceKey) {
    throw new Error("Missing Supabase credentials in .env file");
}

const supabase = createClient(supabaseUrl, supabaseServiceKey);

const openai = new OpenAI({
    apiKey: process.env.OPENAI_API_KEY,
});

// 2. Load your JSON file (Updated Path)
const jsonPath = path.join(__dirname, '../data/List-data-enhanced.json');
console.log(`Loading data from: ${jsonPath}`);

const jsonData = JSON.parse(
    fs.readFileSync(jsonPath, 'utf-8')
);
const exercisesData = jsonData.exercises || jsonData;

async function generateEmbedding(text: string) {
    const response = await openai.embeddings.create({
        model: 'text-embedding-3-small',
        input: text,
        dimensions: 1536,
    });
    return response.data[0].embedding;
}

async function seed() {
    console.log(`Starting seed for ${exercisesData.length} exercises...`);

    for (const exercise of exercisesData) {
        // 3. Create a rich description for the AI to "read"
        const textToEmbed = `
      Name: ${exercise.name}
      Target: ${exercise.target}
      Body Part: ${exercise.bodyPart}
      Equipment: ${exercise.equipment}
      Description: ${exercise.description}
      Instructions: ${exercise.instructions?.join(' ') || ''}
    `.trim();

        try {
            // 4. Generate Vector
            const embedding = await generateEmbedding(textToEmbed);

            // 5. Insert into Supabase
            const { error } = await supabase.from('exercises').upsert({
                id: exercise.id,
                name: exercise.name,
                body_part: exercise.bodyPart,
                equipment: exercise.equipment,
                target_muscle: exercise.target,
                secondary_muscles: exercise.secondaryMuscles,
                instructions: exercise.instructions,
                description: exercise.description,
                difficulty: exercise.difficulty,
                category: exercise.category,
                gif_path: exercise.gifPath,
                embedding: embedding,
            });

            if (error) {
                console.error(`Error inserting ${exercise.name}:`, error.message);
            } else {
                console.log(`Processed: ${exercise.name}`);
            }

        } catch (err) {
            console.error(`Failed to process ${exercise.name}:`, err);
        }

        // Tiny pause to avoid hitting OpenAI rate limits
        await new Promise((resolve) => setTimeout(resolve, 200));
    }
    console.log('Done!');
}

seed();