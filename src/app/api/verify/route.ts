import { NextRequest, NextResponse } from "next/server";
import { supabase } from "@/lib/supabase";
import { runVerificationPipeline } from "@/lib/agents";
import type { StreamEvent } from "@/lib/types";

export const maxDuration = 300; // 5 min timeout for full pipeline
export const dynamic = "force-dynamic";

export async function POST(request: NextRequest) {
  try {
    const body = await request.json();
    const query = body.query as string;

    if (!query || query.trim().length === 0) {
      return NextResponse.json(
        { error: "Missing 'query' in request body." },
        { status: 400 }
      );
    }

    // Check if client wants SSE streaming
    const wantsStream = request.headers.get("accept") === "text/event-stream";

    if (wantsStream) {
      // Server-Sent Events streaming response
      const encoder = new TextEncoder();

      const stream = new ReadableStream({
        async start(controller) {
          const send = (event: StreamEvent) => {
            const data = `data: ${JSON.stringify(event)}\n\n`;
            controller.enqueue(encoder.encode(data));
          };

          try {
            // Create a pending verification run
            const { data: run, error: runError } = await supabase
              .from("verification_runs")
              .insert({ query, status: "running" })
              .select("id")
              .single();

            if (runError || !run) {
              send({
                stage: "error",
                message: `Failed to create verification run: ${runError?.message}`,
              });
              controller.close();
              return;
            }

            send({
              stage: "planning",
              message: "Verification started...",
              progress: 0,
              data: { run_id: run.id },
            });

            // Run the full pipeline with streaming callbacks
            const report = await runVerificationPipeline(query, send);

            // Save the completed report
            await supabase
              .from("verification_runs")
              .update({
                status: "complete",
                report: report,
                risk_score: report.overall_risk_score,
              })
              .eq("id", run.id);

            send({
              stage: "complete",
              message: "Verification complete.",
              progress: 100,
              data: { run_id: run.id, report },
            });
          } catch (error) {
            const message =
              error instanceof Error ? error.message : "Pipeline error";
            send({ stage: "error", message });
          } finally {
            controller.close();
          }
        },
      });

      return new Response(stream, {
        headers: {
          "Content-Type": "text/event-stream",
          "Cache-Control": "no-cache",
          Connection: "keep-alive",
        },
      });
    }

    // Non-streaming: run synchronously and return the result
    const { data: run, error: runError } = await supabase
      .from("verification_runs")
      .insert({ query, status: "running" })
      .select("id")
      .single();

    if (runError || !run) {
      return NextResponse.json(
        { error: `Failed to create verification run: ${runError?.message}` },
        { status: 500 }
      );
    }

    try {
      const report = await runVerificationPipeline(query);

      await supabase
        .from("verification_runs")
        .update({
          status: "complete",
          report,
          risk_score: report.overall_risk_score,
        })
        .eq("id", run.id);

      return NextResponse.json({
        run_id: run.id,
        report,
      });
    } catch (error) {
      await supabase
        .from("verification_runs")
        .update({ status: "failed" })
        .eq("id", run.id);

      const message =
        error instanceof Error ? error.message : "Pipeline failed";
      return NextResponse.json({ error: message }, { status: 500 });
    }
  } catch (error) {
    const message = error instanceof Error ? error.message : "Unknown error";
    return NextResponse.json({ error: message }, { status: 500 });
  }
}
