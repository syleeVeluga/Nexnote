import { useTranslation } from "react-i18next";
import type { Editor } from "@tiptap/react";

interface ToolbarProps {
  editor: Editor;
}

export function EditorToolbar({ editor }: ToolbarProps) {
  const { t } = useTranslation("editor");

  return (
    <div className="editor-toolbar">
      <div className="toolbar-group">
        <ToolbarBtn
          label="B"
          title={t("bold")}
          active={editor.isActive("bold")}
          onClick={() => editor.chain().focus().toggleBold().run()}
        />
        <ToolbarBtn
          label="I"
          title={t("italic")}
          active={editor.isActive("italic")}
          onClick={() => editor.chain().focus().toggleItalic().run()}
        />
        <ToolbarBtn
          label="S"
          title={t("strikethrough")}
          active={editor.isActive("strike")}
          onClick={() => editor.chain().focus().toggleStrike().run()}
        />
        <ToolbarBtn
          label="<>"
          title={t("inlineCode")}
          active={editor.isActive("code")}
          onClick={() => editor.chain().focus().toggleCode().run()}
        />
      </div>

      <div className="toolbar-divider" />

      <div className="toolbar-group">
        <ToolbarBtn
          label="H1"
          title={t("heading1")}
          active={editor.isActive("heading", { level: 1 })}
          onClick={() => editor.chain().focus().toggleHeading({ level: 1 }).run()}
        />
        <ToolbarBtn
          label="H2"
          title={t("heading2")}
          active={editor.isActive("heading", { level: 2 })}
          onClick={() => editor.chain().focus().toggleHeading({ level: 2 }).run()}
        />
        <ToolbarBtn
          label="H3"
          title={t("heading3")}
          active={editor.isActive("heading", { level: 3 })}
          onClick={() => editor.chain().focus().toggleHeading({ level: 3 }).run()}
        />
      </div>

      <div className="toolbar-divider" />

      <div className="toolbar-group">
        <ToolbarBtn
          label="UL"
          title={t("bulletList")}
          active={editor.isActive("bulletList")}
          onClick={() => editor.chain().focus().toggleBulletList().run()}
        />
        <ToolbarBtn
          label="OL"
          title={t("orderedList")}
          active={editor.isActive("orderedList")}
          onClick={() => editor.chain().focus().toggleOrderedList().run()}
        />
        <ToolbarBtn
          label="TL"
          title={t("taskList")}
          active={editor.isActive("taskList")}
          onClick={() => editor.chain().focus().toggleTaskList().run()}
        />
      </div>

      <div className="toolbar-divider" />

      <div className="toolbar-group">
        <ToolbarBtn
          label={"\u201C"}
          title={t("blockquote")}
          active={editor.isActive("blockquote")}
          onClick={() => editor.chain().focus().toggleBlockquote().run()}
        />
        <ToolbarBtn
          label="{}"
          title={t("codeBlock")}
          active={editor.isActive("codeBlock")}
          onClick={() => editor.chain().focus().toggleCodeBlock().run()}
        />
        <ToolbarBtn
          label="---"
          title={t("horizontalRule")}
          active={false}
          onClick={() => editor.chain().focus().setHorizontalRule().run()}
        />
      </div>
    </div>
  );
}

function ToolbarBtn({
  label,
  title,
  active,
  onClick,
}: {
  label: string;
  title: string;
  active: boolean;
  onClick: () => void;
}) {
  return (
    <button
      type="button"
      className={`toolbar-btn${active ? " active" : ""}`}
      title={title}
      onClick={onClick}
    >
      {label}
    </button>
  );
}
