import { NextRequest, NextResponse } from "next/server";
import { ingestDocument } from "@/lib/ingestion";

export const maxDuration = 300; // Allow up to 5 min for large docs
export const dynamic = "force-dynamic";

export async function POST(request: NextRequest) {
  try {
    const formData = await request.formData();
    const file = formData.get("file") as File | null;
    const sourceType = (formData.get("source_type") as string) || "general";

    if (!file) {
      return NextResponse.json(
        { error: "No file provided. Send a 'file' field in multipart/form-data." },
        { status: 400 }
      );
    }

    // Validate file type
    const allowedTypes = [
      "application/pdf",
      "text/plain",
    ];

    if (!allowedTypes.includes(file.type) && !file.name.endsWith(".pdf") && !file.name.endsWith(".txt")) {
      return NextResponse.json(
        { error: `Unsupported file type: ${file.type}. Supported: PDF, TXT.` },
        { status: 400 }
      );
    }

    // Convert to buffer
    const bytes = await file.arrayBuffer();
    const buffer = Buffer.from(bytes);

    // Handle plain text files directly
    let result;
    if (file.type === "text/plain" || file.name.endsWith(".txt")) {
      // For text files, we still go through the pipeline but skip PDF parsing
      const { supabase } = await import("@/lib/supabase");
      const { chunkText } = await import("@/lib/ingestion");
      const { generateEmbedding, callGemini } = await import("@/lib/ai");

      const rawText = buffer.toString("utf-8");

      // Insert document
      const { data: doc, error: docError } = await supabase
        .from("documents")
        .insert({
          title: file.name,
          source_type: sourceType,
          raw_text: rawText,
          metadata: { original_filename: file.name, char_count: rawText.length },
        })
        .select("id")
        .single();

      if (docError || !doc) {
        throw new Error(`Failed to insert document: ${docError?.message}`);
      }

      const textChunks = chunkText(rawText);
      const chunkRows = [];
      for (let i = 0; i < textChunks.length; i++) {
        const embedding = await generateEmbedding(textChunks[i]);
        chunkRows.push({
          document_id: doc.id,
          content: textChunks[i],
          embedding: JSON.stringify(embedding),
          chunk_index: i,
        });
      }

      await supabase.from("chunks").insert(chunkRows);

      // Extract entity relationships to build the graph (limit to 3 chunks to avoid Gemini free tier rate limit)
      let totalEdges = 0;
      for (const chunk of textChunks.slice(0, 3)) {
        try {
          const entities = await callGemini<
            Array<{ subject: string; predicate: string; object: string; confidence: number }>
          >(
            `Extract subject-predicate-object triples from the text. Return ONLY a JSON array of objects with: subject, predicate, object, confidence (0-1). If none found, return [].`,
            chunk
          );
          if (Array.isArray(entities) && entities.length > 0) {
            const edgeRows = entities.map((e) => ({
              subject: e.subject.toLowerCase(),
              predicate: e.predicate.toLowerCase(),
              object: e.object.toLowerCase(),
              source_document_id: doc.id,
              confidence: e.confidence,
            }));
            await supabase.from("entity_edges").insert(edgeRows);
            totalEdges += edgeRows.length;
          }
        } catch {
          // Continue on extraction failure
        }
      }

      result = {
        documentId: doc.id,
        chunkCount: textChunks.length,
        edgeCount: totalEdges,
      };
    } else {
      // PDF file
      result = await ingestDocument(buffer, file.name, sourceType);
    }

    return NextResponse.json({
      success: true,
      document_id: result.documentId,
      chunks_created: result.chunkCount,
      entity_edges_extracted: result.edgeCount,
      message: `Document "${file.name}" ingested successfully.`,
    });
  } catch (error) {
    console.error("Upload error:", error);
    const message =
      error instanceof Error ? error.message : "Unknown error during upload";
    return NextResponse.json({ error: message }, { status: 500 });
  }
}
