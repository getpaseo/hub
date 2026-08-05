export interface AllowedOutput {
  type: string;
  max: number;
}

export interface OutputExecutionInput {
  agentExecutionId: string;
  toolType: string;
  args: Record<string, unknown>;
  outputContext: unknown;
}

export type OutputExecutor = (input: OutputExecutionInput) => Promise<void>;

export class OutputExecutorRegistry {
  private readonly executors = new Map<string, OutputExecutor>();

  register(type: string, executor: OutputExecutor): void {
    this.executors.set(type, executor);
  }

  async execute(input: OutputExecutionInput): Promise<void> {
    const executor = this.executors.get(input.toolType);
    if (executor === undefined) {
      throw new Error(`no output executor registered for ${input.toolType}`);
    }
    await executor(input);
  }
}
