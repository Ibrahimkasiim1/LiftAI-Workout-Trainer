#!/usr/bin/env node

/**
 * Test Script for LangGraph Studio
 * 
 * Run with: node test-studio.js
 */

const BASE_URL = 'http://localhost:3002';

async function testHealth() {
    console.log('Testing health endpoint...');
    const response = await fetch(`${BASE_URL}/health`);
    const data = await response.json();
    console.log('Health:', data);
    return data.ok;
}

async function testGraphStructure() {
    console.log('\nTesting graph structure...');
    const response = await fetch(`${BASE_URL}/api/graph/structure`);
    const data = await response.json();
    console.log('Graph nodes:', data.nodes);
    console.log('Graph edges:', data.edges?.length || 0, 'edges');
    return true;
}

async function testPlannerInvoke() {
    console.log('\nTesting planner invoke...');

    const testInput = {
        userId: 'test-user-' + Date.now(),
        preferences: {
            splitType: 'full-body',
            trainingDays: 3
        }
    };

    console.log('Input:', testInput);

    const response = await fetch(`${BASE_URL}/api/planner/invoke`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(testInput)
    });

    const data = await response.json();

    if (data.success) {
        console.log('Planner executed successfully!');
        console.log('   Plan ID:', data.result.planId);
        console.log('   Split:', data.result.split);
        console.log('   Days:', data.result.dayPlans?.length);
    } else {
        console.log('Planner failed:', data.error);
    }

    return data.success;
}

async function testPlannerStream() {
    console.log('\nTesting planner stream...');

    const testInput = {
        userId: 'test-user-' + Date.now(),
        preferences: {
            splitType: 'upper-lower',
            trainingDays: 4
        }
    };

    console.log('Input:', testInput);

    const response = await fetch(`${BASE_URL}/api/planner/stream`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(testInput)
    });

    const reader = response.body.getReader();
    const decoder = new TextDecoder();

    let chunkCount = 0;

    while (true) {
        const { done, value } = await reader.read();
        if (done) break;

        const chunk = decoder.decode(value);
        const lines = chunk.split('\n');

        for (const line of lines) {
            if (line.startsWith('data: ')) {
                const data = line.slice(6);
                if (data === '[DONE]') {
                    console.log('Stream complete!');
                } else {
                    chunkCount++;
                    try {
                        const parsed = JSON.parse(data);
                        const nodeNames = Object.keys(parsed);
                        console.log(`   Chunk ${chunkCount}: ${nodeNames.join(', ')}`);
                    } catch (e) {
                        // Ignore
                    }
                }
            }
        }
    }

    return chunkCount > 0;
}

async function runAllTests() {
    console.log('╔════════════════════════════════════════════════════════════╗');
    console.log('║                                                            ║');
    console.log('║   LangGraph Studio Test Suite                          ║');
    console.log('║                                                            ║');
    console.log('╚════════════════════════════════════════════════════════════╝\n');

    try {
        const results = {
            health: await testHealth(),
            structure: await testGraphStructure(),
            invoke: await testPlannerInvoke(),
            stream: await testPlannerStream(),
        };

        console.log('\n╔════════════════════════════════════════════════════════════╗');
        console.log('║                                                            ║');
        console.log('║   Test Results                                          ║');
        console.log('║                                                            ║');
        console.log('╚════════════════════════════════════════════════════════════╝\n');

        Object.entries(results).forEach(([test, passed]) => {
            const icon = passed ? 'PASS' : 'FAIL';
            console.log(`${icon} ${test.padEnd(20)} ${passed ? 'PASSED' : 'FAILED'}`);
        });

        const allPassed = Object.values(results).every(r => r);

        if (allPassed) {
            console.log('\nAll tests passed!');
            console.log('\nOpen http://localhost:3002 to use the web UI');
        } else {
            console.log('\n Some tests failed. Check the logs above.');
        }

    } catch (error) {
        console.error('\nTest suite error:', error.message);
        console.log('\nMake sure the studio server is running:');
        console.log('   cd backend && npm run studio');
    }
}

runAllTests();
