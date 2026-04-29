export * from "./users.js";
export * from "./pages.js";
export * from "./revisions.js";
export * from "./published.js";
export * from "./ingestions.js";
export * from "./chunks.js";
export * from "./entities.js";
export * from "./triples.js";
export * from "./predicate-labels.js";
export * from "./agent-runs.js";
export * from "./audit.js";

import * as _users from "./users.js";
import * as _pages from "./pages.js";
import * as _revisions from "./revisions.js";
import * as _published from "./published.js";
import * as _ingestions from "./ingestions.js";
import * as _chunks from "./chunks.js";
import * as _entities from "./entities.js";
import * as _triples from "./triples.js";
import * as _predicateLabels from "./predicate-labels.js";
import * as _agentRuns from "./agent-runs.js";
import * as _audit from "./audit.js";

export const schema = {
  ..._users,
  ..._pages,
  ..._revisions,
  ..._published,
  ..._ingestions,
  ..._chunks,
  ..._entities,
  ..._triples,
  ..._predicateLabels,
  ..._agentRuns,
  ..._audit,
} as const;
