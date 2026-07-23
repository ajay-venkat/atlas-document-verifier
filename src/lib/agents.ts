// ============================================================
// Multi-Agent Verification Pipeline
// Planner → Retrieval → Critic/Verifier → Synthesizer
// Each agent returns structured JSON, validated before handoff
// ============================================================

import { callGemini } from "./ai";
import { retrieve } from "./retrieval";
import type {
  PlannerOutput,
  RetrievalAgentOutput,
  CriticOutput,
  VerificationReport,
  ClaimResult,
  RetrievedChunk,
  StreamEvent,
} from "./types";

// ---- Agent 1: Planner ----

const PLANNER_SYSTEM = `You are the Planner agent in a document verification pipeline.
Your job: take the user's verification query and break it into 3-6 concrete, focused sub-questions that can each be independently verified against a corpus of documents.

Each sub-question should be:
- Specific and verifiable (not vague)
- Focused on a single claim, obligation, or fact
- Written as a question that can be answered with evidence from documents

Return ONLY valid JSON in this exact format:
{
  "sub_questions": [
    { "id": "sq_1", "question": "...", "focus_area": "..." },
    ...
  ],
  "reasoning": "Brief explanation of how you decomposed the query"
}`;

export async function plannerAgent(query: string): Promise<PlannerOutput> {
  const result = await callGemini<PlannerOutput>(
    PLANNER_SYSTEM,
    `Verification query: "${query}"\n\nBreak this into concrete sub-questions for document verification.`
  );

  // Validate shape
  if (!result.sub_questions || !Array.isArray(result.sub_questions)) {
    throw new Error("Planner returned invalid structure: missing sub_questions array");
  }

  for (const sq of result.sub_questions) {
    if (!sq.id || !sq.question) {
      throw new Error("Planner sub-question missing id or question field");
    }
  }

  return result;
}

// ---- Agent 2: Retrieval ----

export async function retrievalAgent(
  subQuestionId: string,
  question: string
): Promise<RetrievalAgentOutput> {
  const { chunks } = await retrieve(question, { topK: 8 });

  return {
    sub_question_id: subQuestionId,
    question,
    retrieved_chunks: chunks,
  };
}

// ---- Agent 3: Critic / Verifier ----

const CRITIC_SYSTEM = `You are the Critic/Verifier agent in a document verification pipeline.
Given a sub-question and a set of retrieved document chunks, your job is to determine whether the evidence supports, contradicts, or fails to address the claim in the question.

Rules:
- "supported": Clear evidence in the chunks directly supports the claim.
- "contradicted": Clear evidence in the chunks directly contradicts the claim.
- "unverifiable": No relevant evidence found, or evidence is ambiguous/insufficient.
- Always cite specific excerpts from the chunks as evidence.
- Be conservative — only mark "supported" if the evidence is clear and direct.

Return ONLY valid JSON in this exact format:
{
  "sub_question_id": "...",
  "question": "...",
  "verdict": "supported" | "contradicted" | "unverifiable",
  "confidence": 0.0 to 1.0,
  "reasoning": "Detailed explanation of your verdict",
  "supporting_citations": [
    { "chunk_id": "...", "document_id": "...", "document_title": "...", "excerpt": "relevant quote" }
  ],
  "contradicting_citations": [
    { "chunk_id": "...", "document_id": "...", "document_title": "...", "excerpt": "relevant quote" }
  ]
}`;

export async function criticAgent(
  subQuestionId: string,
  question: string,
  chunks: RetrievedChunk[]
): Promise<CriticOutput> {
  const chunkContext = chunks
    .map(
      (c, i) =>
        `[Chunk ${i + 1} | ID: ${c.chunk_id} | Doc: ${c.document_title} | DocID: ${c.document_id}]\n${c.content}`
    )
    .join("\n\n---\n\n");

  const result = await callGemini<CriticOutput>(
    CRITIC_SYSTEM,
    `Sub-question (ID: ${subQuestionId}): "${question}"\n\nRetrieved evidence chunks:\n\n${chunkContext}\n\nAnalyze whether these chunks support or contradict the claim in the sub-question.`
  );

  // Validate shape
  if (!result.verdict || !["supported", "contradicted", "unverifiable"].includes(result.verdict)) {
    throw new Error(`Critic returned invalid verdict: ${result.verdict}`);
  }

  return {
    ...result,
    sub_question_id: subQuestionId,
    question,
  };
}

// ---- Agent 4: Synthesizer / Risk Scorer ----

