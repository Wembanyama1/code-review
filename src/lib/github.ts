/* ──────────────────────────────────────────────
   GitHub Repository Parser
   ────────────────────────────────────────────── */

/* ─── config ─── */

const GITHUB_API = "https://api.github.com";

const MAX_FILE_SIZE = 100_000; // bytes — skip anything bigger
const MAX_FILES = 40; // cap on how many files to fetch
const MAX_TOTAL_CHARS = 200_000; // cap on context string length
const BATCH_SIZE = 6; // parallel fetch concurrency

/** Extensions we consider "code" — grouped by language */
const CODE_EXTENSIONS = new Set([
  // JS/TS
  ".js", ".jsx", ".ts", ".tsx", ".mjs", ".cjs", ".mts",
  // Python
  ".py", ".pyi",
  // Java
  ".java",
  // C/C++
  ".c", ".cpp", ".cc", ".cxx", ".h", ".hpp", ".hxx",
  // Go / Rust / C# / etc.
  ".go", ".rs", ".cs", ".rb", ".kt", ".kts", ".swift",
  ".scala", ".php", ".lua", ".pl", ".r",
  // Shell
  ".sh", ".bash", ".zsh",
  // Config that often contains secrets
  ".env", ".yml", ".yaml", ".toml", ".ini", ".cfg", ".conf",
  // Web
  ".html", ".htm", ".css", ".scss", ".less", ".vue", ".svelte",
  // SQL
  ".sql",
]);

/** Files we always skip — exact filename match */
const SKIP_FILES = new Set([
  "package-lock.json",
  "yarn.lock",
  "pnpm-lock.yaml",
  "bun.lockb",
  "go.sum",
  "Cargo.lock",
  "poetry.lock",
  "Pipfile.lock",
  ".DS_Store",
  "Thumbs.db",
]);

/** Directories we always skip */
const SKIP_DIRS = new Set([
  "node_modules", ".git", ".github", ".vscode", ".idea",
  "dist", "build", ".next", ".nuxt", ".output",
  "vendor", "venv", ".venv", "env",
  "__pycache__", ".mypy_cache", ".pytest_cache",
  "coverage", ".nyc_output", ".coverage",
  "target", "out", "tmp", ".cache",
  "assets", "static", "public", // usually non-code
]);

/** Patterns to skip — matched against each path segment */
const SKIP_PATTERNS = [/\.min\./, /\.bundle\./, /\.test$/, /\.spec$/];

/** Entry-point files to prioritize (placed first in context) */
const ENTRY_FILES = [
  "index", "main", "app", "server", "router",
  "routes", "config", "settings", "__init__",
];

/* ─── types ─── */

export interface GitHubFile {
  path: string;
  content: string;
  size: number;
  lang: string;
}

export interface RepoInfo {
  owner: string;
  repo: string;
  branch: string;
  url: string;
}

export interface FetchResult {
  info: RepoInfo;
  files: GitHubFile[];
  context: string;
  stats: {
    totalFiles: number;
    totalChars: number;
    skippedOversized: number;
    skippedFiltered: number;
  };
}

/* ─── public API ─── */

export async function fetchRepo(
  repoUrl: string,
  token?: string
): Promise<FetchResult> {
  const info = parseRepoUrl(repoUrl);
  const headers = buildHeaders(token);

  // resolve branch
  const branch = info.branch || (await getDefaultBranch(info.owner, info.repo, headers));
  info.branch = branch;

  // fetch tree
  const tree = await fetchTree(info.owner, info.repo, branch, headers);

  // filter & prioritise
  const { candidates, skippedFiltered } = filterTree(tree);

  if (candidates.length === 0) {
    throw new Error("No analyzable code files found in this repository");
  }

  // select top N by priority
  const selected = candidates
    .sort(scoreFile)
    .slice(0, MAX_FILES);

  // fetch contents
  const { files, skippedOversized, totalChars } = await fetchContents(
    info.owner, info.repo, selected, headers
  );

  if (files.length === 0) {
    throw new Error("All code files were empty or too large to analyze");
  }

  const context = buildContext(files);

  return {
    info,
    files,
    context,
    stats: {
      totalFiles: files.length,
      totalChars,
      skippedOversized,
      skippedFiltered,
    },
  };
}

/* ─── URL parser ─── */

