/**
 * Backend API Client
 * 
 * Typed HTTP client for all backend endpoints.
 * This is the ONLY way the frontend should communicate with the backend.
 * All workout plan operations go through these functions.
 */

import { getApiUrl } from '../../config/api';
import { SSEEvent, sseEventSchema } from '../../types';
import { getSession } from '../../utils/supabase';

// ============================================================================
// TYPES - Backend API Contracts
// ============================================================================

export interface GeneratePlanRequest {
    preferences?: {
        splitType?: 'full-body' | 'upper-lower' | 'push-pull-legs' | 'bro' | 'custom';
        trainingDays?: number;
        focusAreas?: string[];
    };
}

export interface GeneratePlanResponse {
    success: boolean;
    plan?: {
        id: string;
        userId: string;
        planName: string;
        split: string;
        days: {
            id: string;
            dayIndex: number;
            dayOfWeek: string;
            focus: string;
            exercises: any[];
            estimatedTime: number;
        }[];
        createdAt: string;
    };
    message: string;
    error?: string;
}

export interface AdjustTodayRequest {
    userId: string;
    dayIndex?: number;
    request: string;
    constraints?: {
        availableEquipment?: string[];
        limitedTime?: number;
        intensity?: 'lighter' | 'standard' | 'heavier';
        location?: 'gym' | 'home' | 'hotel' | 'outdoor';
        injuries?: string[];
    };
}

export interface AdjustTodayResponse {
    success: boolean;
    workout?: {
        id: string;
        focus: string;
        exercises: any[];
        estimatedTime: number;
        difficulty: string;
    };
    message: string;
    error?: string;
}

export interface ConfirmEditRequest {
    updatedDays: {
        id: string;
        exercises_structured: any[];
    }[];
}

export interface ConfirmEditResponse {
    success: boolean;
    message?: string;
    error?: string;
}

export interface ChatStreamRequest {
    message: string;
    /** LangGraph thread id segment; same id resumes Supabase/Postgres checkpointed state */
    conversationId?: string;
    /**
     * Idempotency key for this send attempt. Auto-generated when omitted;
     * a retry of the SAME logical message should reuse the id so the backend
     * can reject the duplicate instead of double-applying mutations.
     */
    clientRequestId?: string;
    conversationHistory?: {
        role: string;
        content: string;
    }[];
    /**
     * Capability flag: this build understands the `suggestions` SSE event.
     * The backend only emits it when this is true (older builds render
     * unknown event types as raw text).
     */
    supportsSuggestions?: boolean;
    context?: {
        hasPlan?: boolean;
        todaysWorkout?: any;
        weeklySchedule?: any;
        dayIndex?: number;
    };
}

export type StreamEvent = SSEEvent;

export interface ChatStreamCallbacks {
    onEvent: (event: StreamEvent) => void;
    onError?: (error: Error) => void;
    onComplete?: () => void;
    /**
     * User-initiated stop. When the signal fires mid-stream the XHR is
     * aborted (the backend sees the disconnect and stops the graph run —
     * no orphaned token spend), `onAborted` is called INSTEAD of
     * onComplete/onError, and the promise resolves. Partial text already
     * delivered via onEvent stays with the caller.
     */
    signal?: AbortSignal;
    onAborted?: () => void;
}

export interface LogNutritionRequest {
    raw_text: string;
    date?: string;
}

/** Structured (no-AI) log — barcode scans where the macros are already exact. */
export interface LogNutritionStructuredRequest {
    raw_text: string;
    calories: number;
    protein: number;
    carbs: number;
    fats: number;
    date?: string;
}

export interface NutritionClarificationOption {
    label: string;
    delta: {
        calories: number;
        protein: number;
        carbs: number;
        fats: number;
    };
}

export interface NutritionClarification {
    question: string;
    options: NutritionClarificationOption[];
}

export interface LogNutritionResponse {
    success: boolean;
    log?: {
        id: string;
        user_id: string;
        date: string;
        raw_text: string;
        calories: number;
        protein: number;
        carbs: number;
        fats: number;
        vitamin_a_mcg: number | null;
        vitamin_c_mg: number | null;
        calcium_mg: number | null;
        iron_mg: number | null;
        created_at: string;
    };
    parsed?: {
        calories: number;
        protein: number;
        carbs: number;
        fats: number;
        vitamin_a_mcg: number | null;
        vitamin_c_mg: number | null;
        calcium_mg: number | null;
        iron_mg: number | null;
    };
    confidence?: 'high' | 'medium' | 'low';
    clarification?: NutritionClarification | null;
    error?: string;
}