const SYNTHESIZER_SYSTEM = `You are the Synthesizer/Risk-Scorer agent in a document verification pipeline.
Given a set of per-claim verdicts from the Critic agent, synthesize a final verification report.

Risk scoring rules:
- Start at 0 (no risk). Each "contradicted" claim adds 25 points. Each "unverifiable" claim adds 10 points. "Supported" claims add 0.
- Clamp the final score to 0-100.
- Risk levels: 0-25 = "low", 26-50 = "medium", 51-75 = "high", 76-100 = "critical"

Return ONLY valid JSON in this exact format:
{
  "query": "the original query",
  "overall_risk_score": 0-100,
  "risk_level": "low" | "medium" | "high" | "critical",
  "summary": "A 2-4 sentence executive summary of findings",
  "claims": [
    {
      "sub_question_id": "...",
      "question": "...",
      "verdict": "supported" | "contradicted" | "unverifiable",
      "confidence": 0.0-1.0,
      "reasoning": "...",
      "citations": [
        { "chunk_id": "...", "document_id": "...", "document_title": "...", "excerpt": "..." }
      ]
    }
  ],
  "total_documents_referenced": number,
  "total_chunks_analyzed": number,
  "generated_at": "ISO timestamp"
}`;

export async function synthesizerAgent(
  query: string,
  criticResults: CriticOutput[],
  totalChunksAnalyzed: number
): Promise<VerificationReport> {
  const criticContext = criticResults
    .map(
      (cr) =>
        `Claim: "${cr.question}"\nVerdict: ${cr.verdict} (confidence: ${cr.confidence})\nReasoning: ${cr.reasoning}\nSupporting citations: ${JSON.stringify(cr.supporting_citations)}\nContradicting citations: ${JSON.stringify(cr.contradicting_citations)}`
    )
    .join("\n\n---\n\n");

  const result = await callGemini<VerificationReport>(
    SYNTHESIZER_SYSTEM,
    `Original verification query: "${query}"\n\nPer-claim verdicts from the Critic agent:\n\n${criticContext}\n\nTotal chunks analyzed: ${totalChunksAnalyzed}\n\nSynthesize a final verification report with risk score.`
  );

  // Validate shape
  if (typeof result.overall_risk_score !== "number") {
    throw new Error("Synthesizer returned invalid risk_score");
  }

  return {
    ...result,
    generated_at: new Date().toISOString(),
  };
}

// ---- Orchestrator ----

type StreamCallback = (event: StreamEvent) => void;

/**
 * Run the full 4-agent verification pipeline.
 * Emits streaming events via the callback for live UI updates.
 */
export async function runVerificationPipeline(
  query: string,
  onStream?: StreamCallback
): Promise<VerificationReport> {
  const emit = (event: StreamEvent) => {
    if (onStream) onStream(event);
  };

  // Stage 1: Planning
  emit({
    stage: "planning",
    message: "Breaking down your query into sub-questions...",
    progress: 5,
  });

  const planResult = await plannerAgent(query);
  const subQuestions = planResult.sub_questions;

  emit({
    stage: "planning",
    message: `Identified ${subQuestions.length} sub-questions to verify.`,
    progress: 15,
    data: planResult,
  });

  // Stage 2: Retrieval (per sub-question)
  const retrievalResults: RetrievalAgentOutput[] = [];
  let totalChunks = 0;

  for (let i = 0; i < subQuestions.length; i++) {
    emit({
      stage: "retrieving",
      message: `Retrieving evidence for claim ${i + 1} of ${subQuestions.length}: "${subQuestions[i].question.slice(0, 80)}..."`,
      progress: 15 + ((i + 1) / subQuestions.length) * 30,
    });

    const result = await retrievalAgent(subQuestions[i].id, subQuestions[i].question);
    retrievalResults.push(result);
    totalChunks += result.retrieved_chunks.length;
  }

  emit({
    stage: "retrieving",
    message: `Retrieved ${totalChunks} evidence chunks across ${subQuestions.length} sub-questions.`,
    progress: 45,
  });

  // Stage 3: Verification (per sub-question)
  const criticResults: CriticOutput[] = [];

  for (let i = 0; i < retrievalResults.length; i++) {
    const rr = retrievalResults[i];
    emit({
      stage: "verifying",
      message: `Cross-checking claim ${i + 1} of ${subQuestions.length} against evidence...`,
      progress: 45 + ((i + 1) / subQuestions.length) * 30,
    });

    const criticResult = await criticAgent(
      rr.sub_question_id,
      rr.question,
      rr.retrieved_chunks
    );
    criticResults.push(criticResult);
    
    // 4-second delay to respect Gemini 15 RPM free tier limit (1 req / 4 sec)
    if (i < retrievalResults.length - 1) {
      await new Promise(r => setTimeout(r, 4000));
    }
  }

  const supported = criticResults.filter((c) => c.verdict === "supported").length;
  const contradicted = criticResults.filter((c) => c.verdict === "contradicted").length;
  const unverifiable = criticResults.filter((c) => c.verdict === "unverifiable").length;

  emit({
    stage: "verifying",
    message: `Verification complete: ${supported} supported, ${contradicted} contradicted, ${unverifiable} unverifiable.`,
    progress: 75,
  });

  // Stage 4: Synthesis & Risk Scoring
  emit({
    stage: "synthesizing",
    message: "Compiling final verification report and calculating risk score...",
    progress: 80,
  });

  const report = await synthesizerAgent(query, criticResults, totalChunks);

  emit({
    stage: "complete",
    message: `Verification complete. Risk score: ${report.overall_risk_score}/100 (${report.risk_level}).`,
    progress: 100,
    data: report,
  });

  return report;
}
