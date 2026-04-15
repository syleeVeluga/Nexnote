import { useEditor, EditorContent } from "@tiptap/react";
import Placeholder from "@tiptap/extension-placeholder";
import { useEffect, useImperativeHandle, forwardRef } from "react";
import { getEditorExtensions, getEditorMarkdown } from "../../lib/markdown.js";
import { EditorToolbar } from "./EditorToolbar.js";

export interface TiptapEditorHandle {
  getMarkdown: () => string;
  getJSON: () => Record<string, unknown>;
  setMarkdown: (md: string) => void;
}

interface TiptapEditorProps {
  initialContent?: string;
  onChange?: (markdown: string) => void;
  editable?: boolean;
}

export const TiptapEditor = forwardRef<TiptapEditorHandle, TiptapEditorProps>(
  function TiptapEditor({ initialContent = "", onChange, editable = true }, ref) {
    const editor = useEditor({
      extensions: [
        ...getEditorExtensions(),
        Placeholder.configure({ placeholder: "Start writing..." }),
      ],
      content: initialContent,
      editable,
      onUpdate: ({ editor }) => {
        onChange?.(getEditorMarkdown(editor));
      },
    });

    useEffect(() => {
      if (editor) {
        editor.setEditable(editable);
      }
    }, [editor, editable]);

    useImperativeHandle(
      ref,
      () => ({
        getMarkdown: () => {
          if (!editor) return "";
          return getEditorMarkdown(editor);
        },
        getJSON: () => {
          if (!editor) return {};
          return editor.getJSON() as Record<string, unknown>;
        },
        setMarkdown: (md: string) => {
          if (!editor) return;
          editor.commands.setContent(md);
        },
      }),
      [editor],
    );

    if (!editor) {
      return <div className="editor-loading">Loading editor...</div>;
    }

    return (
      <div className="tiptap-editor">
        {editable && <EditorToolbar editor={editor} />}
        <EditorContent editor={editor} className="tiptap-content" />
      </div>
    );
  },
);
