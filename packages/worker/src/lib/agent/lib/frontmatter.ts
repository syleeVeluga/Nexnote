const FRONTMATTER_RE = /^---\r?\n([\s\S]*?)\r?\n---[^\S\r\n]*(?:\r?\n|$)/;

export interface ParsedFrontmatter {
  data: Record<string, unknown> | null;
  parseError?: string;
}

function stripQuotes(value: string): string {
  if (value.length < 2) return value;
  const first = value[0];
  const last = value[value.length - 1];
  if ((first === '"' && last === '"') || (first === "'" && last === "'")) {
    return value.slice(1, -1);
  }
  return value;
}

function coerceScalar(raw: string): unknown {
  const trimmed = raw.trim();
  if (trimmed === "") return "";
  const quoted =
    (trimmed.startsWith('"') && trimmed.endsWith('"')) ||
    (trimmed.startsWith("'") && trimmed.endsWith("'"));
  if (quoted) return stripQuotes(trimmed);
  if (trimmed === "null" || trimmed === "~") return null;
  if (trimmed === "true") return true;
  if (trimmed === "false") return false;
  if (/^-?\d+$/.test(trimmed)) {
    const asInt = Number.parseInt(trimmed, 10);
    if (Number.isFinite(asInt)) return asInt;
  }
  if (/^-?\d+\.\d+$/.test(trimmed)) {
    const asFloat = Number.parseFloat(trimmed);
    if (Number.isFinite(asFloat)) return asFloat;
  }
  return trimmed;
}

function parseInlineArray(value: string): unknown[] {
  const inner = value.slice(1, -1);
  if (inner.trim() === "") return [];
  return inner.split(",").map((item) => coerceScalar(item.trim()));
}

function parseFrontmatterBody(body: string): {
  data: Record<string, unknown>;
  hadIssues: boolean;
} {
  const out: Record<string, unknown> = {};
  const lines = body.split(/\r?\n/);
  let hadIssues = false;

  let pendingKey: string | null = null;
  let pendingList: unknown[] | null = null;

  const flushPending = () => {
    if (pendingKey && pendingList) {
      out[pendingKey] = pendingList;
    }
    pendingKey = null;
    pendingList = null;
  };

  for (const line of lines) {
    if (!line.trim()) {
      flushPending();
      continue;
    }

    const listItem = /^\s*-\s+(.*)$/.exec(line);
    if (listItem && pendingKey && pendingList) {
      pendingList.push(coerceScalar(listItem[1]));
      continue;
    }

    const kv = /^([A-Za-z_][A-Za-z0-9_-]*)\s*:\s*(.*)$/.exec(line);
    if (!kv) {
      hadIssues = true;
      flushPending();
      continue;
    }

    flushPending();
    const [, key, rawValue] = kv;
    const value = rawValue.trim();

    if (!value) {
      pendingKey = key;
      pendingList = [];
      continue;
    }

    if (/^\[.*\]$/.test(value)) {
      out[key] = parseInlineArray(value);
      continue;
    }

    out[key] = coerceScalar(value);
  }

  flushPending();
  return { data: out, hadIssues };
}

export function parseFrontmatter(contentMd: string): ParsedFrontmatter {
  const match = FRONTMATTER_RE.exec(contentMd);
  if (!match) return { data: null };

  const body = match[1];
  if (body.trim() === "") {
    return { data: {} };
  }

  try {
    const { data, hadIssues } = parseFrontmatterBody(body);
    if (hadIssues && Object.keys(data).length === 0) {
      return {
        data: null,
        parseError:
          "frontmatter body had no parseable key:value pairs",
      };
    }
    return hadIssues
      ? {
          data,
          parseError:
            "frontmatter body contained unparseable lines that were skipped",
        }
      : { data };
  } catch (err) {
    return {
      data: null,
      parseError: err instanceof Error ? err.message : String(err),
    };
  }
}