export interface ClarifyNutritionLogResponse {
    success: boolean;
    log?: LogNutritionResponse['log'];
    error?: string;
}

// ── Photo food logging ("Snap a Meal") ──────────────────────────────────────

export interface MealPhotoItem {
    name: string;
    portion: string;
    grams: number | null;
    calories: number;
    protein: number;
    carbs: number;
    fats: number;
    confidence: 'high' | 'medium' | 'low';
}

export interface MealPhotoAnalysis {
    /** Null when photo_quality is no_food/unclear (nothing to confirm). */
    analysis_id: string | null;
    photo_quality: 'ok' | 'no_food' | 'unclear';
    meal_name: string | null;
    items: MealPhotoItem[];
    totals: { calories: number; protein: number; carbs: number; fats: number };
    confidence: 'high' | 'medium' | 'low';
    clarification: NutritionClarification | null;
    flags: { packaged: boolean; blended: boolean; multi_plate: boolean };
    fixes_remaining: number;
}

export interface AnalyzeMealPhotoRequest {
    /** Base64 JPEG, already resized to ≤1024px longest side. */
    image_base64: string;
    caption?: string;
    date?: string;
    /** LiDAR scale measurement (iPhone Pro): grounds portion estimation. */
    depth?: {
        lidar: boolean;
        subject_distance_cm: number;
        field_width_cm: number | null;
    };
    /** "Fix with a note" — free re-analysis, server-capped at 2 per scan. */
    fix?: { analysis_id: string; note: string; prior_result: unknown };
}

export interface AnalyzeMealPhotoResponse {
    success: boolean;
    analysis?: MealPhotoAnalysis;
    error?: string;
}

export interface ConfirmMealPhotoRequest {
    analysis_id?: string;
    /** Present when re-saving an existing photo log (Plate card edit mode). */
    log_id?: string;
    meal_name: string;
    date?: string;
    items: Omit<MealPhotoItem, 'confidence'>[];
}

export interface ParseMealItemResponse {
    success: boolean;
    item?: MealPhotoItem;
    error?: string;
}

export interface SwapSessionExerciseRequest {
    sessionId: string;
    targetIndex: number;
    oldExerciseId: string;
    newExerciseId: string;
    oldExerciseNameHint?: string;
}

export interface SwapSessionExerciseResponse {
    success: boolean;
    swappedIndex?: number;
    replacedWith?: string;
    message?: string;
    error?: string;
}

export interface CoachCheckin {
    id: string;
    kind:
        | 'ready_to_progress'
        | 'streak'
        | 'comeback'
        | 'stalled_lift'
        | 'plan_change'
        | 'first_workout_followup'
        | 'day2_after_first'
        | 'activation_nudge';
    title: string;
    message: string;
    /** Prefilled chat message for the tap-through CTA. */
    cta: string | null;
    payload: Record<string, unknown> | null;
    status: 'unread' | 'read';
    created_at: string;
    expires_at: string | null;
}

export interface CoachMemory {
    id: string;
    category:
        | 'preference'
        | 'goal'
        | 'injury'
        | 'body_change'
        | 'training_phase'
        | 'life_context'
        | 'equipment'
        | 'food_pattern';
    fact: string;
    confidence: number;
    source: string;
    created_at: string;
    last_seen_at: string;
}

export interface ExerciseAlternative {
    id: string;
    name: string;
    target_muscle: string;
    body_part: string;
    equipment: string | null;
    gif_path: string | null;
}

export interface GetAlternativesResponse {
    success: boolean;
    alternatives: ExerciseAlternative[];
    error?: string;
}

// ============================================================================
// QUOTA EXCEEDED ERROR
// ============================================================================

/**
 * Thrown when the backend rejects a request with HTTP 429 because the user has
 * hit a daily quota cap. Carries the structured `increment_quota_or_fail` body
 * so the UI can render the upgrade sheet without parsing strings.
 */
export class QuotaExceededError extends Error {
    readonly reason: string | undefined;
    readonly tier_type: string | undefined;
    readonly daily_ai_cost: number | undefined;
    readonly max_daily_budget: number | undefined;
    /** Premium 12h soft-cap only: ISO timestamp when the coach is back. */
    readonly retry_at: string | undefined;

