/**
 * Temporary diagnostic: POST /api/generate-plan (auth required).
 * Pass a Supabase access JWT that matches the user id you want to test (real profile in DB),
 * or use a test-* user id with a JWT for that same id.
 *
 * Run:
 *   LIFT_DIAGNOSTIC_JWT=<access_token> npx tsx scripts/diagnostic-generate-plan.ts
 */
import "dotenv/config";

const PORT = process.env.PORT || "3001";
const BASE = `http://127.0.0.1:${PORT}`;

async function main() {
    const jwt = process.env.LIFT_DIAGNOSTIC_JWT || process.env.SUPABASE_ACCESS_TOKEN;
    if (!jwt) {
        console.error("Set LIFT_DIAGNOSTIC_JWT (or SUPABASE_ACCESS_TOKEN) to a valid Supabase access_token.");
        process.exit(1);
    }

    console.log(`POST ${BASE}/api/generate-plan (Bearer token)\n`);

    const res = await fetch(`${BASE}/api/generate-plan`, {
        method: "POST",
        headers: {
            "Content-Type": "application/json",
            Authorization: `Bearer ${jwt}`,
        },
        body: JSON.stringify({}),
    });

    const text = await res.text();
    let json: unknown;
    try {
        json = JSON.parse(text);
    } catch {
        console.error("Non-JSON response:", text.slice(0, 500));
        process.exit(1);
    }

    const body = json as Record<string, unknown>;
    console.log("HTTP", res.status, body.success ? "OK" : "FAIL");
    if (!body.success) {
        console.log(JSON.stringify(body, null, 2));
        process.exit(1);
    }

    const plan = body.plan as Record<string, unknown> | undefined;
    const days = (plan?.days || []) as Array<Record<string, unknown>>;
    let total = 0;
    let missingGif = 0;
    for (const d of days) {
        const structured = (d.exercises_structured || []) as Array<{ name?: string; gif_path?: string }>;
        total += structured.length;
        for (const ex of structured) {
            if (!ex.gif_path) missingGif++;
        }
    }
    console.log(`Days: ${days.length}, structured exercises: ${total}, missing gif_path: ${missingGif}`);
    console.log("\n--- First day sample (truncated) ---");
    const first = days[0];
    if (first) {
        const structured = (first.exercises_structured || []) as object[];
        console.log(
            JSON.stringify(
                {
                    day_of_week: first.day_of_week,
                    split_day_name: first.split_day_name,
                    exercises_structured: structured.slice(0, 3),
                },
                null,
                2
            )
        );
    }
}

main().catch((e) => {
    console.error(e);
    process.exit(1);
});
