export const MAX_MODEL_ROUNDS_PER_TURN = 12;
export const MAX_TOOL_CALLS_PER_TURN = 32;
export const MAX_TURN_DURATION_MS = 15 * 60_000;
export const TOOL_BUDGET_MESSAGE = 'The tool limit for this response was reached. Summarize the available results and any unfinished work without calling more tools.';

/** Counts attempts, including invalid or individually rate-limited calls. */
export class TurnBudget {
  private rounds = 0;
  private toolCalls = 0;

  constructor(
    private readonly maxRounds = MAX_MODEL_ROUNDS_PER_TURN,
    private readonly maxToolCalls = MAX_TOOL_CALLS_PER_TURN,
  ) {}

  startRound(): void {
    this.rounds += 1;
  }

  takeToolCall(): boolean {
    if (this.toolCalls >= this.maxToolCalls) return false;
    this.toolCalls += 1;
    return true;
  }

  get exhausted(): boolean {
    return this.rounds >= this.maxRounds || this.toolCalls >= this.maxToolCalls;
  }
}
