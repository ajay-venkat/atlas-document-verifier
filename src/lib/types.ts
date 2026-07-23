// ============================================================
// Type definitions for the Document Verification Engine
// ============================================================

// --- Database Row Types ---

export interface Document {
  id: string;
  title: string;
  source_type: string;
  raw_text: string;
  metadata: Record<string, unknown>;
  created_at: string;
}

export interface Chunk {
  id: string;
  document_id: string;
  content: string;
  embedding: number[];
  chunk_index: number;
  created_at: string;
}

export interface EntityEdge {
  id: string;
  subject: string;
  predicate: string;
  object: string;
  source_document_id: string;
  confidence: number;
  created_at: string;
}

export interface VerificationRun {
  id: string;
  query: string;
  status: "pending" | "running" | "complete" | "failed";
  report: VerificationReport | null;
  risk_score: number | null;
  created_at: string;
}

// --- Retrieval Types ---

export interface RetrievedChunk {
  chunk_id: string;
  document_id: string;
  document_title: string;
  content: string;
  score: number;
  source: "dense" | "lexical" | "graph";
}

export interface RetrievalResult {
  chunks: RetrievedChunk[];
  entity_edges: EntityEdge[];
}

// --- Agent Pipeline Types ---

export interface SubQuestion {
  id: string;
  question: string;
  focus_area: string;
}

export interface PlannerOutput {
  sub_questions: SubQuestion[];
  reasoning: string;
}

export interface RetrievalAgentOutput {
  sub_question_id: string;
  question: string;
  retrieved_chunks: RetrievedChunk[];
}

export type ClaimVerdict = "supported" | "contradicted" | "unverifiable";

export interface CriticOutput {
  sub_question_id: string;
  question: string;
  verdict: ClaimVerdict;
  confidence: number;
  reasoning: string;
  supporting_citations: Citation[];
  contradicting_citations: Citation[];
}

export interface Citation {
  chunk_id: string;
  document_id: string;
  document_title: string;
  excerpt: string;
}

export interface ClaimResult {
  sub_question_id: string;
  question: string;
  verdict: ClaimVerdict;
  confidence: number;
  reasoning: string;
  citations: Citation[];
}

export interface VerificationReport {
  query: string;
  overall_risk_score: number;
  risk_level: "low" | "medium" | "high" | "critical";
  summary: string;
  claims: ClaimResult[];
  total_documents_referenced: number;
  total_chunks_analyzed: number;
  generated_at: string;
}

// --- Streaming / SSE Types ---

export type AgentStage =
  | "planning"
  | "retrieving"
  | "verifying"
  | "synthesizing"
  | "complete"
  | "error";

export interface StreamEvent {
  stage: AgentStage;
  message: string;
  progress?: number; // 0-100
  data?: unknown;
}
