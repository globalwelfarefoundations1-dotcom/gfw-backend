import type { FastifyInstance } from "fastify";
import bcrypt from "bcryptjs";
import { supabase } from "../config/supabase.js";
import { signAccessToken, signRefreshToken, verifyRefreshToken } from "../utils/jwt.js";
import { authenticate } from "../plugins/authenticate.js";

interface AdminUserRow {
  id: number;
  created_at: string;
  fullName: string;
  email: string;
  mobileCode: string;
  mobileNumber: string;
  status: string;
  password: string;
  
}

interface LoginBody {
  email: string;
  password: string;
}

interface RefreshBody {
  refreshToken: string;
}

interface UpdateProfileBody {
  fullName?: string;
  email?: string;
  mobileCode?: string;
  mobileNumber?: string;
  currentPassword?: string;
  newPassword?: string;
}

const errorResponseSchema = {
  type: "object",
  properties: { error: { type: "string" } },
} as const;

export default async function authRoutes(server: FastifyInstance) {
  server.post<{ Body: LoginBody }>(
    "/api/auth/login",
    {
      schema: {
        tags: ["Auth"],
        body: {
          type: "object",
          required: ["email", "password"],
          properties: {
            email: { type: "string" },
            password: { type: "string" },
          },
        },
        response: {
          200: {
            type: "object",
            properties: {
              accessToken: { type: "string" },
              refreshToken: { type: "string" },
            },
          },
          401: errorResponseSchema,
          403: errorResponseSchema,
          500: errorResponseSchema,
        },
      },
    },
    async (request, reply) => {
      const { email, password } = request.body;

      const { data: user, error } = await supabase
        .from("admin-users")
        .select("*")
        .eq("email", email)
        .maybeSingle<AdminUserRow>();

      if (error) {
        request.log.error(error);
        return reply.code(500).send({ error: "Failed to look up user" });
      }

      if (!user || !user.password) {
        return reply.code(401).send({ error: "Invalid email or password" });
      }

      if (user.status !== "active") {
        return reply.code(403).send({ error: "Account is not active" });
      }

      const passwordMatches = await bcrypt.compare(password, user.password);

      if (!passwordMatches) {
        return reply.code(401).send({ error: "Invalid email or password" });
      }

      const payload = { id: user.id, email: user.email };

      return reply.send({
        accessToken: signAccessToken(payload),
        refreshToken: signRefreshToken(payload),
      });
    }
  );

  server.post<{ Body: RefreshBody }>(
    "/api/auth/refresh",
    {
      schema: {
        tags: ["Auth"],
        body: {
          type: "object",
          required: ["refreshToken"],
          properties: {
            refreshToken: { type: "string" },
          },
        },
        response: {
          200: {
            type: "object",
            properties: { accessToken: { type: "string" } },
          },
          401: errorResponseSchema,
        },
      },
    },
    async (request, reply) => {
      const { refreshToken } = request.body;

      try {
        const payload = verifyRefreshToken(refreshToken);
        return reply.send({
          accessToken: signAccessToken({ id: payload.id, email: payload.email }),
        });
      } catch {
        return reply.code(401).send({ error: "Invalid or expired refresh token" });
      }
    }
  );

  server.get(
    "/api/auth/profile",
    {
      preHandler: authenticate,
      schema: {
        tags: ["Auth"],
        security: [{ bearerAuth: [] }],
        response: {
          200: {
            type: "object",
            properties: {
              id: { type: "integer" },
              created_at: { type: "string" },
              fullName: { type: "string" },
              email: { type: "string" },
              mobileCode: { type: "string" },
              mobileNumber: { type: "string" },
              status: { type: "string" },
            },
          },
          401: errorResponseSchema,
          404: errorResponseSchema,
          500: errorResponseSchema,
        },
      },
    },
    async (request, reply) => {
      const { data: user, error } = await supabase
        .from("admin-users")
        .select("id, created_at, fullName, email, mobileCode, mobileNumber, status")
        .eq("id", request.user!.id)
        .maybeSingle();

      if (error) {
        request.log.error(error);
        return reply.code(500).send({ error: "Failed to fetch profile" });
      }

      if (!user) {
        return reply.code(404).send({ error: "User not found" });
      }

      return reply.send(user);
    }
  );

  server.put<{ Body: UpdateProfileBody }>(
    "/api/auth/profile",
    {
      preHandler: authenticate,
      schema: {
        tags: ["Auth"],
        security: [{ bearerAuth: [] }],
        body: {
          type: "object",
          properties: {
            fullName: { type: "string", minLength: 1 },
            email: { type: "string" },
            mobileCode: { type: "string" },
            mobileNumber: { type: "string" },
            currentPassword: { type: "string" },
            newPassword: { type: "string", minLength: 6 },
          },
        },
        response: {
          200: {
            type: "object",
            properties: {
              id: { type: "integer" },
              created_at: { type: "string" },
              fullName: { type: "string" },
              email: { type: "string" },
              mobileCode: { type: "string" },
              mobileNumber: { type: "string" },
              status: { type: "string" },
            },
          },
          400: errorResponseSchema,
          401: errorResponseSchema,
          404: errorResponseSchema,
          409: errorResponseSchema,
          500: errorResponseSchema,
        },
      },
    },
    async (request, reply) => {
      const { fullName, email, mobileCode, mobileNumber, currentPassword, newPassword } =
        request.body;

      const update: Record<string, unknown> = {};
      if (fullName !== undefined) update.fullName = fullName;
      if (email !== undefined) update.email = email;
      if (mobileCode !== undefined) update.mobileCode = mobileCode;
      if (mobileNumber !== undefined) update.mobileNumber = mobileNumber;

      if (newPassword !== undefined) {
        if (!currentPassword) {
          return reply.code(400).send({ error: "currentPassword is required to set a new password" });
        }

        const { data: existing, error: fetchError } = await supabase
          .from("admin-users")
          .select("password")
          .eq("id", request.user!.id)
          .maybeSingle<{ password: string }>();

        if (fetchError) {
          request.log.error(fetchError);
          return reply.code(500).send({ error: "Failed to fetch profile" });
        }

        if (!existing) {
          return reply.code(404).send({ error: "User not found" });
        }

        const currentPasswordMatches = await bcrypt.compare(currentPassword, existing.password);
        if (!currentPasswordMatches) {
          return reply.code(401).send({ error: "Current password is incorrect" });
        }

        update.password = await bcrypt.hash(newPassword, 10);
      }

      if (Object.keys(update).length === 0) {
        return reply.code(400).send({ error: "No fields to update" });
      }

      const { data: updated, error } = await supabase
        .from("admin-users")
        .update(update)
        .eq("id", request.user!.id)
        .select("id, created_at, fullName, email, mobileCode, mobileNumber, status")
        .maybeSingle();

      if (error) {
        if (error.code === "23505") {
          return reply.code(409).send({ error: "Email already in use" });
        }
        request.log.error(error);
        return reply.code(500).send({ error: "Failed to update profile" });
      }

      if (!updated) {
        return reply.code(404).send({ error: "User not found" });
      }

      return reply.send(updated);
    }
  );
}
