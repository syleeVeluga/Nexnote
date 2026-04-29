export interface ActivitySummaryInput {
  action: string;
  entityType: string;
  afterJson: Record<string, unknown> | null;
  beforeJson: Record<string, unknown> | null;
  revisionNote: string | null;
  changedBlocks: number | null;
}

function readString(value: unknown): string | null {
  return typeof value === "string" && value.trim() ? value : null;
}

export function readNumber(value: unknown): number | null {
  return typeof value === "number" && Number.isFinite(value) ? value : null;
}

function blockCountSummary(action: string, changedBlocks: number): string {
  const verb =
    action === "append"
      ? "Appended"
      : action === "rollback"
        ? "Rollback changed"
        : "Changed";
  return `${verb} ${changedBlocks} block${changedBlocks === 1 ? "" : "s"}`;
}

function agentRunSummary(after: Record<string, unknown> | null): string {
  const sourceName = readString(after?.sourceName);
  const proposedMutations =
    readNumber(after?.proposedMutations) ??
    readNumber(after?.decisionsCount) ??
    0;
  const autoAppliedCount = readNumber(after?.autoAppliedCount) ?? 0;
  const queuedCount = readNumber(after?.queuedCount) ?? 0;
  const mutationLabel =
    proposedMutations === 1 ? "mutation proposed" : "mutations proposed";
  const source = sourceName ? ` for ingestion ${sourceName}` : "";
  return `Agent ran${source} - ${proposedMutations} ${mutationLabel} (${autoAppliedCount} auto-applied, ${queuedCount} queued)`;
}

export function deriveActivitySummary(
  input: ActivitySummaryInput,
): string | null {
  const after = input.afterJson;
  const before = input.beforeJson;
  const explicit =
    readString(after?.summary) ??
    readString(after?.revisionNote) ??
    readString(before?.summary) ??
    input.revisionNote;
  if (explicit) return explicit;

  if (input.action === "agent_run_completed") {
    return agentRunSummary(after);
  }

  if (input.changedBlocks !== null) {
    return blockCountSummary(input.action, input.changedBlocks);
  }

  const source = readString(after?.source) ?? readString(before?.source);
  if (input.entityType === "page" && input.action === "create") {
    if (source === "route_classifier_auto") {
      return "Created from an auto-applied ingestion";
    }
    if (source === "decision_approve") {
      return "Created after reviewer approval";
    }
    const title = readString(after?.title);
    return title ? `Created page "${title}"` : "Created page";
  }

  if (input.entityType === "page" && input.action === "update") {
    if (source === "patch_generator_auto") {
      return "Updated from an auto-applied ingestion";
    }
    if (source === "decision_approve") {
      return "Updated after reviewer approval";
    }
    return "Updated page metadata";
  }

  if (input.entityType === "page" && input.action === "append") {
    return source === "patch_generator_auto"
      ? "Appended content from an auto-applied ingestion"
      : "Appended content";
  }

  if (input.action === "publish") return "Published a live snapshot";
  if (input.action === "unpublish") return "Unpublished live snapshot";
  if (input.action === "rollback") return "Created a rollback revision";
  if (input.action === "reextract_enqueued") {
    return "Queued graph re-extraction after moving the page";
  }
  if (input.entityType === "folder" && input.action === "folder.create") {
    const name = readString(after?.name);
    return name ? `Created folder "${name}"` : "Created folder";
  }
  if (input.entityType === "folder" && input.action === "folder.update") {
    return "Updated folder metadata";
  }
  if (input.entityType === "folder" && input.action === "folder.delete") {
    return "Deleted folder";
  }

  return null;
}
