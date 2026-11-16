/**
 * Incremental extraction of ONE string field from a streaming JSON payload.
 *
 * The agent decision is produced via structured output, so the LLM streams a
 * JSON object (as tool-call arg deltas on Anthropic, raw JSON content on
 * OpenAI's json_schema mode). To token-stream the user-facing reply we watch
 * the raw JSON as it arrives and decode just the `responseToUser` string
 * value, emitting each newly completed piece of text.
 *
 * Handles values split across arbitrary chunk boundaries, JSON escapes
 * (\" \\ \n \t \uXXXX ...), and holds back incomplete escape sequences until
 * the remaining bytes arrive.
 */

const SIMPLE_ESCAPES: Record<string, string> = {
    '"': '"',
    "\\": "\\",
    "/": "/",
    b: "\b",
    f: "\f",
    n: "\n",
    r: "\r",
    t: "\t",
};

export class JsonStringFieldStreamer {
    private buffer = "";
    /** Index in `buffer` just past the opening quote of the field value; -1 until found. */
    private valueStart = -1;
    /** Index in `buffer` up to which the value has been decoded and emitted. */
    private cursor = 0;
    private closed = false;
    private emitted = 0;
    private readonly keyPattern: RegExp;

    constructor(fieldName: string) {
        this.keyPattern = new RegExp(`"${fieldName}"\\s*:\\s*"`);
    }

    /** Total characters of decoded field text emitted so far. */
    get emittedLength(): number {
        return this.emitted;
    }

    /** True once the closing quote of the field value has been seen. */
    get isComplete(): boolean {
        return this.closed;
    }

    /**
     * Feed a raw JSON delta. Returns the newly decoded text of the target
     * field ("" when the field hasn't started, didn't advance, or is done).
     */
    push(delta: string): string {
        if (this.closed || !delta) return "";
        this.buffer += delta;

        if (this.valueStart < 0) {
            const m = this.buffer.match(this.keyPattern);
            if (!m || m.index === undefined) return "";
            this.valueStart = m.index + m[0].length;
            this.cursor = this.valueStart;
        }

        let out = "";
        let i = this.cursor;
        while (i < this.buffer.length) {
            const ch = this.buffer[i];
            if (ch === '"') {
                this.closed = true;
                i++;
                break;
            }
            if (ch === "\\") {
                if (i + 1 >= this.buffer.length) break; // incomplete escape — wait for more
                const next = this.buffer[i + 1];
                if (next === "u") {
                    if (i + 6 > this.buffer.length) break; // incomplete \uXXXX
                    const code = parseInt(this.buffer.slice(i + 2, i + 6), 16);
                    out += Number.isNaN(code) ? "" : String.fromCharCode(code);
                    i += 6;
                } else {
                    out += SIMPLE_ESCAPES[next] ?? next;
                    i += 2;
                }
                continue;
            }
            out += ch;
            i++;
        }
        this.cursor = i;
        this.emitted += out.length;
        return out;
    }
}
