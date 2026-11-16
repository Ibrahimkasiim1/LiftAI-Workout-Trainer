#!/usr/bin/env node
// Regression tests for utils/navigationGuards.ts — the decision logic that
// keeps the workout player's exit from goBack()-ing a signed-in user onto a
// pre-auth screen. Run: npm run test:navguards
//
// The app has no jest harness, so this compiles the pure module with the
// project's TypeScript and asserts against the compiled output.

import { execFileSync } from 'node:child_process';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, dirname } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const repoRoot = join(dirname(fileURLToPath(import.meta.url)), '..');
const outDir = mkdtempSync(join(tmpdir(), 'navguards-'));

try {
    execFileSync(
        join(repoRoot, 'node_modules', '.bin', 'tsc'),
        [
            join(repoRoot, 'utils', 'navigationGuards.ts'),
            '--outDir', outDir,
            '--module', 'esnext',
            '--target', 'es2020',
        ],
        // cwd = the temp dir: running from the repo root would auto-include
        // every node_modules/@types package, several of which don't compile
        // under tsc's default moduleResolution.
        { stdio: 'inherit', cwd: outDir }
    );

    const { resolveWorkoutExitAction, rootPopLandsOnPreAuthRoute, stackCanPop } =
        await import(pathToFileURL(join(outDir, 'navigationGuards.js')).href);

    const stack = (names, index = names.length - 1) => ({
        index,
        routes: names.map((name) => ({ name })),
    });

    // ── First workout launched straight from the auth/onboarding flow ────────
    // Root [auth, workout], player is the sole route in its group.
    // goBack() would land on the logged-out /auth/welcome; must replace to home.
    assert.equal(
        resolveWorkoutExitAction(stack(['index']), stack(['auth', 'workout'])),
        'replaceHome', 'exit from first workout with auth below');
    // Liability-consent decline, same stack shape.
    assert.equal(
        resolveWorkoutExitAction(stack(['index'], 0), stack(['auth', 'workout'], 1)),
        'replaceHome', 'consent decline with auth below');
    assert.equal(
        resolveWorkoutExitAction(stack(['index']), stack(['onboarding', 'workout'])),
        'replaceHome', 'exit with onboarding group below');
    assert.equal(
        resolveWorkoutExitAction(stack(['index']), stack(['index', 'workout'])),
        'replaceHome', 'exit with cold-start splash below');

    // ── Legit flows that MUST keep goBack ────────────────────────────────────
    assert.equal(
        resolveWorkoutExitAction(stack(['index']), stack(['(tabs)', 'workout'])),
        'goBack', 'workout pushed from home returns to tabs');
    assert.equal(
        resolveWorkoutExitAction(stack(['index']), stack(['(tabs)', 'settings', 'workout'])),
        'goBack', 'deeper legit root history');
    assert.equal(
        resolveWorkoutExitAction(stack(['index', 'exercise-detail']), stack(['auth', 'workout'])),
        'goBack', 'inner workout-group pop wins even over auth');

    // ── When unsure, never goBack into the unknown ───────────────────────────
    assert.equal(
        resolveWorkoutExitAction(stack(['index']), stack(['workout'])),
        'replaceHome', 'player is the only root entry');
    assert.equal(resolveWorkoutExitAction(undefined, undefined), 'replaceHome', 'no nav state');
    assert.equal(resolveWorkoutExitAction(null, { routes: [] }), 'replaceHome', 'empty root routes');
    assert.equal(
        resolveWorkoutExitAction({ routes: null }, { index: 0, routes: [{ name: 'workout' }] }),
        'replaceHome', 'root cannot pop');
    assert.equal(
        resolveWorkoutExitAction(stack(['index']), { index: 1, routes: [null, { name: 'workout' }] }),
        'goBack', 'null route below treated as non-auth');
    assert.equal(
        rootPopLandsOnPreAuthRoute({ index: 1, routes: [{}, { name: 'workout' }] }),
        false, 'nameless route below');
    assert.equal(
        rootPopLandsOnPreAuthRoute({ routes: [{ name: 'auth' }, { name: 'workout' }] }),
        true, 'missing index defaults to last-focused, auth below');
    assert.equal(stackCanPop({ routes: [{ name: 'a' }, { name: 'b' }] }), true, 'missing index can pop');
    assert.equal(stackCanPop({ index: 0, routes: [{ name: 'a' }, { name: 'b' }] }), false, 'index 0 cannot pop');

    console.log('navigationGuards: all 16 assertions passed');
} finally {
    rmSync(outDir, { recursive: true, force: true });
}
