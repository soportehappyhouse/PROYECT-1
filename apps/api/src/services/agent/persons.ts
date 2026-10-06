import type { PersonSummary } from "@studio/shared";

/**
 * Sprint 4 (M1): what the EditPlan resolver needs to resolve `face_swap` (`person` name -> id,
 * consent state) without a database handle in ResolveContext. app.ts registers the live directory
 * of the running api (setPersonsDirectory); callers may also pass `persons` explicitly in the
 * ResolveContext (agent.apply does). Without either, face_swap stays unresolved with a question.
 */
export interface PersonsDirectory {
  /** Live Persons (GET /api/persons rows). */
  persons: readonly PersonSummary[];
  /** The on-screen licence «faceswap» is accepted (current text version). */
  faceswapLicence: boolean;
}

let provider: (() => PersonsDirectory) | undefined;

export function setPersonsDirectory(fn: (() => PersonsDirectory) | undefined): void {
  provider = fn;
}

export function personsDirectory(): PersonsDirectory | undefined {
  try {
    return provider?.();
  } catch {
    return undefined;
  }
}
