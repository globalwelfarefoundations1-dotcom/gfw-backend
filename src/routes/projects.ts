import { randomUUID } from "node:crypto";
import type { FastifyBaseLogger, FastifyInstance } from "fastify";
import { supabase } from "../config/supabase.js";
import { authenticate } from "../plugins/authenticate.js";
import { removeFromStorage, getPublicUrl, PROJECT_MEDIA_BUCKET } from "../config/storage.js";

const TABLE = "project";
const MAX_IMAGES = 20;

class HttpError extends Error {
  constructor(public statusCode: number, message: string) {
    super(message);
  }
}

interface CategoryValue {
  id: string;
  categoryName: string;
}

interface ProjectRow {
  id: string;
  created_at: string;
  updatedAt: string | null;
  projectName: string;
  description: string | null;
  category: CategoryValue | Record<string, never>;
  "Project date": string | null;
  company: string | null;
  projectUrl: string | null;
  services: string | null;
  status: string | null;
  coverImage: string | null;
  projectImage: string | null;
  projectVideos: string | null;
  youtubeLinks: string | null;
}

function splitCsv(value: string | null): string[] {
  if (!value) return [];
  return value
    .split(",")
    .map((v) => v.trim())
    .filter(Boolean);
}

function isFullUrl(value: string): boolean {
  return /^https?:\/\//i.test(value);
}

// Media fields store whatever the client sent: a full public URL (current flow,
// where the frontend uploads directly to Supabase Storage) or, for rows created
// before that change, a bare storage path. Resolve either to a usable URL.
function resolveMediaUrl(value: string | null): string | null {
  if (!value) return null;
  return isFullUrl(value) ? value : getPublicUrl(value);
}

// Inverse of the above: needed only when deleting storage objects, which requires
// a path rather than a full URL.
function toStoragePath(value: string): string {
  if (!isFullUrl(value)) return value;
  const marker = `/object/public/${PROJECT_MEDIA_BUCKET}/`;
  const idx = value.indexOf(marker);
  return idx === -1 ? value : value.slice(idx + marker.length);
}

function serializeProject(row: ProjectRow) {
  return {
    id: row.id,
    created_at: row.created_at,
    updatedAt: row.updatedAt,
    projectName: row.projectName,
    description: row.description,
    category: row.category && "id" in row.category ? row.category : null,
    projectDate: row["Project date"],
    company: row.company,
    projectUrl: row.projectUrl,
    services: splitCsv(row.services),
    status: row.status,
    coverImageUrl: resolveMediaUrl(row.coverImage),
    projectImages: splitCsv(row.projectImage).map((v) => resolveMediaUrl(v)!),
    projectVideos: splitCsv(row.projectVideos).map((v) => resolveMediaUrl(v)!),
    youtubeLinks: splitCsv(row.youtubeLinks),
  };
}

async function resolveCategory(categoryId: string | undefined): Promise<CategoryValue | null> {
  if (!categoryId) return null;

  const { data, error } = await supabase
    .from("category-master")
    .select("id, categoryName")
    .eq("id", categoryId)
    .maybeSingle<{ id: string; categoryName: string }>();

  if (error) {
    throw new HttpError(500, "Failed to resolve category");
  }

  if (!data) {
    throw new HttpError(400, "categoryId does not match any category");
  }

  return data;
}

function categoryIdOf(category: CategoryValue | Record<string, never> | null | undefined): string | undefined {
  return category && "id" in category ? category.id : undefined;
}

async function syncCategoryProjectCount(categoryId: string, log: FastifyBaseLogger): Promise<void> {
  try {
    const { count, error: countError } = await supabase
      .from(TABLE)
      .select("id", { count: "exact", head: true })
      .eq("category->>id", categoryId);

    if (countError) throw countError;

    const { error: updateError } = await supabase
      .from("category-master")
      .update({ projects: count ?? 0 })
      .eq("id", categoryId);

    if (updateError) throw updateError;
  } catch (err) {
    log.error(err, `Failed to sync project count for category ${categoryId}`);
  }
}