    constructor(payload: {
        error?: string;
        reason?: string;
        tier_type?: string;
        daily_ai_cost?: number;
        max_daily_budget?: number;
        retry_at?: string;
    }) {
        super(payload.error ?? 'quota_exceeded');
        this.name = 'QuotaExceededError';
        this.reason = payload.reason ?? payload.error;
        this.tier_type = payload.tier_type;
        this.daily_ai_cost = payload.daily_ai_cost;
        this.max_daily_budget = payload.max_daily_budget;
        this.retry_at = payload.retry_at;
    }
}

export function isQuotaExceededError(err: unknown): err is QuotaExceededError {
    return err instanceof QuotaExceededError;
}

async function throwIfQuotaExceeded(response: Response): Promise<void> {
    if (response.status !== 429) return;
    let payload: any = {};
    try {
        payload = await response.json();
    } catch {
        // body wasn't JSON — fall through with empty payload
    }
    throw new QuotaExceededError(payload);
}

// ============================================================================
// API CLIENT
// ============================================================================

class BackendClient {
    private baseUrl: string;

    constructor() {
        this.baseUrl = getApiUrl();
    }

    private async getAuthHeaders(): Promise<Record<string, string>> {
        const session = await getSession();
        const token = session?.access_token;
        if (!token) {
            throw new Error('User session expired or not found');
        }
        return {
            Authorization: `Bearer ${token}`,
            'Content-Type': 'application/json',
        };
    }

    /**
     * Generate a new workout plan
     */
    async generatePlan(request: GeneratePlanRequest): Promise<GeneratePlanResponse> {
        try {
            const headers = await this.getAuthHeaders();
            const response = await fetch(`${this.baseUrl}/api/generate-plan`, {
                method: 'POST',
                headers,
                body: JSON.stringify(request ?? {}),
            });

            if (!response.ok) {
                const errorData = await response.json();
                throw new Error(errorData.error || `HTTP ${response.status}`);
            }

            return await response.json();
        } catch (error) {
            console.error('generatePlan error:', error);
            throw error;
        }
    }

    /**
     * Adjust today's workout based on constraints
     */
    async adjustToday(request: AdjustTodayRequest): Promise<AdjustTodayResponse> {
        try {
            const headers = await this.getAuthHeaders();
            const response = await fetch(`${this.baseUrl}/adjust-today`, {
                method: 'POST',
                headers,
                body: JSON.stringify(request),
            });

            if (!response.ok) {
                const errorData = await response.json();
                throw new Error(errorData.error || `HTTP ${response.status}`);
            }

            return await response.json();
        } catch (error) {
            console.error('adjustToday error:', error);
            throw error;
        }
    }

    /**
     * Confirm plan edits (Editor agent workflow)
     */
    async confirmEdit(request: ConfirmEditRequest): Promise<ConfirmEditResponse> {
        try {
            const headers = await this.getAuthHeaders();
            const response = await fetch(`${this.baseUrl}/chat/confirm-edit`, {
                method: 'POST',
                headers,
                body: JSON.stringify(request),
            });

            if (!response.ok) {
                const errorData = await response.json();
                throw new Error(errorData.error || `HTTP ${response.status}`);
            }

            return await response.json();
        } catch (error) {
            console.error('confirmEdit error:', error);
            throw error;
        }
    }

