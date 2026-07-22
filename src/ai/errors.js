// Shared error type for the AI layer. Kept in its own module so the agent and
// the provider gateway can both use it without a circular import.

export class AIError extends Error {
  constructor(message, { disabled = false, status = 500 } = {}) {
    super(message);
    this.name = 'AIError';
    this.disabled = disabled;
    this.status = status;
  }
}
