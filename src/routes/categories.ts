import type { FastifyInstance } from "fastify";
import { supabase } from "../config/supabase.js";
import { authenticate } from "../plugins/authenticate.js";

interface CategoryRow {
  id: string;
  created_at: string;
  categoryName: string;
  description: string | null;
  status: string;
  projects: number;
}

interface ListQuery {
  offset?: number;
  limit?: number;
  search?: string;
  status?: string;
}

interface CreateBody {
  categoryName: string;
  description?: string;
  status?: string;
}

interface UpdateBody {
  categoryName?: string;
  description?: string;
  status?: string;
}

interface IdParams {
  id: string;
}

const TABLE = "category-master";

const statusEnum = { type: "string", enum: ["active", "inactive"] } as const;

export default async function categoryRoutes(server: FastifyInstance) {
  server.get<{ Querystring: ListQuery }>(
    "/api/categories",
    {
      schema: {
        querystring: {
          type: "object",
          properties: {
            offset: { type: "integer", minimum: 0, default: 0 },
            limit: { type: "integer", minimum: 1, maximum: 100, default: 10 },
            search: { type: "string" },
            status: statusEnum,
          },
        },
      },
    },
    async (request, reply) => {
      const { offset = 0, limit = 10, search, status } = request.query;

      let query = supabase.from(TABLE).select("*", { count: "exact" });

      if (search) {
        query = query.ilike("categoryName", `%${search}%`);
      }

      if (status) {
        query = query.eq("status", status);
      }

      const { data, error, count } = await query
        .order("created_at", { ascending: false })
        .range(offset, offset + limit - 1)
        .returns<CategoryRow[]>();

      if (error) {
        request.log.error(error);
        return reply.code(500).send({ error: "Failed to fetch categories" });
      }

      return reply.send({ data, total: count ?? 0, offset, limit });
    }
  );

  server.get<{ Params: IdParams }>("/api/categories/:id", async (request, reply) => {
    const { data, error } = await supabase
      .from(TABLE)
      .select("*")
      .eq("id", request.params.id)
      .maybeSingle<CategoryRow>();

    if (error) {
      request.log.error(error);
      return reply.code(500).send({ error: "Failed to fetch category" });
    }

    if (!data) {
      return reply.code(404).send({ error: "Category not found" });
    }

    return reply.send(data);
  });

  server.post<{ Body: CreateBody }>(
    "/api/categories",
    {
      preHandler: authenticate,
      schema: {
        body: {
          type: "object",
          required: ["categoryName"],
          properties: {
            categoryName: { type: "string", minLength: 1 },
            description: { type: "string" },
            status: statusEnum,
          },
        },
      },
    },
    async (request, reply) => {
      const { categoryName, description, status = "active" } = request.body;

      const { data, error } = await supabase
        .from(TABLE)
        .insert({ categoryName, description, status })
        .select("*")
        .single<CategoryRow>();

      if (error) {
        request.log.error(error);
        return reply.code(500).send({ error: "Failed to create category" });
      }

      return reply.code(201).send(data);
    }
  );

  server.put<{ Params: IdParams; Body: UpdateBody }>(
    "/api/categories/:id",
    {
      preHandler: authenticate,
      schema: {
        body: {
          type: "object",
          properties: {
            categoryName: { type: "string", minLength: 1 },
            description: { type: "string" },
            status: statusEnum,
          },
        },
      },
    },
    async (request, reply) => {
      const { data, error } = await supabase
        .from(TABLE)
        .update(request.body)
        .eq("id", request.params.id)
        .select("*")
        .maybeSingle<CategoryRow>();

      if (error) {
        request.log.error(error);
        return reply.code(500).send({ error: "Failed to update category" });
      }

      if (!data) {
        return reply.code(404).send({ error: "Category not found" });
      }

      return reply.send(data);
    }
  );

  server.delete<{ Params: IdParams }>(
    "/api/categories/:id",
    { preHandler: authenticate },
    async (request, reply) => {
      const { data, error } = await supabase
        .from(TABLE)
        .delete()
        .eq("id", request.params.id)
        .select("id")
        .maybeSingle();

      if (error) {
        request.log.error(error);
        return reply.code(500).send({ error: "Failed to delete category" });
      }

      if (!data) {
        return reply.code(404).send({ error: "Category not found" });
      }

      return reply.code(204).send();
    }
  );
}
