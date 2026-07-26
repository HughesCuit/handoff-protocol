/**
 * Handoff Protocol v1.5 — Context Map (Deno wrapper).
 *
 * The implementation lives in ./context-map.mjs and is shared verbatim with
 * the Node runtime (scripts/node/context-map.mjs re-exports it) and the
 * shared test suite (tests/shared/unit-suite.mjs). This wrapper adds the
 * TypeScript types used by the Deno save/load scripts.
 */

export * from "./context-map.mjs";

export type SectionKey =
  | "goal"
  | "status"
  | "tasks"
  | "decisions"
  | "questions"
  | "risks"
  | "knowledge"
  | "excluded";

export type NodeOrigin = "agent" | "user";

export interface ContextMapNode {
  text: string;
  origin: NodeOrigin;
  checked?: boolean;
  depth?: number;
}

export interface ContextMapExtra {
  heading: string;
  body: string[];
}

export interface ParsedMap {
  sections: Record<SectionKey, ContextMapNode[]>;
  extras: ContextMapExtra[];
}

/** A single inferred node passed to reconcileContextMap. */
export interface InferredNode {
  text: string;
  checked?: boolean;
  depth?: number;
}

/**
 * Inference payload passed by the save scripts to reconcileContextMap,
 * as produced by buildInferredSections().
 */
export type InferredSections = Partial<Record<SectionKey, InferredNode[]>>;

export interface MapTaskState {
  text: string;
  priority: string;
  done: boolean;
}

/** Flat semantic state projected from a parsed map for the load scripts. */
export interface ContextMapState {
  goal: string;
  status: string;
  tasks: MapTaskState[];
  decisions: string[];
  openQuestions: string[];
  risks: string[];
  knowledge: string[];
  excluded: string[];
}