function escapeOrFilterValue(value: string): string {
  return value.replace(/[\\"]/g, (match) => `\\${match}`);
}

interface ListQuery {
  offset?: number;
  limit?: number;
  search?: string;
  status?: string;
  categoryId?: string;
}

interface ProjectWriteBody {
  projectName?: string;
  description?: string;
  categoryId?: string;
  status?: string;
  company?: string;
  projectUrl?: string;
  projectDate?: string;
  coverImage?: string | null;
  services?: string;
  projectImages?: string[];
  projectVideos?: string[];
  youtubeLinks?: string[];
}

const errorResponseSchema = {
  type: "object",
  properties: { error: { type: "string" } },
} as const;

const idParamsSchema = {
  type: "object",
  required: ["id"],
  properties: { id: { type: "string" } },
} as const;

const projectSchema = {
  type: "object",
  properties: {
    id: { type: "string" },
    created_at: { type: "string" },
    updatedAt: { type: ["string", "null"] },
    projectName: { type: "string" },
    description: { type: ["string", "null"] },
    category: {
      type: ["object", "null"],
      properties: {
        id: { type: "string" },
        categoryName: { type: "string" },
      },
    },
    projectDate: { type: ["string", "null"] },
    company: { type: ["string", "null"] },
    projectUrl: { type: ["string", "null"] },
    services: { type: "array", items: { type: "string" } },
    status: { type: ["string", "null"] },
    coverImageUrl: { type: ["string", "null"] },
    projectImages: { type: "array", items: { type: "string" } },
    projectVideos: { type: "array", items: { type: "string" } },
    youtubeLinks: { type: "array", items: { type: "string" } },
  },
} as const;

// coverImage/projectImages/projectVideos are public URLs the client already
// uploaded to Supabase Storage directly — the backend just stores/returns them.
const projectWriteBodySchema = {
  type: "object",
  properties: {
    projectName: { type: "string", minLength: 1 },
    description: { type: "string" },
    categoryId: { type: "string", description: "Category id to associate with the project" },
    projectDate: { type: "string" },
    company: { type: "string" },
    projectUrl: { type: "string" },
    services: { type: "string", description: "Comma-separated list" },
    status: { type: "string" },
    youtubeLinks: { type: "array", items: { type: "string" } },
    coverImage: { type: ["string", "null"], description: "Public URL of the uploaded cover image" },
    projectImages: {
      type: "array",
      items: { type: "string" },
      maxItems: MAX_IMAGES,
      description: "Public URLs of uploaded project images",
    },
    projectVideos: {
      type: "array",
      items: { type: "string" },
      description: "Public URLs of uploaded project videos",
    },
  },
} as const;

export default async function projectRoutes(server: FastifyInstance) {
  server.get<{ Querystring: ListQuery }>(
    "/api/projects",
    {
      schema: {
        tags: ["Projects"],
        querystring: {
          type: "object",
          properties: {
            offset: { type: "integer", minimum: 0, default: 0 },
            limit: { type: "integer", minimum: 1, maximum: 100, default: 10 },
            search: { type: "string" },
            status: { type: "string" },
            categoryId: { type: "string" },
          },
        },
        response: {
          200: {
            type: "object",
            properties: {
              data: { type: "array", items: projectSchema },
              total: { type: "integer" },
              offset: { type: "integer" },
              limit: { type: "integer" },
            },
          },
          500: errorResponseSchema,
        },
      },
    },
    async (request, reply) => {
      const { offset = 0, limit = 10, search, status, categoryId } = request.query;

      let dbQuery = supabase.from(TABLE).select("*", { count: "exact" });

      if (search) {
        const escaped = escapeOrFilterValue(search);
        dbQuery = dbQuery.or(`projectName.ilike."%${escaped}%",company.ilike."%${escaped}%"`);
      }

      if (status) {
        dbQuery = dbQuery.eq("status", status);
      }

      if (categoryId) {
        dbQuery = dbQuery.eq("category->>id", categoryId);
      }

      const { data, error, count } = await dbQuery
        .order("created_at", { ascending: false })
        .range(offset, offset + limit - 1)
        .returns<ProjectRow[]>();

      if (error) {
        request.log.error(error);
        return reply.code(500).send({ error: "Failed to fetch projects" });
      }

      return reply.send({
        data: data.map(serializeProject),
        total: count ?? 0,
        offset,
        limit,
      });
    }
  );

  server.get(
    "/api/projects/:id",
    {
      schema: {
        tags: ["Projects"],
        params: idParamsSchema,
        response: {
          200: projectSchema,
          404: errorResponseSchema,
          500: errorResponseSchema,
        },
      },
    },
    async (request, reply) => {
      const { id } = request.params as { id: string };

      const { data, error } = await supabase
        .from(TABLE)
        .select("*")
        .eq("id", id)
        .maybeSingle<ProjectRow>();

      if (error) {
        request.log.error(error);
        return reply.code(500).send({ error: "Failed to fetch project" });
      }

      if (!data) {
        return reply.code(404).send({ error: "Project not found" });
      }

      return reply.send(serializeProject(data));
    }
  );

  server.post<{ Body: ProjectWriteBody }>(
    "/api/projects",
    {
      preHandler: authenticate,
      schema: {
        tags: ["Projects"],
        security: [{ bearerAuth: [] }],
        body: {
          ...projectWriteBodySchema,
          required: ["projectName"],
        },
        response: {
          201: projectSchema,
          400: errorResponseSchema,
          500: errorResponseSchema,
        },
      },
    },
    async (request, reply) => {
      const body = request.body;

      try {
        const category = await resolveCategory(body.categoryId);
        const projectId = randomUUID();

        const { data, error } = await supabase
          .from(TABLE)
          .insert({
            id: projectId,
            updatedAt: new Date().toISOString(),
            projectName: body.projectName,
            description: body.description ?? null,
            category: category ?? {},
            "Project date": body.projectDate ?? null,
            company: body.company ?? null,
            projectUrl: body.projectUrl ?? null,
            services: body.services ?? null,
            status: body.status ?? "Draft",
            coverImage: body.coverImage ?? null,
            projectImage: (body.projectImages ?? []).join(",") || null,
            projectVideos: (body.projectVideos ?? []).join(",") || null,
            youtubeLinks: (body.youtubeLinks ?? []).join(",") || null,
          })
          .select("*")
          .single<ProjectRow>();

        if (error) {
          request.log.error(error);
          return reply.code(500).send({ error: "Failed to create project" });
        }

        if (category) {
          await syncCategoryProjectCount(category.id, request.log);
        }

        return reply.code(201).send(serializeProject(data));
      } catch (err) {
        if (err instanceof HttpError) {
          return reply.code(err.statusCode as 400 | 500).send({ error: err.message });
        }
        request.log.error(err);
        return reply.code(500).send({ error: "Failed to create project" });
      }
    }
  );

  server.put<{ Params: { id: string }; Body: ProjectWriteBody }>(
    "/api/projects/:id",
    {
      preHandler: authenticate,
      schema: {
        tags: ["Projects"],
        security: [{ bearerAuth: [] }],
        params: idParamsSchema,
        body: projectWriteBodySchema,
        response: {
          200: projectSchema,
          400: errorResponseSchema,
          404: errorResponseSchema,
          500: errorResponseSchema,
        },
      },
    },
    async (request, reply) => {
      const { id } = request.params;
      const body = request.body;

      try {
        const { data: existing, error: fetchError } = await supabase
          .from(TABLE)
          .select("*")
          .eq("id", id)
          .maybeSingle<ProjectRow>();

        if (fetchError) {
          request.log.error(fetchError);
          return reply.code(500).send({ error: "Failed to fetch project" });
        }

        if (!existing) {
          return reply.code(404).send({ error: "Project not found" });
        }

        const update: Record<string, unknown> = {};

        if (body.projectName !== undefined) update.projectName = body.projectName;
        if (body.description !== undefined) update.description = body.description;
        if (body.projectDate !== undefined) update["Project date"] = body.projectDate;
        if (body.company !== undefined) update.company = body.company;
        if (body.projectUrl !== undefined) update.projectUrl = body.projectUrl;
        if (body.services !== undefined) update.services = body.services;
        if (body.status !== undefined) update.status = body.status;
        if (body.youtubeLinks !== undefined) update.youtubeLinks = body.youtubeLinks.join(",") || null;

        if (body.categoryId !== undefined) {
          update.category = await resolveCategory(body.categoryId);
        }

        const oldPathsToRemove: string[] = [];

        if (body.coverImage !== undefined) {
          if (existing.coverImage) oldPathsToRemove.push(toStoragePath(existing.coverImage));
          update.coverImage = body.coverImage;
        }

        if (body.projectImages !== undefined) {
          oldPathsToRemove.push(...splitCsv(existing.projectImage).map(toStoragePath));
          update.projectImage = body.projectImages.join(",") || null;
        }

        if (body.projectVideos !== undefined) {
          oldPathsToRemove.push(...splitCsv(existing.projectVideos).map(toStoragePath));
          update.projectVideos = body.projectVideos.join(",") || null;
        }

        // Server-controlled: always set on edit, never taken from the request payload.
        update.updatedAt = new Date().toISOString();

        const { data, error } = await supabase
          .from(TABLE)
          .update(update)
          .eq("id", id)
          .select("*")
          .single<ProjectRow>();

        if (error) {
          request.log.error(error);
          return reply.code(500).send({ error: "Failed to update project" });
        }

        if (oldPathsToRemove.length > 0) {
          try {
            await removeFromStorage(oldPathsToRemove);
          } catch (cleanupErr) {
            request.log.error(cleanupErr, "Failed to remove replaced project media from storage");
          }
        }

        const categoryIdsToSync = new Set(
          [categoryIdOf(existing.category), categoryIdOf(data.category)].filter(
            (categoryId): categoryId is string => Boolean(categoryId)
          )
        );

        for (const categoryId of categoryIdsToSync) {
          await syncCategoryProjectCount(categoryId, request.log);
        }

        return reply.send(serializeProject(data));
      } catch (err) {
        if (err instanceof HttpError) {
          return reply.code(err.statusCode as 400 | 404 | 500).send({ error: err.message });
        }
        request.log.error(err);
        return reply.code(500).send({ error: "Failed to update project" });
      }
    }
  );

  server.delete(
    "/api/projects/:id",
    {
      preHandler: authenticate,
      schema: {
        tags: ["Projects"],
        security: [{ bearerAuth: [] }],
        params: idParamsSchema,
        response: {
          204: { type: "null", description: "Project deleted" },
          404: errorResponseSchema,
          500: errorResponseSchema,
        },
      },
    },
    async (request, reply) => {
      const { id } = request.params as { id: string };

      const { data: existing, error: fetchError } = await supabase
        .from(TABLE)
        .select("*")
        .eq("id", id)
        .maybeSingle<ProjectRow>();

      if (fetchError) {
        request.log.error(fetchError);
        return reply.code(500).send({ error: "Failed to fetch project" });
      }

      if (!existing) {
        return reply.code(404).send({ error: "Project not found" });
      }

      const { error } = await supabase.from(TABLE).delete().eq("id", id);

      if (error) {
        request.log.error(error);
        return reply.code(500).send({ error: "Failed to delete project" });
      }

      const pathsToRemove = [
        ...(existing.coverImage ? [toStoragePath(existing.coverImage)] : []),
        ...splitCsv(existing.projectImage).map(toStoragePath),
        ...splitCsv(existing.projectVideos).map(toStoragePath),
      ];

      if (pathsToRemove.length > 0) {
        try {
          await removeFromStorage(pathsToRemove);
        } catch (cleanupErr) {
          request.log.error(cleanupErr, "Failed to remove deleted project media from storage");
        }
      }

      const existingCategoryId = categoryIdOf(existing.category);
      if (existingCategoryId) {
        await syncCategoryProjectCount(existingCategoryId, request.log);
      }

      return reply.code(204).send();
    }
  );
}
