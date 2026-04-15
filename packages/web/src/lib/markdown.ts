/**
 * Shared Tiptap configuration — single source of truth for editor extensions,
 * lowlight instance, and markdown accessor. Both the UI editor and headless
 * round-trip engine import from here to guarantee round-trip fidelity.
 */

import type { Editor } from "@tiptap/core";
import { generateJSON, generateHTML } from "@tiptap/react";
import StarterKit from "@tiptap/starter-kit";
import Link from "@tiptap/extension-link";
import Image from "@tiptap/extension-image";
import TaskList from "@tiptap/extension-task-list";
import TaskItem from "@tiptap/extension-task-item";
import { Table } from "@tiptap/extension-table";
import TableRow from "@tiptap/extension-table-row";
import TableCell from "@tiptap/extension-table-cell";
import TableHeader from "@tiptap/extension-table-header";
import CodeBlockLowlight from "@tiptap/extension-code-block-lowlight";
import { Markdown } from "tiptap-markdown";
import { common, createLowlight } from "lowlight";
import { SlashCommandExtension } from "../components/editor/SlashCommand.js";

export const lowlight = createLowlight(common);

/**
 * Core extension set shared by every editor instance (UI and headless).
 * Append UI-only extensions (e.g. Placeholder) at the call site.
 */
export function getEditorExtensions() {
  return [
    StarterKit.configure({ codeBlock: false }),
    Link.configure({ openOnClick: false, autolink: true }),
    Image,
    TaskList,
    TaskItem.configure({ nested: true }),
    Table.configure({ resizable: true }),
    TableRow,
    TableCell,
    TableHeader,
    CodeBlockLowlight.configure({ lowlight }),
    Markdown.configure({
      html: false,
      transformPastedText: true,
      transformCopiedText: true,
    }),
    SlashCommandExtension,
  ];
}

/**
 * Typed accessor for tiptap-markdown's storage — avoids `as any` casts.
 */
export function getEditorMarkdown(editor: Editor): string {
  const storage = editor.storage as unknown as {
    markdown: { getMarkdown(): string };
  };
  return storage.markdown.getMarkdown();
}

export function htmlToJSON(html: string): Record<string, unknown> {
  return generateJSON(html, getEditorExtensions()) as Record<string, unknown>;
}

export function jsonToHTML(doc: Record<string, unknown>): string {
  return generateHTML(doc, getEditorExtensions());
}