    /**
     * Stream chat with AI (SSE) - React Native compatible version
     * 
     * STREAM STABILITY RULES:
     * - Once first SSE event received, NEVER retry
     * - On backend { type: 'error' } event, abort stream immediately
     * - No automatic retries mid-stream
     */
    async chatStream(
        request: ChatStreamRequest,
        callbacks: ChatStreamCallbacks
    ): Promise<void> {
        const { onEvent, onError, onComplete, signal, onAborted } = callbacks;

        let authHeaders: Record<string, string>;
        try {
            authHeaders = await this.getAuthHeaders();
        } catch (e) {
            const err = e instanceof Error ? e : new Error(String(e));
            if (onError) onError(err);
            throw err;
        }

        return new Promise((resolve, reject) => {
            const xhr = new XMLHttpRequest();
            let lastResponseLength = 0;
            let sseBuffer = '';
            let firstEventReceived = false;
            let streamAborted = false;
            /** True when a well-formed SSE event with type "complete" was already delivered */
            let sseCompleteReceived = false;

            xhr.open('POST', `${this.baseUrl}/chat/stream`, true);
            xhr.setRequestHeader('Authorization', authHeaders.Authorization);
            xhr.setRequestHeader('Content-Type', 'application/json');
            xhr.setRequestHeader('Accept', 'text/event-stream');

            // User-initiated stop: aborting the XHR closes the connection,
            // which the backend turns into a graph abort (server stops
            // spending tokens). Whatever text already streamed stays.
            const handleUserAbort = () => {
                if (streamAborted || sseCompleteReceived) return;
                streamAborted = true;
                try { xhr.abort(); } catch { /* already closed */ }
                if (onAborted) onAborted();
                resolve();
            };
            if (signal) {
                if (signal.aborted) {
                    handleUserAbort();
                    return;
                }
                signal.addEventListener('abort', handleUserAbort, { once: true });
            }

            // Timeout prevents indefinite hanging (matches plan-generation timeout)
            // Without this, long-running AI operations can cause the app to crash on TestFlight
            xhr.timeout = 300000; // 5 minutes

            const drainSseBuffer = () => {
                while (true) {
                    const eventEndIndex = sseBuffer.indexOf('\n\n');
                    if (eventEndIndex === -1) break;

                    const rawEvent = sseBuffer.slice(0, eventEndIndex);
                    sseBuffer = sseBuffer.slice(eventEndIndex + 2);

                    const dataLines = rawEvent
                        .split('\n')
                        .filter(line => line.startsWith('data:'))
                        .map(line => line.replace(/^data:\s?/, ''));

                    if (!dataLines.length) continue;

                    const data = dataLines.join('\n');

                    if (data === '[DONE]') {
                        firstEventReceived = true;
                        onEvent({ type: 'text_done' });
                        continue;
                    }

                    try {
                        const eventJson = JSON.parse(data);
                        const parsed = sseEventSchema.safeParse(eventJson);

                        if (!parsed.success) {
                            console.error('Invalid SSE event payload:', parsed.error);
                            if (data.trim()) {
                                firstEventReceived = true;
                                onEvent({ type: 'text', content: data });
                            }
                            continue;
                        }

                        firstEventReceived = true;

                        if (parsed.data.type === 'error') {
                            console.error('Backend error event received:', parsed.data.message);
                            streamAborted = true;
                            xhr.abort();
                            onEvent(parsed.data);
                            if (onComplete) onComplete();
                            resolve();
                            return;
                        }

                        if (parsed.data.type === 'complete') {
                            sseCompleteReceived = true;
                        }

                        onEvent(parsed.data);
                    } catch {
                        if (data.trim()) {
                            firstEventReceived = true;
                            onEvent({
                                type: 'text',
                                content: data,
                            });
                        }
                    }
                }
            };

            xhr.onprogress = () => {
                if (streamAborted) return;

                const newData = xhr.responseText.substring(lastResponseLength);
                lastResponseLength = xhr.responseText.length;
                sseBuffer += newData.replace(/\r\n/g, '\n');

                drainSseBuffer();
            };

            xhr.onload = () => {
                if (streamAborted) return;

                const full = xhr.responseText;
                if (lastResponseLength < full.length) {
                    sseBuffer += full.substring(lastResponseLength).replace(/\r\n/g, '\n');
                    lastResponseLength = full.length;
                }
                drainSseBuffer();

                if (xhr.status >= 200 && xhr.status < 300) {
                    if (!sseCompleteReceived) {
                        onEvent({ type: 'complete' });
                    }
                    if (onComplete) {
                        onComplete();
                    }
                    resolve();
                } else if (xhr.status === 429) {
                    let payload: any = {};
                    try { payload = JSON.parse(xhr.responseText); } catch { /* not JSON */ }
                    const quotaErr = new QuotaExceededError(payload);
                    console.warn('chatStream quota exceeded:', quotaErr);
                    if (onError) onError(quotaErr);
                    reject(quotaErr);
                } else {
                    const error = new Error(`HTTP ${xhr.status}`);
                    console.error('chatStream HTTP error:', error);
                    if (onError) {
                        onError(error);
                    }
                    reject(error);
                }
            };

            xhr.onerror = () => {
                if (streamAborted) return;

                const error = new Error('Network error, please retry');
                console.error('chatStream XHR error:', error);
                console.log(`   First event received: ${firstEventReceived}`);
                if (onError) {
                    onError(error);
                }
                if (onComplete) {
                    onComplete();
                }
                reject(error);
            };

            xhr.ontimeout = () => {
                if (streamAborted) return;

                const error = new Error('Network error, please retry');
                console.error('chatStream timeout:', error);
                console.log(`   First event received: ${firstEventReceived}`);
                if (onError) {
                    onError(error);
                }
                if (onComplete) {
                    onComplete();
                }
                reject(error);
            };

            try {
                // Every send attempt carries an idempotency key so the backend
                // can reject an accidental duplicate (e.g. a timed-out request
                // replayed by a retry layer) instead of mutating twice.
                const body: ChatStreamRequest = {
                    ...request,
                    clientRequestId:
                        request.clientRequestId ??
                        `cr-${Date.now()}-${Math.random().toString(36).slice(2, 10)}`,
                };
                xhr.send(JSON.stringify(body));
            } catch (error) {
                console.error('chatStream send error:', error);
                if (onError) {
                    onError(error instanceof Error ? error : new Error(String(error)));
                }
                if (onComplete) {
                    onComplete();
                }
                reject(error);
            }
        });
    }


