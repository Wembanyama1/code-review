import { NextRequest, NextResponse } from "next/server";
import { analyzeWithAI } from "@/lib/ai";
import { fetchRepo } from "@/lib/github";
import { EMPTY_RESULT } from "@/lib/types";

export const maxDuration = 120;

export async function POST(req: NextRequest) {
  try {
    const body = await req.json();
    const repoUrl = body.repoUrl;

    if (!repoUrl || typeof repoUrl !== "string") {
      return NextResponse.json(
        { error: "repoUrl is required and must be a string" },
        { status: 400 }
      );
    }

    if (!repoUrl.includes("github.com")) {
      return NextResponse.json(
        { error: "Only GitHub repositories are supported" },
        { status: 400 }
      );
    }

    const { context, info, stats } = await fetchRepo(
      repoUrl,
      process.env.GITHUB_TOKEN
    );

    const prompt = `Analyze the following GitHub repository: ${info.url} (${info.owner}/${info.repo}@${info.branch})

${context}`;

    const lang = body.lang === "zh" ? "zh" : "en";
    const result = await analyzeWithAI(prompt, lang);

    return NextResponse.json({
      ...result,
      _repo: {
        owner: info.owner,
        repo: info.repo,
        branch: info.branch,
        filesAnalyzed: stats.totalFiles,
        totalChars: stats.totalChars,
      },
    });
  } catch (err: any) {
    console.error("[analyze-repo]", err);

    const message = err.message || "Analysis failed";
    const status = message.includes("not found")
      ? 404
      : message.includes("rate limit")
        ? 429
        : message.includes("ANTHROPIC_AUTH_TOKEN")
          ? 500
          : message.includes("timed out")
            ? 504
            : 500;

    return NextResponse.json(
      { ...EMPTY_RESULT, error: message },
      { status }
    );
  }
}
