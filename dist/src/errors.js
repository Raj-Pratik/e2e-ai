export class AiE2eError extends Error {
    constructor(message) {
        super(message);
        this.name = 'AiE2eError';
    }
}
export function errorMessage(error) {
    return error instanceof Error ? error.message : String(error);
}