    /**
     * Non-streaming chat endpoint (for simple requests)
     */
    async chat(request: Omit<ChatStreamRequest, 'conversationHistory'>): Promise<any> {
        try {
            const headers = await this.getAuthHeaders();
            const response = await fetch(`${this.baseUrl}/chat`, {
                method: 'POST',
                headers,
                body: JSON.stringify(request),
            });

            await throwIfQuotaExceeded(response);
            if (!response.ok) {
                const errorData = await response.json();
                throw new Error(errorData.error || `HTTP ${response.status}`);
            }

            return await response.json();
        } catch (error) {
            console.error('chat error:', error);
            throw error;
        }
    }

    /**
     * Delete the server-side LangGraph thread for a conversation. Called when
     * the user deletes a chat so the backend's checkpointed thread state
     * doesn't outlive the conversation. Auth-scoped: the backend derives the
     * thread id from the session user, so only own threads are deletable.
     */
    async deleteChatThread(conversationId: string): Promise<void> {
        const headers = await this.getAuthHeaders();
        const response = await fetch(
            `${this.baseUrl}/chat/thread/${encodeURIComponent(conversationId)}`,
            { method: 'DELETE', headers }
        );
        if (!response.ok) {
            let message = `HTTP ${response.status}`;
            try {
                const payload = await response.json();
                message = payload?.error || message;
            } catch { /* body wasn't JSON */ }
            throw new Error(message);
        }
    }

    /**
     * Parse and persist a nutrition log line
     */
    async logNutrition(request: LogNutritionRequest): Promise<LogNutritionResponse> {
        try {
            const headers = await this.getAuthHeaders();
            const response = await fetch(`${this.baseUrl}/nutrition/log`, {
                method: 'POST',
                headers,
                body: JSON.stringify(request),
            });

            await throwIfQuotaExceeded(response);
            if (!response.ok) {
                const errorData = await response.json();
                throw new Error(errorData.error || `HTTP ${response.status}`);
            }

            return await response.json();
        } catch (error) {
            console.error('logNutrition error:', error);
            throw error;
        }
    }

    /**
     * Persist a barcode-sourced log with exact macros. Hits the structured
     * endpoint: no LLM parse and no AI-meal quota — free-tier barcode logging
     * is unlimited by design.
     */
    async logNutritionStructured(
        request: LogNutritionStructuredRequest
    ): Promise<LogNutritionResponse> {
        try {
            const headers = await this.getAuthHeaders();
            const response = await fetch(`${this.baseUrl}/nutrition/log-structured`, {
                method: 'POST',
                headers,
                body: JSON.stringify(request),
            });

            if (!response.ok) {
                const errorData = await response.json();
                throw new Error(errorData.error || `HTTP ${response.status}`);
            }

            return await response.json();
        } catch (error) {
            console.error('logNutritionStructured error:', error);
            throw error;
        }
    }

    /**
     * Re-parse an existing nutrition log with new raw_text. Used for tap-to-edit.
     */
    async updateNutritionLog(
        logId: string,
        rawText: string
    ): Promise<LogNutritionResponse> {
        try {
            const headers = await this.getAuthHeaders();
            const response = await fetch(`${this.baseUrl}/nutrition/log/${logId}`, {
                method: 'PATCH',
                headers,
                body: JSON.stringify({ raw_text: rawText }),
            });

            await throwIfQuotaExceeded(response);
            if (!response.ok) {
                const errorData = await response.json();
                throw new Error(errorData.error || `HTTP ${response.status}`);
            }

            return await response.json();
        } catch (error) {
            console.error('updateNutritionLog error:', error);
            throw error;
        }
    }

