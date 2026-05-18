#!/usr/bin/env node
// Build graph snapshot from _site/ → worker/public/graph.json
// No embeddings, no Cloudflare API calls. Pure local file read.
// Used as fallback when KV binding is missing (e.g. local dev without RAG).

import { readFile, readdir, writeFile, mkdir, stat } from "node:fs/promises";
import { existsSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = resolve(__dirname, "../..");
const SITE_DIR = join(REPO_ROOT, "_site");
const SEARCH_JSON = join(SITE_DIR, "search.json");
const POSTS_DIR = join(SITE_DIR, "posts");
const OUT_PATH = join(__dirname, "..", "public", "graph.json");

const postIdOf = (objectId) => objectId.split("#")[0];
const anchorOf = (objectId) => objectId.split("#")[1] || "";

function parseHeadings(html) {
  const out = [];
  const reSection = /<section\b(?=[^>]*\bid="([^"]+)")[^>]*\bclass="([^"]*)"[^>]*>\s*<(h[1-6])[^>]*>([\s\S]*?)<\/\3>/gi;
  let m;
  while ((m = reSection.exec(html)) !== null) {
    const id = m[1];
    const classes = m[2];
    const inferred = +m[3][1];
    const levelMatch = classes.match(/\blevel(\d)\b/);
    const level = levelMatch ? +levelMatch[1] : inferred;
    out.push({
      offset: m.index,
      level,
      id,
      title: m[4].replace(/<[^>]+>/g, "").trim(),
    });
  }
  const reH = /<(h[1-6])\b[^>]*\bid="([^"]+)"[^>]*>([\s\S]*?)<\/\1>/gi;
  while ((m = reH.exec(html)) !== null) {
    if (m[2] === "toc-title") continue;
    out.push({
      offset: m.index,
      level: +m[1][1],
      id: m[2],
      title: m[3].replace(/<[^>]+>/g, "").trim(),
    });
  }
  out.sort((a, b) => a.offset - b.offset);
  const seen = new Set();
  return out.filter((h) => {
    if (seen.has(h.id)) return false;
    seen.add(h.id);
    return true;
  });
}

function parseHrefs(html, postPath) {
  const hrefs = new Set();
  const re = /href="([^"#?]+)(?:[#?][^"]*)?"/g;
  let m;
  while ((m = re.exec(html)) !== null) {
    let h = m[1];
    if (!h || /^(mailto:|javascript:|tel:)/i.test(h)) continue;
    if (/^https?:\/\//i.test(h)) {
      if (!h.includes("blog.shaneoh.org") && !h.includes("ohshane.github.io")) continue;
      h = new URL(h).pathname.replace(/^\//, "");
    } else if (h.startsWith("/")) {
      h = h.replace(/^\//, "");
    } else {
      h = join(dirname(postPath), h).replace(/^\.\//, "");
    }
    if (!h.startsWith("posts/") || !h.endsWith(".html")) continue;
    if (h === postPath) continue;
    hrefs.add(h);
  }
  return [...hrefs];
}

function depthFromAnchor(headings, anchor) {
  if (!anchor) return 1;
  const h = headings.find((x) => x.id === anchor);
  return h ? h.level : 2;
}

function buildHierarchyEdges(headings, postId) {
  const edges = [];
  const stack = [{ level: 1, id: postId }];
  for (const h of headings) {
    const id = `${postId}#${h.id}`;
    while (stack.length && stack[stack.length - 1].level >= h.level) stack.pop();
    if (stack.length) {
      edges.push({ src: stack[stack.length - 1].id, dst: id, type: "child" });
    }
    stack.push({ level: h.level, id });
  }
  for (let i = 0; i < headings.length - 1; i++) {
    if (headings[i].level !== headings[i + 1].level) continue;
    edges.push({
      src: `${postId}#${headings[i].id}`,
      dst: `${postId}#${headings[i + 1].id}`,
      type: "next",
    });
  }
  return edges;
}

async function main() {
  if (!existsSync(SEARCH_JSON)) {
    console.warn(`[build-graph] _site/search.json missing. Run \`quarto render\` first. Skipping.`);
    return;
  }
  const search = JSON.parse(await readFile(SEARCH_JSON, "utf8"));
  const postFiles = (await readdir(POSTS_DIR)).filter((f) => f.endsWith(".html"));

  const headingsByPost = {};
  const hrefEdgesByPost = {};
  for (const f of postFiles) {
    const postId = `posts/${f}`;
    const html = await readFile(join(POSTS_DIR, f), "utf8");
    headingsByPost[postId] = parseHeadings(html);
    hrefEdgesByPost[postId] = parseHrefs(html, postId);
  }

  const nodes = search
    .filter((s) => postIdOf(s.objectID).startsWith("posts/"))
    .map((s) => {
      const postId = postIdOf(s.objectID);
      const anchor = anchorOf(s.objectID);
      const headings = headingsByPost[postId] || [];
      return {
        id: s.objectID,
        postId,
        title: s.title,
        section: s.section || "",
        href: s.href,
        depth: depthFromAnchor(headings, anchor),
      };
    });

  const edges = [];
  for (const [postId, headings] of Object.entries(headingsByPost)) {
    edges.push(...buildHierarchyEdges(headings, postId));
  }
  const childTargets = new Set(
    edges.filter((e) => e.type === "child").map((e) => e.dst),
  );
  for (const n of nodes) {
    if (!n.id.includes("#")) continue;
    if (childTargets.has(n.id)) continue;
    edges.push({ src: n.postId, dst: n.id, type: "child" });
    childTargets.add(n.id);
  }
  for (const [postId, neighbors] of Object.entries(hrefEdgesByPost)) {
    for (const dst of neighbors) edges.push({ src: postId, dst, type: "href" });
  }

  const snapshot = {
    builtAt: new Date().toISOString(),
    source: "build-graph (no embeddings)",
    nodes,
    edges,
  };

  await mkdir(dirname(OUT_PATH), { recursive: true });
  await writeFile(OUT_PATH, JSON.stringify(snapshot));
  console.log(`[build-graph] wrote ${OUT_PATH} (nodes=${nodes.length} edges=${edges.length})`);
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