function parseRepoUrl(raw: string): RepoInfo {
  const url = raw.trim().replace(/\.git$/, "").replace(/\/+$/, "");

  // https://github.com/owner/repo
  // https://github.com/owner/repo/tree/branch
  // https://github.com/owner/repo/tree/branch/path/to/dir
  // https://github.com/owner/repo/blob/branch/path/to/file.py
  const https = url.match(
    /^https?:\/\/github\.com\/([^/\s]+)\/([^/\s#]+)(?:\/(?:tree|blob)\/([^/\s#]+)(?:\/.*)?)?$/
  );
  if (https) {
    return {
      owner: https[1],
      repo: https[2],
      branch: https[3] || "",
      url: `https://github.com/${https[1]}/${https[2]}`,
    };
  }

  // git@github.com:owner/repo
  const ssh = url.match(/^git@github\.com:([^/\s]+)\/(.+)$/);
  if (ssh) {
    return {
      owner: ssh[1],
      repo: ssh[2],
      branch: "",
      url: `https://github.com/${ssh[1]}/${ssh[2]}`,
    };
  }

  throw new Error(
    "Invalid GitHub URL. Use format: https://github.com/owner/repo"
  );
}

/* ─── GitHub API helpers ─── */

function buildHeaders(token?: string): Record<string, string> {
  const h: Record<string, string> = {
    Accept: "application/vnd.github.v3+json",
    "User-Agent": "ai-code-review",
  };
  if (token) h.Authorization = `Bearer ${token}`;
  return h;
}

async function getDefaultBranch(
  owner: string,
  repo: string,
  headers: Record<string, string>
): Promise<string> {
  const res = await fetch(`${GITHUB_API}/repos/${owner}/${repo}`, {
    headers,
    next: { revalidate: 600 },
  });
  if (!res.ok) return "main";
  const data = (await res.json()) as { default_branch: string };
  return data.default_branch;
}

interface TreeNode {
  path: string;
  type: string;
  size?: number;
}

async function fetchTree(
  owner: string,
  repo: string,
  ref: string,
  headers: Record<string, string>
): Promise<TreeNode[]> {
  const url = `${GITHUB_API}/repos/${owner}/${repo}/git/trees/${ref}?recursive=1`;
  const res = await fetch(url, { headers, next: { revalidate: 300 } });

  if (!res.ok) {
    const body = await res.text();
    if (res.status === 404) {
      throw new Error(`Repository or branch not found: ${owner}/${repo}@${ref}`);
    }
    if (res.status === 403) {
      throw new Error(
        "GitHub API rate limit exceeded. Set GITHUB_TOKEN in .env.local to increase limits."
      );
    }
    throw new Error(`GitHub API error (${res.status}): ${body.slice(0, 200)}`);
  }

  const json = (await res.json()) as { tree: TreeNode[]; truncated?: boolean };

  if (json.truncated) {
    // tree too large for single request — still use what we got
    console.warn(`[github] Tree truncated for ${owner}/${repo} — some files may be missing`);
  }

  return json.tree;
}

/* ─── file filtering ─── */

interface FilteredFile {
  path: string;
  size: number;
  ext: string;
}

function filterTree(tree: TreeNode[]): {
  candidates: FilteredFile[];
  skippedFiltered: number;
} {
  const candidates: FilteredFile[] = [];
  let skippedFiltered = 0;

  for (const node of tree) {
    if (node.type !== "blob") continue;

    const path = node.path;
    const segments = path.split("/");

    // skip directories
    if (segments.some((s) => SKIP_DIRS.has(s))) {
      skippedFiltered++;
      continue;
    }

    // skip exact filenames
    const filename = segments[segments.length - 1];
    if (SKIP_FILES.has(filename)) {
      skippedFiltered++;
      continue;
    }

    // skip patterns
    if (SKIP_PATTERNS.some((p) => p.test(filename))) {
      skippedFiltered++;
      continue;
    }

    // skip lock files by prefix
    if (filename.endsWith(".lock") || filename.endsWith(".lock.json")) {
      skippedFiltered++;
      continue;
    }

    // check extension
    const ext = getExtension(filename);
    if (!CODE_EXTENSIONS.has(ext)) {
      skippedFiltered++;
      continue;
    }

    candidates.push({ path, size: node.size || 0, ext });
  }

  return { candidates, skippedFiltered };
}

/**
 * Score a file — lower = higher priority.
 * Entry points and shallow files rank first.
 */
function scoreFile(a: FilteredFile, b: FilteredFile): number {
  const scoreA = fileScore(a);
  const scoreB = fileScore(b);
  return scoreA - scoreB;
}

function fileScore(f: FilteredFile): number {
  let score = 0;

  // depth penalty: 10 per directory level
  score += f.path.split("/").length * 10;

  // entry-point bonus
  const name = f.path.split("/").pop()?.replace(/\.[^.]+$/, "").toLowerCase() || "";
  if (ENTRY_FILES.includes(name)) score -= 100;

  // config/env bonus (often contain secrets)
  if (f.ext === ".env" || f.ext === ".yml" || f.ext === ".yaml" || f.ext === ".toml") {
    score -= 50;
  }

  // test file penalty (already filtered by SKIP_PATTERNS, but belt-and-suspenders)
  if (f.path.includes("test") || f.path.includes("spec")) score += 200;

  return score;
}

/* ─── content fetching ─── */

async function fetchContents(
  owner: string,
  repo: string,
  files: FilteredFile[],
  headers: Record<string, string>
): Promise<{
  files: GitHubFile[];
  skippedOversized: number;
  totalChars: number;
}> {
  const result: GitHubFile[] = [];
  let skippedOversized = 0;
  let totalChars = 0;

  for (let i = 0; i < files.length; i += BATCH_SIZE) {
    if (totalChars >= MAX_TOTAL_CHARS) break;

    const batch = files.slice(i, i + BATCH_SIZE);
    const fetched = await Promise.all(
      batch.map((f) => fetchSingleFile(owner, repo, f, headers))
    );

    for (const file of fetched) {
      if (!file) {
        skippedOversized++;
        continue;
      }
      if (totalChars + file.content.length > MAX_TOTAL_CHARS) continue;

      result.push(file);
      totalChars += file.content.length;
    }
  }

  return { files: result, skippedOversized, totalChars };
}

async function fetchSingleFile(
  owner: string,
  repo: string,
  file: FilteredFile,
  headers: Record<string, string>
): Promise<GitHubFile | null> {
  // skip oversized before even fetching
  if (file.size > MAX_FILE_SIZE) return null;

  const url = `${GITHUB_API}/repos/${owner}/${repo}/contents/${encodeURIComponent(file.path)}`;
  const res = await fetch(url, { headers });

  if (!res.ok) return null;

  const data = (await res.json()) as {
    content?: string;
    encoding?: string;
    size?: number;
  };

  if (data.size && data.size > MAX_FILE_SIZE) return null;

  if (data.encoding !== "base64" || !data.content) return null;

  const content = Buffer.from(data.content, "base64").toString("utf-8");

  // skip binary-looking content (null bytes)
  if (content.includes("\0")) return null;

  return {
    path: file.path,
    content,
    size: data.size || file.size,
    lang: extToLang(file.ext),
  };
}

/* ─── context builder ─── */

function buildContext(files: GitHubFile[]): string {
  const parts: string[] = [];

  parts.push(`# Repository Analysis Context`);
  parts.push(`# Files: ${files.length}`);
  parts.push(`# Total chars: ${files.reduce((n, f) => n + f.content.length, 0)}`);
  parts.push("");

  for (const file of files) {
    parts.push(fileMarker(file.path));
    parts.push(`# lang: ${file.lang}  size: ${file.size} bytes`);
    parts.push(file.content);
    parts.push("");
  }

  return parts.join("\n");
}

function fileMarker(path: string): string {
  return `// ====== ${path} ======`;
}

/* ─── utility ─── */

function getExtension(filename: string): string {
  const dot = filename.lastIndexOf(".");
  // handle dotfiles like .env, .gitignore
  if (dot <= 0) return dot === 0 ? filename.toLowerCase() : "";
  return filename.slice(dot).toLowerCase();
}

const EXT_LANG: Record<string, string> = {
  ".js": "javascript", ".jsx": "javascript", ".mjs": "javascript", ".cjs": "javascript",
  ".ts": "typescript", ".tsx": "typescript", ".mts": "typescript",
  ".py": "python", ".pyi": "python",
  ".java": "java",
  ".c": "c", ".h": "c",
  ".cpp": "cpp", ".cc": "cpp", ".cxx": "cpp", ".hpp": "cpp", ".hxx": "cpp",
  ".go": "go", ".rs": "rust", ".rb": "ruby",
  ".cs": "csharp", ".kt": "kotlin", ".swift": "swift",
  ".scala": "scala", ".php": "php", ".lua": "lua",
  ".sh": "shell", ".bash": "shell", ".zsh": "shell",
  ".sql": "sql",
  ".html": "html", ".htm": "html", ".css": "css",
  ".yml": "yaml", ".yaml": "yaml", ".toml": "toml", ".json": "json",
  ".vue": "vue", ".svelte": "svelte",
  ".env": "dotenv",
};

function extToLang(ext: string): string {
  return EXT_LANG[ext] || ext.slice(1) || "text";
}