    async deleteNutritionLog(logId: string): Promise<{ success: boolean; error?: string }> {
        try {
            const headers = await this.getAuthHeaders();
            const response = await fetch(`${this.baseUrl}/nutrition/log/${logId}`, {
                method: 'DELETE',
                headers,
            });
            if (!response.ok) {
                const errorData = await response.json();
                throw new Error(errorData.error || `HTTP ${response.status}`);
            }
            return await response.json();
        } catch (error) {
            console.error('deleteNutritionLog error:', error);
            throw error;
        }
    }

    /**
     * Apply a clarification pill to an existing nutrition log. The server
     * adds the option's macro delta to the row and caches the resolved combo
     * so the same raw text + answer becomes free next time.
     */
    async clarifyNutritionLog(
        logId: string,
        option: NutritionClarificationOption
    ): Promise<ClarifyNutritionLogResponse> {
        try {
            const headers = await this.getAuthHeaders();
            const response = await fetch(`${this.baseUrl}/nutrition/log/${logId}/clarify`, {
                method: 'PATCH',
                headers,
                body: JSON.stringify({ option }),
            });

            await throwIfQuotaExceeded(response);
            if (!response.ok) {
                const errorData = await response.json();
                throw new Error(errorData.error || `HTTP ${response.status}`);
            }

            return await response.json();
        } catch (error) {
            console.error('clarifyNutritionLog error:', error);
            throw error;
        }
    }

    /**
     * Analyze a meal photo (vision model). Initial scans consume the daily AI
     * meal allowance (429 → QuotaExceededError); `fix` re-analyses are free.
     * A no_food/unclear result comes back as success:true with that quality —
     * the server already refunded the count.
     */
    async analyzeMealPhoto(request: AnalyzeMealPhotoRequest): Promise<AnalyzeMealPhotoResponse> {
        try {
            const headers = await this.getAuthHeaders();
            const response = await fetch(`${this.baseUrl}/nutrition/log-photo`, {
                method: 'POST',
                headers,
                body: JSON.stringify(request),
            });

            await throwIfQuotaExceeded(response);
            if (!response.ok) {
                const errorData = await response.json().catch(() => ({}));
                throw new Error(errorData.error || `HTTP ${response.status}`);
            }

            return await response.json();
        } catch (error) {
            console.error('analyzeMealPhoto error:', error);
            throw error;
        }
    }

    /**
     * Persist the (user-edited) Plate card. Deterministic — no AI, no quota.
     * With log_id, updates an existing photo log instead of inserting.
     */
    async confirmMealPhoto(request: ConfirmMealPhotoRequest): Promise<LogNutritionResponse> {
        try {
            const headers = await this.getAuthHeaders();
            const response = await fetch(`${this.baseUrl}/nutrition/log-photo/confirm`, {
                method: 'POST',
                headers,
                body: JSON.stringify(request),
            });

            if (!response.ok) {
                const errorData = await response.json().catch(() => ({}));
                throw new Error(errorData.error || `HTTP ${response.status}`);
            }

            return await response.json();
        } catch (error) {
            console.error('confirmMealPhoto error:', error);
            throw error;
        }
    }

    /**
     * Parse a "+ Add item" line into a Plate-card item (no DB write).
     * Cache-first on the server; cost-backstop gated only.
     */
    async parseMealItem(rawText: string): Promise<ParseMealItemResponse> {
        try {
            const headers = await this.getAuthHeaders();
            const response = await fetch(`${this.baseUrl}/nutrition/parse-item`, {
                method: 'POST',
                headers,
                body: JSON.stringify({ raw_text: rawText }),
            });

            await throwIfQuotaExceeded(response);
            if (!response.ok) {
                const errorData = await response.json().catch(() => ({}));
                throw new Error(errorData.error || `HTTP ${response.status}`);
            }

            return await response.json();
        } catch (error) {
            console.error('parseMealItem error:', error);
            throw error;
        }
    }

