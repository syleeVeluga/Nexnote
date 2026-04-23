import type { FastifyPluginAsync } from "fastify";
import { eq } from "drizzle-orm";
import bcrypt from "bcrypt";
import { registerSchema, loginSchema, ERROR_CODES } from "@wekiflow/shared";
import { users } from "@wekiflow/db";
import { sendValidationError, isUniqueViolation } from "../../lib/reply-helpers.js";

const SALT_ROUNDS = 12;

const authRoutes: FastifyPluginAsync = async (fastify) => {
  fastify.post("/auth/register", async (request, reply) => {
    const parsed = registerSchema.safeParse(request.body);
    if (!parsed.success) {
      return sendValidationError(reply, parsed.error.issues);
    }

    const { email, password, name } = parsed.data;

    const passwordHash = await bcrypt.hash(password, SALT_ROUNDS);

    let user: { id: string; email: string; name: string };
    try {
      [user] = await fastify.db
        .insert(users)
        .values({ email, passwordHash, name })
        .returning({
          id: users.id,
          email: users.email,
          name: users.name,
        });
    } catch (err) {
      if (isUniqueViolation(err)) {
        return reply.code(409).send({
          error: "A user with this email already exists",
          code: ERROR_CODES.EMAIL_CONFLICT,
        });
      }
      throw err;
    }

    const token = fastify.jwt.sign({ sub: user.id, email: user.email });

    return reply.code(201).send({
      token,
      user: { id: user.id, email: user.email, name: user.name },
    });
  });

  fastify.post("/auth/login", async (request, reply) => {
    const parsed = loginSchema.safeParse(request.body);
    if (!parsed.success) {
      return sendValidationError(reply, parsed.error.issues);
    }

    const { email, password } = parsed.data;

    const [user] = await fastify.db
      .select({
        id: users.id,
        email: users.email,
        name: users.name,
        passwordHash: users.passwordHash,
      })
      .from(users)
      .where(eq(users.email, email))
      .limit(1);

    if (!user) {
      return reply.code(401).send({
        error: "Invalid email or password",
        code: ERROR_CODES.INVALID_CREDENTIALS,
      });
    }

    const valid = await bcrypt.compare(password, user.passwordHash);
    if (!valid) {
      return reply.code(401).send({
        error: "Invalid email or password",
        code: ERROR_CODES.INVALID_CREDENTIALS,
      });
    }

    const token = fastify.jwt.sign({ sub: user.id, email: user.email });

    return reply.code(200).send({
      token,
      user: { id: user.id, email: user.email, name: user.name },
    });
  });

  fastify.get(
    "/auth/me",
    { onRequest: [fastify.authenticate] },
    async (request, reply) => {
      const { sub } = request.user;

      const [user] = await fastify.db
        .select({
          id: users.id,
          email: users.email,
          name: users.name,
          avatarUrl: users.avatarUrl,
          createdAt: users.createdAt,
        })
        .from(users)
        .where(eq(users.id, sub))
        .limit(1);

      if (!user) {
        return reply.code(404).send({
          error: "User not found",
          code: ERROR_CODES.USER_NOT_FOUND,
        });
      }

      return reply.code(200).send({ user });
    },
  );
};

export default authRoutes;
