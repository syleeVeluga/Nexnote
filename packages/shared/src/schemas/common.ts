import { z } from "zod";

export const uuidSchema = z.string().uuid();

export const paginationSchema = z.object({
  limit: z.coerce.number().int().min(1).max(100).default(20),
  offset: z.coerce.number().int().min(0).default(0),
});

// Higher cap for tree-shaped resources (pages, folders) where the sidebar
// needs to render the whole hierarchy at once. Don't reuse this for routes
// that return large per-row payloads (model_runs, audit_logs, decisions).
export const treePaginationSchema = z.object({
  limit: z.coerce.number().int().min(1).max(500).default(20),
  offset: z.coerce.number().int().min(0).default(0),
});

export const timestampSchema = z.coerce.date();

export const slugSchema = z
  .string()
  .min(1)
  .max(200)
  .regex(/^[\p{L}\p{N}]+(?:-[\p{L}\p{N}]+)*$/u, "Invalid slug format");
