import { describe, it, expect } from "vitest";
import { roundTrip, normalizeWhitespace } from "./markdown-roundtrip.js";

function expectRoundTrip(input: string) {
  const result = roundTrip(input);
  expect(normalizeWhitespace(result.output)).toBe(normalizeWhitespace(input));
}

describe("Markdown round-trip: inline formatting", () => {
  it("bold text", () => {
    expectRoundTrip("This is **bold** text.");
  });

  it("italic text", () => {
    expectRoundTrip("This is *italic* text.");
  });

  it("strikethrough text", () => {
    expectRoundTrip("This is ~~strikethrough~~ text.");
  });

  it("inline code", () => {
    expectRoundTrip("Use the `console.log` function.");
  });

  it("combined inline formatting", () => {
    expectRoundTrip("This is **bold** and *italic* and `code`.");
  });

  it("link", () => {
    expectRoundTrip("Visit [WekiFlow](https://wekiflow.dev) for more.");
  });
});

describe("Markdown round-trip: headings", () => {
  it("h1", () => {
    expectRoundTrip("# Heading 1");
  });

  it("h2", () => {
    expectRoundTrip("## Heading 2");
  });

  it("h3", () => {
    expectRoundTrip("### Heading 3");
  });

  it("h4", () => {
    expectRoundTrip("#### Heading 4");
  });

  it("multiple headings with content", () => {
    expectRoundTrip(
      `# Title

Some intro text.

## Section One

Content here.

### Subsection

More details.`,
    );
  });
});

describe("Markdown round-trip: lists", () => {
  it("unordered list", () => {
    // tiptap-markdown serializes with `-` not `*`
    expectRoundTrip(
      `- Item one
- Item two
- Item three`,
    );
  });

  it("ordered list", () => {
    expectRoundTrip(
      `1. First
2. Second
3. Third`,
    );
  });

  it("nested unordered list", () => {
    expectRoundTrip(
      `- Parent
  - Child one
  - Child two
- Another parent`,
    );
  });
});

describe("Markdown round-trip: block elements", () => {
  it("blockquote", () => {
    expectRoundTrip("> This is a blockquote.");
  });

  it("nested blockquote", () => {
    expectRoundTrip(
      `> Outer quote
>
> > Inner quote`,
    );
  });

  it("code block with language", () => {
    expectRoundTrip(
      `\`\`\`javascript
function hello() {
  return "world";
}
\`\`\``,
    );
  });

  it("code block without language", () => {
    expectRoundTrip(
      `\`\`\`
plain code block
\`\`\``,
    );
  });

  it("horizontal rule", () => {
    expectRoundTrip(
      `Above the line.

---

Below the line.`,
    );
  });
});

describe("Markdown round-trip: images", () => {
  it("basic image", () => {
    expectRoundTrip("![Alt text](https://example.com/image.png)");
  });
});

describe("Markdown round-trip: bullet style normalization", () => {
  it("normalizes * bullets to - bullets", () => {
    const result = roundTrip(`* Alpha\n* Beta\n* Gamma`);
    expect(normalizeWhitespace(result.output)).toBe(
      normalizeWhitespace(`- Alpha\n- Beta\n- Gamma`),
    );
  });
});

describe("Markdown round-trip: complex documents", () => {
  it("full document with mixed elements", () => {
    expectRoundTrip(
      `# Project README

Welcome to the project. This is **important** documentation.

## Getting Started

1. Clone the repository
2. Run \`npm install\`
3. Start the dev server

## Features

- **Fast** editing experience
- *Collaborative* editing support
- Full ~~HTML~~ Markdown support

## Code Example

\`\`\`typescript
const editor = new Editor({
  extensions: [StarterKit],
});
\`\`\`

> Note: This is still in development.

---

For more info, visit [our docs](https://docs.example.com).`,
    );
  });
});
