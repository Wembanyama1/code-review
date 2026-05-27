import { NextRequest, NextResponse } from "next/server";
import { analyzeWithAI } from "@/lib/ai";
import { buildUserCodePrompt } from "@/lib/prompts";
import { EMPTY_RESULT } from "@/lib/types";

export const maxDuration = 60; // seconds

export async function POST(req: NextRequest) {
  try {
    const body = await req.json();
    const code = body.code;

    if (!code || typeof code !== "string") {
      return NextResponse.json(
        { error: "code is required and must be a string" },
        { status: 400 }
      );
    }

    if (code.trim().length === 0) {
      return NextResponse.json(
        { error: "code cannot be empty" },
        { status: 400 }
      );
    }

    const prompt = buildUserCodePrompt(code);
    const lang = body.lang === "zh" ? "zh" : "en";
    const result = await analyzeWithAI(prompt, lang);

    return NextResponse.json(result);
  } catch (err: any) {
    console.error("[analyze-code]", err);

    const message = err.message || "Analysis failed";
    const status = message.includes("ANTHROPIC_AUTH_TOKEN")
      ? 500
      : message.includes("Rate limit")
        ? 429
        : message.includes("timed out")
          ? 504
          : 500;

    return NextResponse.json(
      { ...EMPTY_RESULT, error: message },
      { status }
    );
  }
}
