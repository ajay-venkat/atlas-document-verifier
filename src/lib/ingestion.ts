// ============================================================
// Document Ingestion Pipeline
// Parse → Chunk → Embed → Extract Entities → Write to Supabase
// ============================================================

import { supabase } from "./supabase";
import { callGemini, generateEmbedding } from "./ai";
import type { EntityEdge } from "./types";

/**
 * Parse raw text from a PDF buffer using pdf-parse.
 */
export async function parsePdf(buffer: Buffer): Promise<string> {
  const { PDFParse } = await import("pdf-parse");
  // pdf-parse v2: source goes in constructor, getText() returns {text: string[]}
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const parser = new PDFParse({ data: buffer as any });
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const textResult = await (parser as any).getText();
  
  if (!textResult || !textResult.text) {
    throw new Error("Failed to parse PDF text");
  }

  // If it's an array of pages, join them. If it's already a string, just return it.
  if (Array.isArray(textResult.text)) {
    return textResult.text.map((page: string) => page).join("\n\n");
  }
  return textResult.text;
}

/**
 * Chunk text into semantically coherent pieces.
 * Uses paragraph-based splitting with a target size, preserving section boundaries.
 */
export function chunkText(
  text: string,
  targetChunkSize: number = 800,
  overlap: number = 100
): string[] {
  // Split on double newlines (paragraph boundaries) first
  const paragraphs = text.split(/\n\s*\n/).filter((p) => p.trim().length > 0);
  const chunks: string[] = [];
  let currentChunk = "";

  for (const para of paragraphs) {
    const trimmed = para.trim();

    // If adding this paragraph would exceed target, finalize current chunk
    if (
      currentChunk.length > 0 &&
      currentChunk.length + trimmed.length > targetChunkSize
    ) {
      chunks.push(currentChunk.trim());
      // Keep the last `overlap` characters for context continuity
      const overlapText = currentChunk.slice(-overlap);
      currentChunk = overlapText + "\n\n" + trimmed;
    } else {
      currentChunk += (currentChunk.length > 0 ? "\n\n" : "") + trimmed;
    }
  }

  // Don't forget the last chunk
  if (currentChunk.trim().length > 0) {
    chunks.push(currentChunk.trim());
  }

  // If text had no paragraph breaks, fall back to character-based splitting
  if (chunks.length === 0 && text.trim().length > 0) {
    const words = text.trim().split(/\s+/);
    let chunk = "";
    for (const word of words) {
      if (chunk.length + word.length + 1 > targetChunkSize) {
        chunks.push(chunk.trim());
        chunk = chunk.slice(-overlap) + " " + word;
      } else {
        chunk += (chunk.length > 0 ? " " : "") + word;
      }
    }
    if (chunk.trim().length > 0) chunks.push(chunk.trim());
  }

  return chunks;
}

/**
 * Extract entity-relationship triples from a text chunk using Claude.
 */
async function extractEntities(
  text: string
): Promise<Array<{ subject: string; predicate: string; object: string; confidence: number }>> {
  const systemPrompt = `You are an entity-relationship extraction engine for document verification.
Given a text chunk, extract subject-predicate-object triples that represent key facts, rules, obligations, relationships, or claims.

Focus on:
- Who/what is obligated to do what
- Timelines and deadlines
- Monetary amounts and conditions
- Organizational relationships
- Compliance requirements and rules
- Definitions and scope boundaries

Return a JSON array of objects with: subject, predicate, object, confidence (0-1).
Return ONLY the JSON array, no other text.
If no meaningful triples can be extracted, return an empty array [].`;

  try {
    const result = await callGemini<
      Array<{ subject: string; predicate: string; object: string; confidence: number }>
    >(systemPrompt, `Extract entity-relationship triples from:\n\n${text}`);
    return Array.isArray(result) ? result : [];
  } catch (err) {
    console.error("Entity extraction failed for chunk:", err);
    return [];
  }
}

/**
 * Full ingestion pipeline: parse, chunk, embed, extract entities, write to Supabase.
 * Returns the document ID.
 */
export async function ingestDocument(
  fileBuffer: Buffer,
  fileName: string,
  sourceType: string = "general"
): Promise<{ documentId: string; chunkCount: number; edgeCount: number }> {
  // 1. Parse PDF to text
  const rawText = await parsePdf(fileBuffer);

  if (!rawText || rawText.trim().length === 0) {
    throw new Error("No text could be extracted from the document.");
  }

  // 2. Insert document record
  const { data: doc, error: docError } = await supabase
    .from("documents")
    .insert({
      title: fileName,
      source_type: sourceType,
      raw_text: rawText,
      metadata: { original_filename: fileName, char_count: rawText.length },
    })
    .select("id")
    .single();

  if (docError || !doc) {
    throw new Error(`Failed to insert document: ${docError?.message}`);
  }

  const documentId = doc.id;

  // 3. Chunk the text
  const textChunks = chunkText(rawText);

  // 4. Embed each chunk and insert
  const chunkRows = [];
  for (let i = 0; i < textChunks.length; i++) {
    const embedding = await generateEmbedding(textChunks[i]);
    chunkRows.push({
      document_id: documentId,
      content: textChunks[i],
      embedding: JSON.stringify(embedding),
      chunk_index: i,
    });
  }

  // Batch insert chunks (Supabase supports bulk inserts)
  const { error: chunkError } = await supabase
    .from("chunks")
    .insert(chunkRows);

  if (chunkError) {
    throw new Error(`Failed to insert chunks: ${chunkError.message}`);
  }

  // 5. Extract entity edges from each chunk
  let totalEdges = 0;
  for (let i = 0; i < textChunks.length; i++) {
    const entities = await extractEntities(textChunks[i]);
    if (entities.length > 0) {
      const edgeRows = entities.map((e) => ({
        subject: e.subject.toLowerCase(),
        predicate: e.predicate.toLowerCase(),
        object: e.object.toLowerCase(),
        source_document_id: documentId,
        confidence: e.confidence,
      }));

      const { error: edgeError } = await supabase
        .from("entity_edges")
        .insert(edgeRows);

      if (edgeError) {
        console.error(`Failed to insert edges for chunk ${i}:`, edgeError);
      } else {
        totalEdges += edgeRows.length;
      }
    }
  }

  return {
    documentId,
    chunkCount: textChunks.length,
    edgeCount: totalEdges,
  };
}
