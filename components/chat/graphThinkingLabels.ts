/**
 * Short, coach-like "thinking" copy shown while a LangGraph node runs — used
 * only as the brief fallback BEFORE the model's own request-specific line
 * (its `preamble` / dynamic tool label, streamed via the SSE `status` /
 * `tool_start` events) arrives.
 *
 * Each node maps to a few phrasings; we pick one at random so repeated requests
 * don't read like a canned, robotic loop.
 *
 * @see backend/src/agents/supervisorGraph.ts
 */
export const GRAPH_NODE_THINKING_MESSAGES: Record<string, string[]> = {
    // Public stage tokens (current backend — internal node ids never leave the
    // server; see PUBLIC_GRAPH_STAGE in backend/src/routes/chat.ts).
    thinking: [
        'Thinking through your request…',
        'Figuring out the best move…',
        'Lining up the right approach…',
    ],
    planning: ['Shaping your plan…', 'Mapping out your training…', 'Designing your program…'],
    editing: ['Reworking your workout…', 'Making those changes…', 'Adjusting your session…'],
    analyzing: [
        'Reviewing your recent training…',
        'Checking your progress…',
        'Looking at your numbers…',
    ],
    working: ['Putting it together…', 'On it…', 'Pulling the pieces together…'],
    checking: ['Double-checking the details…', 'Final once-over…', 'Making sure it all fits…'],
    finishing: ['Wrapping that up…', 'Almost there…'],

    // Legacy raw node ids (older backend builds) — keep until every deployed
    // backend emits the public tokens above.
    trainer: ['Got it — thinking…', 'Taking that in…'],
    supervisor: [
        'Thinking through your request…',
        'Figuring out the best move…',
        'Lining up the right approach…',
    ],
    planner_agent: ['Shaping your plan…', 'Mapping out your training…', 'Designing your program…'],
    editor_agent: ['Reworking your workout…', 'Making those changes…', 'Adjusting your session…'],
    analyst_agent: [
        'Reviewing your recent training…',
        'Checking your progress…',
        'Looking at your numbers…',
    ],
    memory: ['Recalling what I know about you…', 'Pulling up your preferences…'],
    execute_tools: ['Putting it together…', 'On it…', 'Pulling the pieces together…'],
    validator: ['Double-checking the details…', 'Final once-over…', 'Making sure it all fits…'],
};

const DEFAULT_MESSAGES = ['Working on it…', 'One sec…'];

function pick(options: string[]): string {
    return options[Math.floor(Math.random() * options.length)] ?? options[0];
}

export function messageForGraphNode(node: string): string {
    return pick(GRAPH_NODE_THINKING_MESSAGES[node] ?? DEFAULT_MESSAGES);
}
