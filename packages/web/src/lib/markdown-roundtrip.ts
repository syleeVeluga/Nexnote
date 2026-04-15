/**
 * Headless markdown round-trip engine.
 *
 * Creates a Tiptap editor in memory (jsdom) to test:
 *   markdown -> Tiptap JSON -> markdown
 * Uses the same extension set as the UI editor via getEditorExtensions().
 */

import { Editor } from "@tiptap/core";
import { getEditorExtensions, getEditorMarkdown } from "./markdown.js";

function createHeadlessEditor(content: string): Editor {
  return new Editor({
    element: document.createElement("div"),
    extensions: getEditorExtensions(),
    content,
  });
}

export interface RoundTripResult {
  input: string;
  json: Record<string, unknown>;
  output: string;
  match: boolean;
}

/**
 * Run a markdown round-trip:
 *   input markdown -> editor (JSON) -> output markdown
 */
export function roundTrip(markdown: string): RoundTripResult {
  const editor = createHeadlessEditor(markdown);
  const json = editor.getJSON() as Record<string, unknown>;
  const output = getEditorMarkdown(editor);
  editor.destroy();

  return {
    input: markdown,
    json,
    output,
    match: normalizeWhitespace(markdown) === normalizeWhitespace(output),
  };
}

/**
 * Normalize whitespace for comparison: trim, collapse multiple blank lines.
 */
export function normalizeWhitespace(s: string): string {
  return s
    .replace(/\r\n/g, "\n")
    .replace(/\n{3,}/g, "\n\n")
    .trim();
}
