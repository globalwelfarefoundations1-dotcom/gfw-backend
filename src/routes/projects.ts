import { randomUUID } from "node:crypto";
import type { FastifyBaseLogger, FastifyInstance, FastifyRequest } from "fastify";
import type { MultipartFile } from "@fastify/multipart";
import { supabase } from "../config/supabase.js";
import { authenticate } from "../plugins/authenticate.js";
import { uploadToStorage, removeFromStorage, getPublicUrl } from "../config/storage.js";

const TABLE = "project";

const MAX_IMAGE_BYTES = 15 * 1024 * 1024;
const MAX_VIDEO_BYTES = 50 * 1024 * 1024;
const MAX_IMAGES = 20;
const ALLOWED_IMAGE_MIME = new Set(["image/png", "image/jpeg", "image/jpg", "image/svg+xml"]);
const ALLOWED_VIDEO_MIME = new Set(["video/mp4", "video/webm"]);

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

interface ParsedForm {
  fields: Record<string, string>;
  coverImage?: { buffer: Buffer; filename: string; mimetype: string };
  projectImages: { buffer: Buffer; filename: string; mimetype: string }[];
  projectVideos: { buffer: Buffer; filename: string; mimetype: string }[];
}

function splitCsv(value: string | null): string[] {
  if (!value) return [];
  return value
    .split(",")
    .map((v) => v.trim())
    .filter(Boolean);
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
    coverImageUrl: row.coverImage ? getPublicUrl(row.coverImage) : null,
    projectImages: splitCsv(row.projectImage).map(getPublicUrl),
    projectVideos: splitCsv(row.projectVideos).map(getPublicUrl),
    youtubeLinks: splitCsv(row.youtubeLinks),
  };
}

