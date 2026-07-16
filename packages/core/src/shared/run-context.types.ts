export interface RunContextState {
  get<T = unknown>(key: string): Promise<T | undefined>;
  set(key: string, value: unknown): Promise<void>;
}

export interface RunContext {
  readonly id: string;
  readonly name: string;
  readonly path: string;
  readonly state: RunContextState;
}
