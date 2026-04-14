import { z } from "zod";

export const registerSchema = z.object({
  email: z.string().email().max(255),
  password: z.string().min(8).max(128),
  name: z.string().min(1).max(200),
});

export const loginSchema = z.object({
  email: z.string().email(),
  password: z.string(),
});

export const authTokenPayload = z.object({
  sub: z.string().uuid(),
  email: z.string().email(),
});

export type Register = z.infer<typeof registerSchema>;
export type Login = z.infer<typeof loginSchema>;
export type AuthTokenPayload = z.infer<typeof authTokenPayload>;
