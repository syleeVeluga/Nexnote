/**
 * Tiptap Slash Command extension
 *
 * Triggers a command palette when the user types "/" at the start of
 * an empty block. Uses @tiptap/suggestion under the hood.
 */
import { Extension } from "@tiptap/core";
import Suggestion from "@tiptap/suggestion";
import type { SuggestionProps, SuggestionKeyDownProps } from "@tiptap/suggestion";
import type { Editor, Range } from "@tiptap/core";
import {
  createRef,
  forwardRef,
  useEffect,
  useImperativeHandle,
  useState,
} from "react";
import { createRoot } from "react-dom/client";

// ---------------------------------------------------------------------------
// Command definitions
// ---------------------------------------------------------------------------

interface SlashCommand {
  title: string;
  description: string;
  icon: string;
  command: (props: { editor: Editor; range: Range }) => void;
}

const COMMANDS: SlashCommand[] = [
  {
    title: "Heading 1",
    description: "Big section heading",
    icon: "H1",
    command: ({ editor, range }) =>
      editor.chain().focus().deleteRange(range).setHeading({ level: 1 }).run(),
  },
  {
    title: "Heading 2",
    description: "Medium section heading",
    icon: "H2",
    command: ({ editor, range }) =>
      editor.chain().focus().deleteRange(range).setHeading({ level: 2 }).run(),
  },
  {
    title: "Heading 3",
    description: "Small section heading",
    icon: "H3",
    command: ({ editor, range }) =>
      editor.chain().focus().deleteRange(range).setHeading({ level: 3 }).run(),
  },
  {
    title: "Bullet List",
    description: "Unordered list",
    icon: "•",
    command: ({ editor, range }) =>
      editor.chain().focus().deleteRange(range).toggleBulletList().run(),
  },
  {
    title: "Numbered List",
    description: "Ordered list",
    icon: "1.",
    command: ({ editor, range }) =>
      editor.chain().focus().deleteRange(range).toggleOrderedList().run(),
  },
  {
    title: "Task List",
    description: "Checkbox task list",
    icon: "☑",
    command: ({ editor, range }) =>
      editor.chain().focus().deleteRange(range).toggleTaskList().run(),
  },
  {
    title: "Quote",
    description: "Block quotation",
    icon: '"',
    command: ({ editor, range }) =>
      editor.chain().focus().deleteRange(range).toggleBlockquote().run(),
  },
  {
    title: "Code Block",
    description: "Code with syntax highlighting",
    icon: "</>",
    command: ({ editor, range }) =>
      editor.chain().focus().deleteRange(range).toggleCodeBlock().run(),
  },
  {
    title: "Divider",
    description: "Horizontal rule",
    icon: "—",
    command: ({ editor, range }) =>
      editor.chain().focus().deleteRange(range).setHorizontalRule().run(),
  },
];

// ---------------------------------------------------------------------------
// Popup component
// ---------------------------------------------------------------------------

interface CommandListHandle {
  onKeyDown: (props: SuggestionKeyDownProps) => boolean;
}

interface CommandListProps {
  items: SlashCommand[];
  command: (item: SlashCommand) => void;
}

const CommandList = forwardRef<CommandListHandle, CommandListProps>(
  function CommandList({ items, command }, ref) {
    const [selectedIndex, setSelectedIndex] = useState(0);

    useEffect(() => {
      setSelectedIndex(0);
    }, [items]);

    useImperativeHandle(ref, () => ({
      onKeyDown({ event }: SuggestionKeyDownProps) {
        if (event.key === "ArrowUp") {
          setSelectedIndex((i) => (i - 1 + items.length) % items.length);
          return true;
        }
        if (event.key === "ArrowDown") {
          setSelectedIndex((i) => (i + 1) % items.length);
          return true;
        }
        if (event.key === "Enter") {
          const item = items[selectedIndex];
          if (item) command(item);
          return true;
        }
        return false;
      },
    }));

    if (items.length === 0) return null;

    return (
      <div className="slash-command-list">
        {items.map((item, index) => (
          <button
            key={item.title}
            className={`slash-command-item${index === selectedIndex ? " active" : ""}`}
            onClick={() => command(item)}
            onMouseEnter={() => setSelectedIndex(index)}
          >
            <span className="slash-command-icon">{item.icon}</span>
            <span className="slash-command-info">
              <span className="slash-command-title">{item.title}</span>
              <span className="slash-command-desc">{item.description}</span>
            </span>
          </button>
        ))}
      </div>
    );
  },
);

// ---------------------------------------------------------------------------
// Suggestion renderer factory
// ---------------------------------------------------------------------------

function buildRenderer() {
  let container: HTMLElement | null = null;
  let root: ReturnType<typeof createRoot> | null = null;
  const listRef = createRef<CommandListHandle>();

  function updatePosition(clientRect: (() => DOMRect | null) | undefined) {
    if (!container || !clientRect) return;
    const rect = clientRect();
    if (!rect) return;
    container.style.top = `${rect.bottom + window.scrollY + 4}px`;
    container.style.left = `${rect.left + window.scrollX}px`;
  }

  function render(props: SuggestionProps<SlashCommand>) {
    root?.render(
      <CommandList
        ref={listRef}
        items={props.items}
        command={(item) => props.command(item)}
      />,
    );
  }

  return {
    onStart(props: SuggestionProps<SlashCommand>) {
      container = document.createElement("div");
      container.classList.add("slash-command-popup");
      document.body.appendChild(container);
      root = createRoot(container);
      updatePosition(props.clientRect ?? undefined);
      render(props);
    },

    onUpdate(props: SuggestionProps<SlashCommand>) {
      updatePosition(props.clientRect ?? undefined);
      render(props);
    },

    onKeyDown(props: SuggestionKeyDownProps) {
      if (props.event.key === "Escape") {
        if (container) container.style.display = "none";
        return true;
      }
      return listRef.current?.onKeyDown(props) ?? false;
    },

    onExit() {
      root?.unmount();
      container?.remove();
      root = null;
      container = null;
    },
  };
}

// ---------------------------------------------------------------------------
// Tiptap Extension
// ---------------------------------------------------------------------------

export const SlashCommandExtension = Extension.create({
  name: "slashCommand",

  addProseMirrorPlugins() {
    return [
      Suggestion<SlashCommand>({
        editor: this.editor,
        char: "/",
        command({ editor, range, props }) {
          props.command({ editor, range });
        },
        items({ query }: { query: string }) {
          const q = query.toLowerCase();
          return COMMANDS.filter(
            (c) =>
              c.title.toLowerCase().includes(q) ||
              c.description.toLowerCase().includes(q),
          );
        },
        render: buildRenderer,
      }),
    ];
  },
});
