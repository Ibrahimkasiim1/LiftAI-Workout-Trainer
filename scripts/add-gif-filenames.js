const fs = require('fs');
const path = require('path');

// Helper function to convert exercise name to GIF filename format
function nameToGifFormat(name) {
    return name
        .toLowerCase()
        .replace(/\//g, '-')       // Replace / with -
        .replace(/\s+/g, '-')      // Replace spaces with -
        .replace(/[()]/g, '')      // Remove parentheses
        .replace(/°/g, '')         // Remove degree symbol
        .replace(/'/g, '')         // Remove apostrophes
        .replace(/\./g, '')        // Remove periods
        .replace(/-+/g, '-')       // Replace multiple hyphens with single hyphen
        .replace(/^-|-$/g, '');    // Remove leading/trailing hyphens
}

// Read the exercise data
const dataPath = path.join(__dirname, '../data/List-data.json');
const exerciseData = JSON.parse(fs.readFileSync(dataPath, 'utf8'));

// Get all GIF files organized by body part
const gifsPath = path.join(__dirname, '../data/exercise-gifs');
const bodyPartFolders = fs.readdirSync(gifsPath).filter(item => {
    const itemPath = path.join(gifsPath, item);
    return fs.statSync(itemPath).isDirectory();
});

// Create a map of all GIF files
const gifMap = new Map();
bodyPartFolders.forEach(folder => {
    const folderPath = path.join(gifsPath, folder);
    const gifFiles = fs.readdirSync(folderPath).filter(file => file.endsWith('.gif'));

    gifFiles.forEach(gifFile => {
        const key = gifFile.replace('.gif', '');
        gifMap.set(key, {
            filename: gifFile,
            folder: folder,
            relativePath: `${folder}/${gifFile}`
        });
    });
});

// Process exercises and add GIF filenames
let matchedCount = 0;
let unmatchedCount = 0;
const unmatchedExercises = [];

const enhancedExercises = exerciseData.exercises.map(exercise => {
    const expectedGifName = `${exercise.id}_${nameToGifFormat(exercise.name)}`;

    let gifInfo = gifMap.get(expectedGifName);

    // If not found with exact match, try searching for similar names
    if (!gifInfo) {
        // Search through all GIF files that start with the exercise ID
        for (const [key, value] of gifMap.entries()) {
            if (key.startsWith(exercise.id + '_')) {
                gifInfo = value;
                console.log(`Fuzzy matched: ${exercise.name} (ID: ${exercise.id}) -> ${key}`);
                break;
            }
        }
    }

    if (gifInfo) {
        matchedCount++;
        return {
            ...exercise,
            gifFile: gifInfo.filename,
            gifPath: gifInfo.relativePath
        };
    } else {
        unmatchedCount++;
        unmatchedExercises.push({
            id: exercise.id,
            name: exercise.name,
            bodyPart: exercise.bodyPart,
            expectedGifName: expectedGifName
        });
        return {
            ...exercise,
            gifFile: null,
            gifPath: null
        };
    }
});

// Create the new enhanced data
const enhancedData = {
    exercises: enhancedExercises
};

// Write the enhanced data to a new file
const outputPath = path.join(__dirname, '../data/List-data-enhanced.json');
fs.writeFileSync(outputPath, JSON.stringify(enhancedData, null, 2));

// Write unmatched exercises to a separate file for review
if (unmatchedExercises.length > 0) {
    const unmatchedPath = path.join(__dirname, '../data/unmatched-exercises.json');
    fs.writeFileSync(unmatchedPath, JSON.stringify(unmatchedExercises, null, 2));
}

// Print summary
console.log('\n=== GIF Matching Summary ===');
console.log(`Total exercises: ${exerciseData.exercises.length}`);
console.log(`Matched: ${matchedCount}`);
console.log(`Unmatched: ${unmatchedCount}`);
console.log(`\nEnhanced data written to: ${outputPath}`);
if (unmatchedExercises.length > 0) {
    console.log(`Unmatched exercises written to: ${path.join(__dirname, '../data/unmatched-exercises.json')}`);
}
console.log('\n=== Sample Matched Exercises ===');
enhancedExercises.slice(0, 5).forEach(ex => {
    if (ex.gifFile) {
        console.log(`${ex.id} - ${ex.name}: ${ex.gifPath}`);
    }
});
