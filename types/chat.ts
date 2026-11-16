/**
 * Chat Types
 * 
 * Shared types for AI chat/coaching interactions
 * Used across frontend (Expo) and backend (Node.js)
 */

// ============================================================================
// CHAT MESSAGES
// ============================================================================

export type ChatRole = 'user' | 'assistant' | 'system';

export interface ChatMessage {
    id?: string;
    conversation_id: string;
    user_id: string;
    role: ChatRole;
    content: string;
    metadata?: ChatMessageMetadata;
    created_at: string;
}

export interface ChatMessageMetadata {
    intent?: ChatIntent;
    topic?: string;
    workout_id?: string;
    plan_id?: string;
    exercise_name?: string;
    confidence?: number;
    [key: string]: unknown; // Allow additional metadata
}

// ============================================================================
// CHAT INTENTS
// ============================================================================

export type ChatIntent =
    | 'qna'                // General Q&A
    | 'edit-plan'          // Edit workout plan
    | 'quick-workout'      // Generate quick workout
    | 'today-adjust'       // Adjust today's workout
    | 'motivation'         // Motivational support
    | 'form-check'         // Exercise form guidance
    | 'nutrition'          // Nutrition advice
    | 'injury'             // Injury-related question
    | 'unknown';           // Intent not recognized

// ============================================================================
// CHAT CONVERSATIONS
// ============================================================================

export interface Conversation {
    id: string;
    user_id: string;
    title?: string;
    started_at: string;
    last_message_at?: string;
    message_count: number;
    archived: boolean;
}

export interface ConversationSummary {
    conversation_id: string;
    user_id: string;
    first_user_message: string;
    message_count: number;
    started_at: string;
    last_message_at: string;
}

// ============================================================================
// CHAT REQUESTS & RESPONSES
// ============================================================================

export interface ChatRequest {
    user_id: string;
    message: string;
    conversation_id?: string;
    intent?: ChatIntent;
    context?: ChatContext;
}

export interface ChatResponse {
    message: string;
    intent: ChatIntent;
    topic?: string;
    confidence?: number;
    suggestions?: string[];
    workout_plan?: unknown; // WorkoutPlan type (avoid circular dep)
    quick_workout?: unknown; // DailyWorkout type
    metadata?: Record<string, unknown>;
}

export interface ChatContext {
    current_workout_id?: string;
    current_plan_id?: string;
    day_index?: number;
    request?: string;
    [key: string]: unknown;
}

// ============================================================================
// AGENT TYPES
// ============================================================================

export interface AgentMessage {
    role: 'system' | 'user' | 'assistant' | 'tool';
    content: string;
    name?: string;
    tool_call_id?: string;
    tool_calls?: ToolCall[];
}

export interface ToolCall {
    id: string;
    type: 'function';
    function: {
        name: string;
        arguments: string; // JSON string
    };
}

export interface AgentResponse {
    content: string;
    tool_calls?: ToolCall[];
    metadata?: {
        tokens_used?: number;
        model?: string;
        intent?: string;
    };
}

// ============================================================================
// COACHING TOPICS
// ============================================================================

export type CoachingTopic =
    | 'form'
    | 'nutrition'
    | 'recovery'
    | 'motivation'
    | 'injury'
    | 'programming'
    | 'general';

export interface CoachingResponse {
    response: string;
    topic: CoachingTopic;
    resources?: CoachingResource[];
}

export interface CoachingResource {
    type: 'article' | 'video' | 'exercise' | 'plan';
    title: string;
    url?: string;
    description?: string;
}

// ============================================================================
// CHAT HISTORY
// ============================================================================

export interface ChatHistory {
    conversation_id: string;
    messages: ChatMessage[];
    total_messages: number;
    oldest_message_date: string;
    newest_message_date: string;
}

export interface ChatHistoryFilters {
    conversation_id?: string;
    start_date?: string;
    end_date?: string;
    role?: ChatRole;
    limit?: number;
    offset?: number;
}
