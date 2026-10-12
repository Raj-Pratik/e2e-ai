export class AiE2eError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'AiE2eError';
  }
}

export function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
