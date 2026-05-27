# CodeReview AI

AI-powered code review tool. Paste a GitHub repo or code snippet, get instant security audits, logic checks, and production-ready fixes.

**[Live Demo](https://your-vercel-url.vercel.app)** <!-- Replace after deploying -->

## Features

- **Security Analysis** — Detects SQL injection, XSS, hardcoded secrets, path traversal, SSRF, and 20+ vulnerability patterns
- **Logic Checks** — Finds null dereferences, race conditions, unhandled errors, infinite loops
- **Quality Review** — Spots dead code, magic numbers, missing types, inconsistent naming
- **Smart Suggestions** — Actionable fixes with production-ready corrected code
- **GitHub Integration** — Analyze entire repos (supports `/tree/` and `/blob/` URLs)
- **PDF / JSON Export** — Download formatted reports
- **Bilingual UI** — English / Chinese (中文) toggle, AI reports follow the selected language
- **Review History** — Local browser storage of past analyses

## Tech Stack

- **Framework:** Next.js 14 (App Router)
- **Styling:** Tailwind CSS
- **AI:** Anthropic SDK (compatible with any Anthropic-API-compatible provider)
- **PDF:** jsPDF (client-side generation)
- **Language:** TypeScript

## Quick Start

### 1. Clone & Install

```bash
git clone https://github.com/YOUR_USERNAME/code-review-ai.git
cd code-review-ai
npm install
```

### 2. Configure Environment

```bash
cp .env.local.example .env.local
```

Edit `.env.local`:

```env
# Required: Your Anthropic API key
ANTHROPIC_AUTH_TOKEN=sk-ant-xxxxx

# Optional: Custom API base URL (for proxies or compatible providers)
# ANTHROPIC_BASE_URL=https://api.anthropic.com

# Optional: Model name (defaults to claude-sonnet-4-20250514)
# ANTHROPIC_MODEL=claude-sonnet-4-20250514

# Optional: GitHub token for higher rate limits and private repos
# GITHUB_TOKEN=ghp_xxxxx
```

### 3. Run

```bash
npm run dev
```

Open [http://localhost:3000](http://localhost:3000).

## Deploy to Vercel

[![Deploy with Vercel](https://vercel.com/button)](https://vercel.com/new/clone?repository-url=https://github.com/YOUR_USERNAME/code-review-ai&env=ANTHROPIC_AUTH_TOKEN)

Or manually:

1. Push this repo to GitHub
2. Import in [Vercel](https://vercel.com)
3. Add environment variables in Vercel dashboard:
   - `ANTHROPIC_AUTH_TOKEN` (required)
   - `ANTHROPIC_BASE_URL` (optional, for custom providers)
   - `ANTHROPIC_MODEL` (optional)
   - `GITHUB_TOKEN` (optional)
4. Deploy

### Deploy to Other Platforms

This is a standard Next.js app. It works on any platform that supports Node.js:

```bash
npm run build
npm start
```

## Project Structure

```
src/
├── app/
│   ├── api/
│   │   ├── analyze-code/route.ts   # Single code analysis endpoint
│   │   └── analyze-repo/route.ts   # GitHub repo analysis endpoint
│   ├── globals.css                  # Styles & animations
│   ├── layout.tsx                   # Root layout with fonts
│   └── page.tsx                     # Main page
├── components/
│   └── CodeReviewApp.tsx            # Full UI (input, dashboard, history)
└── lib/
    ├── ai.ts                        # Anthropic SDK integration
    ├── github.ts                    # GitHub repo parser
    ├── i18n.ts                      # Translations (en/zh)
    ├── prompts.ts                   # AI system prompt & builders
    └── types.ts                     # Shared TypeScript types
```

## How It Works

1. User pastes code or a GitHub URL
2. Code is sent to `/api/analyze-code` or `/api/analyze-repo`
3. The API builds a structured prompt with a security-engineer persona
4. Anthropic-compatible AI analyzes the code and returns structured JSON
5. Results are displayed in an interactive dashboard with issue filtering, suggestions, and fixed code

## License

MIT
