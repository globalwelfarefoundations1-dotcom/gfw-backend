import "dotenv/config";
import Fastify from "fastify";
import swagger from "@fastify/swagger";
import swaggerUi from "@fastify/swagger-ui";
import multipart from "@fastify/multipart";
import authRoutes from "./routes/auth.js";
import categoryRoutes from "./routes/categories.js";
import projectRoutes from "./routes/projects.js";

const server = Fastify({ logger: true });

await server.register(multipart, {
  limits: { fileSize: 50 * 1024 * 1024 },
});

await server.register(swagger, {
  openapi: {
    info: {
      title: "Backend API",
      description: "Backend API using Fastify and Supabase",
      version: "1.0.0",
    },
  },
});

await server.register(swaggerUi, {
  routePrefix: "/docs",
});

await server.register(authRoutes);
await server.register(categoryRoutes);
await server.register(projectRoutes);

const port = Number(process.env.PORT) || 3000;

try {
  await server.listen({ port, host: "0.0.0.0" });
} catch (err) {
  server.log.error(err);
  process.exit(1);
}