    async getExerciseAlternatives(exerciseId: string): Promise<ExerciseAlternative[]> {
        try {
            const headers = await this.getAuthHeaders();
            const url = `${this.baseUrl}/api/workout/alternatives?exerciseId=${encodeURIComponent(exerciseId)}`;
            const response = await fetch(url, { method: 'GET', headers });

            const payload: GetAlternativesResponse = await response.json();
            if (!response.ok) {
                throw new Error(payload.error || `HTTP ${response.status}`);
            }

            return payload.alternatives ?? [];
        } catch (error) {
            console.error('getExerciseAlternatives error:', error);
            throw error;
        }
    }

    async getCoachCheckins(): Promise<{ checkins: CoachCheckin[]; unreadCount: number }> {
        try {
            const headers = await this.getAuthHeaders();
            const response = await fetch(`${this.baseUrl}/checkins`, { method: 'GET', headers });
            const payload = await response.json();
            if (!response.ok) {
                throw new Error(payload.error || `HTTP ${response.status}`);
            }
            return {
                checkins: (payload.checkins ?? []) as CoachCheckin[],
                unreadCount: payload.unreadCount ?? 0,
            };
        } catch (error) {
            console.error('getCoachCheckins error:', error);
            return { checkins: [], unreadCount: 0 };
        }
    }

    async sendSessionFeedback(
        kind: 'feeling' | 'difficulty',
        value: string,
        workout?: string
    ): Promise<void> {
        try {
            const headers = await this.getAuthHeaders();
            await fetch(`${this.baseUrl}/checkins/session-feedback`, {
                method: 'POST',
                headers,
                body: JSON.stringify({ kind, value, workout }),
            });
        } catch (error) {
            // Best-effort memory write — never surface a failure to the user.
            console.warn('sendSessionFeedback failed:', error);
        }
    }

    async setCheckinStatus(id: string, status: 'read' | 'dismissed'): Promise<void> {
        try {
            const headers = await this.getAuthHeaders();
            await fetch(`${this.baseUrl}/checkins/${encodeURIComponent(id)}/status`, {
                method: 'POST',
                headers,
                body: JSON.stringify({ status }),
            });
        } catch (error) {
            // Best-effort — a failed read-receipt should never surface to the user.
            console.warn('setCheckinStatus failed:', error);
        }
    }

    /**
     * "What I know about you" — active coach memories for the settings screen.
     */
    async getCoachMemories(): Promise<CoachMemory[]> {
        try {
            const headers = await this.getAuthHeaders();
            const response = await fetch(`${this.baseUrl}/memories`, { method: 'GET', headers });
            const payload = await response.json();
            if (!response.ok) {
                throw new Error(payload.error || `HTTP ${response.status}`);
            }
            return (payload.memories ?? []) as CoachMemory[];
        } catch (error) {
            console.error('getCoachMemories error:', error);
            throw error;
        }
    }

    /** Soft-archive a coach memory ("forget this"). */
    async deleteCoachMemory(id: string): Promise<void> {
        const headers = await this.getAuthHeaders();
        const response = await fetch(`${this.baseUrl}/memories/${encodeURIComponent(id)}`, {
            method: 'DELETE',
            headers,
        });
        if (!response.ok) {
            let message = `HTTP ${response.status}`;
            try {
                const payload = await response.json();
                message = payload?.error || message;
            } catch { /* body wasn't JSON */ }
            throw new Error(message);
        }
    }

    async swapSessionExercise(
        request: SwapSessionExerciseRequest
    ): Promise<SwapSessionExerciseResponse> {
        try {
            const headers = await this.getAuthHeaders();
            const response = await fetch(`${this.baseUrl}/api/workout/swap-session-exercise`, {
                method: 'POST',
                headers,
                body: JSON.stringify(request),
            });

            await throwIfQuotaExceeded(response);
            const payload = await response.json();
            if (!response.ok) {
                throw new Error(payload.error || `HTTP ${response.status}`);
            }

            return payload as SwapSessionExerciseResponse;
        } catch (error) {
            console.error('swapSessionExercise error:', error);
            throw error;
        }
    }
}

// Export singleton instance
export const backendClient = new BackendClient();

// Named exports for convenience
export const {
    generatePlan,
    adjustToday,
    confirmEdit,
    chatStream,
    chat,
    logNutrition,
    logNutritionStructured,
    updateNutritionLog,
    deleteNutritionLog,
    clarifyNutritionLog,
    getExerciseAlternatives,
    swapSessionExercise,
} = backendClient;