async function parseMultipartForm(request: FastifyRequest): Promise<ParsedForm> {
  const fields: Record<string, string> = {};
  const projectImages: ParsedForm["projectImages"] = [];
  const projectVideos: ParsedForm["projectVideos"] = [];
  let coverImage: ParsedForm["coverImage"];

  for await (const part of request.parts()) {
    if (part.type === "field") {
      fields[part.fieldname] = typeof part.value === "string" ? part.value : "";
      continue;
    }

    const filePart = part as MultipartFile;

    if (!filePart.filename) continue;

    const buffer = await filePart.toBuffer();

    if (filePart.fieldname === "coverImage") {
      if (!ALLOWED_IMAGE_MIME.has(filePart.mimetype)) {
        throw new HttpError(400, "coverImage must be PNG, JPG, or SVG");
      }
      if (buffer.length > MAX_IMAGE_BYTES) {
        throw new HttpError(400, "coverImage exceeds 15MB limit");
      }
      coverImage = { buffer, filename: filePart.filename, mimetype: filePart.mimetype };
    } else if (filePart.fieldname === "projectImages") {
      if (!ALLOWED_IMAGE_MIME.has(filePart.mimetype)) {
        throw new HttpError(400, "projectImages must be PNG or JPG");
      }
      if (buffer.length > MAX_IMAGE_BYTES) {
        throw new HttpError(400, "each project image exceeds 15MB limit");
      }
      if (projectImages.length >= MAX_IMAGES) {
        throw new HttpError(400, `projectImages exceeds the ${MAX_IMAGES} file limit`);
      }
      projectImages.push({ buffer, filename: filePart.filename, mimetype: filePart.mimetype });
    } else if (filePart.fieldname === "projectVideos") {
      if (!ALLOWED_VIDEO_MIME.has(filePart.mimetype)) {
        throw new HttpError(400, "projectVideos must be MP4 or WebM");
      }
      if (buffer.length > MAX_VIDEO_BYTES) {
        throw new HttpError(400, "each project video exceeds 50MB limit");
      }
      projectVideos.push({ buffer, filename: filePart.filename, mimetype: filePart.mimetype });
    }
  }

  return { fields, coverImage, projectImages, projectVideos };
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

async function uploadMany(
  projectId: string,
  folder: string,
  files: ParsedForm["projectImages"]
): Promise<string[]> {
  const paths: string[] = [];

  for (const file of files) {
    const path = `projects/${projectId}/${folder}/${randomUUID()}-${file.filename}`;
    await uploadToStorage(path, file.buffer, file.mimetype);
    paths.push(path);
  }

  return paths;
}

export default async function projectRoutes(server: FastifyInstance) {
  server.get("/api/projects", async (request, reply) => {
    const query = request.query as Record<string, string | undefined>;
    const offset = Number(query.offset ?? 0);
    const limit = Math.min(Number(query.limit ?? 10), 100);
    const search = query.search;
    const status = query.status;
    const categoryId = query.categoryId;

    let dbQuery = supabase.from(TABLE).select("*", { count: "exact" });

    if (search) {
      dbQuery = dbQuery.or(`projectName.ilike.%${search}%,company.ilike.%${search}%`);
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
  });

  server.get("/api/projects/:id", async (request, reply) => {
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
  });

  server.post("/api/projects", { preHandler: authenticate }, async (request, reply) => {
    let uploadedPaths: string[] = [];

    try {
      const form = await parseMultipartForm(request);
      const { fields } = form;

      if (!fields.projectName) {
        return reply.code(400).send({ error: "projectName is required" });
      }

      const category = await resolveCategory(fields.categoryId);
      const projectId = randomUUID();

      let coverImagePath: string | null = null;
      if (form.coverImage) {
        coverImagePath = `projects/${projectId}/cover/${randomUUID()}-${form.coverImage.filename}`;
        await uploadToStorage(coverImagePath, form.coverImage.buffer, form.coverImage.mimetype);
        uploadedPaths.push(coverImagePath);
      }

      const imagePaths = await uploadMany(projectId, "images", form.projectImages);
      uploadedPaths.push(...imagePaths);

      const videoPaths = await uploadMany(projectId, "videos", form.projectVideos);
      uploadedPaths.push(...videoPaths);

      const { data, error } = await supabase
        .from(TABLE)
        .insert({
          id: projectId,
          updatedAt: new Date().toISOString(),
          projectName: fields.projectName,
          description: fields.description ?? null,
          category: category ?? {},
          "Project date": fields.projectDate ?? null,
          company: fields.company ?? null,
          projectUrl: fields.projectUrl ?? null,
          services: fields.services ?? null,
          status: fields.status ?? "Draft",
          coverImage: coverImagePath,
          projectImage: imagePaths.join(",") || null,
          projectVideos: videoPaths.join(",") || null,
          youtubeLinks: fields.youtubeLinks ?? null,
        })
        .select("*")
        .single<ProjectRow>();

      if (error) {
        await removeFromStorage(uploadedPaths);
        request.log.error(error);
        return reply.code(500).send({ error: "Failed to create project" });
      }

      if (category) {
        await syncCategoryProjectCount(category.id, request.log);
      }

      return reply.code(201).send(serializeProject(data));
    } catch (err) {
      await removeFromStorage(uploadedPaths);
      if (err instanceof HttpError) {
        return reply.code(err.statusCode).send({ error: err.message });
      }
      request.log.error(err);
      return reply.code(500).send({ error: "Failed to create project" });
    }
  });

  server.put("/api/projects/:id", { preHandler: authenticate }, async (request, reply) => {
    const { id } = request.params as { id: string };
    let newlyUploadedPaths: string[] = [];

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

      const form = await parseMultipartForm(request);
      const { fields } = form;

      const update: Record<string, unknown> = {};

      if (fields.projectName !== undefined) update.projectName = fields.projectName;
      if (fields.description !== undefined) update.description = fields.description;
      if (fields.projectDate !== undefined) update["Project date"] = fields.projectDate;
      if (fields.company !== undefined) update.company = fields.company;
      if (fields.projectUrl !== undefined) update.projectUrl = fields.projectUrl;
      if (fields.services !== undefined) update.services = fields.services;
      if (fields.status !== undefined) update.status = fields.status;
      if (fields.youtubeLinks !== undefined) update.youtubeLinks = fields.youtubeLinks;

      if (fields.categoryId !== undefined) {
        update.category = await resolveCategory(fields.categoryId);
      }

      // Server-controlled: always set on edit, never taken from the request payload.
      update.updatedAt = new Date().toISOString();

      const oldPathsToRemove: string[] = [];

      if (form.coverImage) {
        const newPath = `projects/${id}/cover/${randomUUID()}-${form.coverImage.filename}`;
        await uploadToStorage(newPath, form.coverImage.buffer, form.coverImage.mimetype);
        newlyUploadedPaths.push(newPath);
        if (existing.coverImage) oldPathsToRemove.push(existing.coverImage);
        update.coverImage = newPath;
      }

      if (form.projectImages.length > 0) {
        const newPaths = await uploadMany(id, "images", form.projectImages);
        newlyUploadedPaths.push(...newPaths);
        oldPathsToRemove.push(...splitCsv(existing.projectImage));
        update.projectImage = newPaths.join(",");
      }

      if (form.projectVideos.length > 0) {
        const newPaths = await uploadMany(id, "videos", form.projectVideos);
        newlyUploadedPaths.push(...newPaths);
        oldPathsToRemove.push(...splitCsv(existing.projectVideos));
        update.projectVideos = newPaths.join(",");
      }

      const { data, error } = await supabase
        .from(TABLE)
        .update(update)
        .eq("id", id)
        .select("*")
        .single<ProjectRow>();

      if (error) {
        await removeFromStorage(newlyUploadedPaths);
        request.log.error(error);
        return reply.code(500).send({ error: "Failed to update project" });
      }

      if (oldPathsToRemove.length > 0) {
        await removeFromStorage(oldPathsToRemove);
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
      await removeFromStorage(newlyUploadedPaths);
      if (err instanceof HttpError) {
        return reply.code(err.statusCode).send({ error: err.message });
      }
      request.log.error(err);
      return reply.code(500).send({ error: "Failed to update project" });
    }
  });

  server.delete("/api/projects/:id", { preHandler: authenticate }, async (request, reply) => {
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
      ...(existing.coverImage ? [existing.coverImage] : []),
      ...splitCsv(existing.projectImage),
      ...splitCsv(existing.projectVideos),
    ];

    if (pathsToRemove.length > 0) {
      await removeFromStorage(pathsToRemove);
    }

    const existingCategoryId = categoryIdOf(existing.category);
    if (existingCategoryId) {
      await syncCategoryProjectCount(existingCategoryId, request.log);
    }

    return reply.code(204).send();
  });
}
