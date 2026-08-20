import "dotenv/config";
import Fastify from "fastify";
import cors from "@fastify/cors";
import swagger from "@fastify/swagger";
import swaggerUi from "@fastify/swagger-ui";
import authRoutes from "./routes/auth.js";
import categoryRoutes from "./routes/categories.js";
import projectRoutes from "./routes/projects.js";


const server = Fastify({ logger: true });

const defaultOrigins = ["http://localhost:5173", "http://127.0.0.1:5173"];
const allowedOrigins = process.env.CORS_ORIGINS
  ? process.env.CORS_ORIGINS.split(",").map((origin) => origin.trim())
  : defaultOrigins;

await server.register(cors, {
  origin: (origin, callback) => {
    if (!origin || allowedOrigins.includes(origin)) {
      callback(null, true);
      return;
    }
    callback(new Error(`Origin ${origin} not allowed by CORS`), false);
  },
  methods: ["GET", "POST", "PUT", "PATCH", "DELETE", "OPTIONS"],
  allowedHeaders: ["Content-Type", "Authorization"],
  credentials: true,
});

await server.register(swagger, {
  openapi: {
    info: {
      title: "Backend API",
      description: "Backend API using Fastify and Supabase",
      version: "1.0.0",
    },
    tags: [
      { name: "Auth", description: "Authentication endpoints" },
      { name: "Categories", description: "Category management" },
      { name: "Projects", description: "Project management" },
    ],
    components: {
      securitySchemes: {
        bearerAuth: {
          type: "http",
          scheme: "bearer",
          bearerFormat: "JWT",
        },
      },
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
