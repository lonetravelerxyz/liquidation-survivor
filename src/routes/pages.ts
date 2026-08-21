// Server-rendered pages + static files. Owned by the frontend; plain HTML files, no template engine.
import { Router, static as serveStatic } from "express";
import { existsSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

// Resolve the views dir relative to this module so it works from src/ (tsx) and dist/ (build copies views).
const here = path.dirname(fileURLToPath(import.meta.url));
export const viewsDir = path.resolve(here, "../views");
// Repo-level assets/ (brand). From src/routes or dist/routes the repo root is two levels up.
const assetsCandidates = [path.resolve(here, "../../assets"), path.resolve(process.cwd(), "assets")];
export const assetsDir = assetsCandidates.find((p) => existsSync(p)) ?? assetsCandidates[0];

const page = (file: string) => path.join(viewsDir, file);
const htmlHeaders = { "Cache-Control": "no-cache", "Content-Type": "text/html; charset=utf-8" };

export const pagesRouter = Router();

pagesRouter.get("/", (_req, res) => {
  res.set(htmlHeaders).sendFile(page("app.html"));
});

pagesRouter.get("/board", (_req, res) => {
  res.set(htmlHeaders).sendFile(page("board.html"));
});

pagesRouter.get("/favicon.ico", (_req, res) => {
  res.set("Cache-Control", "public, max-age=86400").sendFile(path.join(assetsDir, "favicon.ico"));
});

// Brand assets (SVGs, fonts, PNG exports) — long cache.
pagesRouter.use(
  "/static/assets",
  serveStatic(assetsDir, {
    index: false,
    setHeaders: (res) => res.set("Cache-Control", "public, max-age=604800"),
  }),
);

// Views: JS/CSS change often — short cache, revalidate.
pagesRouter.use(
  "/static",
  serveStatic(viewsDir, {
    index: false,
    setHeaders: (res, filePath) => {
      if (filePath.endsWith(".html")) res.set("Cache-Control", "no-cache");
      else res.set("Cache-Control", "public, max-age=300, must-revalidate");
    },
  }),
);
