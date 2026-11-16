/**
 * Chat FSM (Finite State Machine)
 * 
 * Manages chat UI state transitions for handling streaming responses,
 * workout generation, and user interactions.
 */

// ============================================================================
// TYPES
// ============================================================================

export type ChatState =
    | 'idle'              // Ready for user input
    | 'sending'           // Message being sent
    | 'streaming'         // Receiving streamed response
    | 'workout_preview'   // Showing workout preview
    | 'confirming'        // Waiting for user confirmation
    | 'locked'            // Workout saved; user should start a new chat
    | 'error';            // Error state

export type ChatAction =
    | { type: 'SEND' }
    | { type: 'TEXT_START' }
    | { type: 'TEXT_DONE' }
    | { type: 'WORKOUT_DATA'; workoutData?: any }
    | { type: 'CONFIRM' }
    | { type: 'CANCEL' }
    | { type: 'WORKOUT_CONFIRMED' }
    | { type: 'ERROR'; error?: string }
    | { type: 'RESET' };

export interface ChatFSMState {
    state: ChatState;
    error?: string;
    workoutData?: any;
}

// ============================================================================
// FSM CREATION
// ============================================================================

export function createChatFSM(): ChatFSMState {
    return {
        state: 'idle',
        error: undefined,
        workoutData: undefined,
    };
}

// ============================================================================
// FSM REDUCER
// ============================================================================

export function reduceChatFSM(current: ChatFSMState, action: ChatAction): ChatFSMState {
    switch (action.type) {
        case 'SEND':
            return { ...current, state: 'sending', error: undefined };

        case 'TEXT_START':
            return { ...current, state: 'streaming' };

        case 'TEXT_DONE':
            // End-of-turn finalization fires TEXT_DONE unconditionally so the
            // FSM can never stay stuck in 'streaming' (input locked forever)
            // after an error/stop — but it must not unlock a confirmed-workout
            // 'locked' chat.
            return current.state === 'locked' ? current : { ...current, state: 'idle' };

        case 'WORKOUT_DATA':
            return {
                ...current,
                state: 'workout_preview',
                workoutData: action.workoutData
            };

        case 'CONFIRM':
            return { ...current, state: 'confirming' };

        case 'WORKOUT_CONFIRMED':
            // Previously → 'locked' (input disabled, "start a new chat" banner).
            // The lock existed to stop duplicate workout builds, but the
            // backend enforces that deterministically now (one builder
            // mutation per turn + idempotency keys), so the chat stays alive
            // for follow-ups ("how heavy should I go?", "swap the last one").
            return { ...current, state: 'idle', workoutData: undefined };

        case 'CANCEL':
            return { ...current, state: 'idle', workoutData: undefined };

        case 'ERROR':
            return { ...current, state: 'error', error: action.error };

        case 'RESET':
            return createChatFSM();

        default:
            return current;
    }
}

// ============================================================================
// FSM HELPERS
// ============================================================================

/**
 * Check if input should be disabled based on current state
 */
export function isInputDisabled(state: ChatFSMState): boolean {
    return ['sending', 'streaming', 'confirming', 'locked'].includes(state.state);
}

/**
 * Check if the chat is locked (no interaction allowed)
 */
export function isChatLocked(state: ChatFSMState): boolean {
    return ['sending', 'confirming', 'locked'].includes(state.state);
}

/**
 * Get placeholder text based on current state
 * @param activityHint Optional override while LangGraph tools are running (from SSE tool_start)
 */
export function getInputPlaceholder(state: ChatFSMState, activityHint?: string | null): string {
    const hint = activityHint?.trim();
    if (hint) {
        return hint;
    }
    switch (state.state) {
        case 'sending':
            return 'Sending...';
        case 'streaming':
            return 'AI is responding...';
        case 'confirming':
            return 'Please confirm or cancel...';
        case 'locked':
            return 'Start a new chat to keep going...';
        case 'error':
            return 'Try again...';
        default:
            return 'Ask me anything about fitness...';
    }
}
