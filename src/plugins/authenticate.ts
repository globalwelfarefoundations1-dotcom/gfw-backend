import type { FastifyReply, FastifyRequest } from "fastify";
import { verifyAccessToken, type TokenPayload } from "../utils/jwt.js";

declare module "fastify" {
  interface FastifyRequest {
    user?: TokenPayload;
  }
}

export async function authenticate(request: FastifyRequest, reply: FastifyReply) {
  const authHeader = request.headers.authorization;

  if (!authHeader || !authHeader.startsWith("Bearer ")) {
    return reply.code(401).send({ error: "Missing or invalid Authorization header" });
  }

  const token = authHeader.slice("Bearer ".length);

  try {
    request.user = verifyAccessToken(token);
  } catch {
    return reply.code(401).send({ error: "Invalid or expired access token" });
  }
}
