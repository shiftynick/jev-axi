import { AxiError, exitCodeForError } from "axi-sdk-js";

export type ErrorCode =
  | "VALIDATION_ERROR"
  | "AUTH_REQUIRED"
  | "RATE_LIMITED"
  | "OVERLOADED"
  | "NETWORK"
  | "API_ERROR"
  | "API_REJECTED"
  | "NOT_FOUND"
  | "UNKNOWN";

export { AxiError, exitCodeForError };

export function validation(message: string, suggestions: string[] = []): AxiError {
  return new AxiError(message, "VALIDATION_ERROR", suggestions);
}
