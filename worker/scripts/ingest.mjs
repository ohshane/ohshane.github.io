#!/usr/bin/env node
// Ingest pipeline: _site/search.json + _site/posts/*.html
//   -> Vectorize (embeddings via Workers AI BGE-M3)
//   -> KV manifest (hash dedup, model marker)
//   -> KV hierarchy edges (parent/child/next/prev within post)
//   -> KV href edges (cross-post explicit links)
//
// Usage:
//   CF_ACCOUNT_ID=... CF_API_TOKEN=... \
//   VECTORIZE_INDEX=chat-index KV_NAMESPACE_ID=... \
//   EMBED_MODEL=@cf/baai/bge-m3 \
//   node worker/scripts/ingest.mjs
//
// Token needs: Workers AI Read, Vectorize Edit, Workers KV Storage Edit.

import { readFile, readdir } from "node:fs/promises";
import { createHash } from "node:crypto";
import { join, basename, dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = resolve(__dirname, "../..");
const SITE_DIR = join(REPO_ROOT, "_site");
const SEARCH_JSON = join(SITE_DIR, "search.json");
const POSTS_DIR = join(SITE_DIR, "posts");

const {
  CF_ACCOUNT_ID,
  CF_API_TOKEN,
  VECTORIZE_INDEX = "chat-index",
  KV_NAMESPACE_ID,
  EMBED_MODEL = "@cf/baai/bge-m3",
} = process.env;

if (!CF_ACCOUNT_ID || !CF_API_TOKEN || !KV_NAMESPACE_ID) {
  console.error("Missing env: CF_ACCOUNT_ID, CF_API_TOKEN, KV_NAMESPACE_ID required.");
  process.exit(1);
}

const API = `https://api.cloudflare.com/client/v4/accounts/${CF_ACCOUNT_ID}`;
const HEADERS = { Authorization: `Bearer ${CF_API_TOKEN}` };

const sha = (s) => createHash("sha256").update(s).digest("hex").slice(0, 16);
const postIdOf = (objectId) => objectId.split("#")[0];
const anchorOf = (objectId) => objectId.split("#")[1] || "";

async function cf(path, init = {}) {
  const res = await fetch(`${API}${path}`, {
    ...init,
    headers: { ...HEADERS, ...(init.headers || {}) },
  });
  if (!res.ok) {
    const body = await res.text();
    throw new Error(`CF ${init.method || "GET"} ${path} ${res.status}: ${body}`);
  }
  const ct = res.headers.get("content-type") || "";
  return ct.includes("application/json") ? res.json() : res.text();
}

async function kvGet(key) {
  try {
    const res = await fetch(`${API}/storage/kv/namespaces/${KV_NAMESPACE_ID}/values/${encodeURIComponent(key)}`, { headers: HEADERS });
    if (res.status === 404) return null;
    if (!res.ok) throw new Error(`KV GET ${key} ${res.status}`);
    return await res.text();
  } catch (e) {
    return null;
  }
}

async function kvPutBulk(entries) {
  if (!entries.length) return;
  for (let i = 0; i < entries.length; i += 100) {
    const chunk = entries.slice(i, i + 100);
    await cf(`/storage/kv/namespaces/${KV_NAMESPACE_ID}/bulk`, {
      method: "PUT",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(chunk.map((e) => ({ key: e.key, value: e.value }))),
    });
  }
}

async function kvDeleteBulk(keys) {
  if (!keys.length) return;
  for (let i = 0; i < keys.length; i += 100) {
    const chunk = keys.slice(i, i + 100);
    await cf(`/storage/kv/namespaces/${KV_NAMESPACE_ID}/bulk/delete`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(chunk),
    });
  }
}

async function embed(texts) {
  // BGE-M3 input cap = 8192 tokens/chunk, batch cap = 60000 tokens.
  // Korean/CJK text averages ~1.2 tokens/char; use 1.5 for safety headroom.
  const MODEL_MAX_TOKENS = 40000;
  const TOKENS_PER_CHAR_EST = 3;
  const out = [];
  let i = 0;
  while (i < texts.length) {
    const batch = [];
    let budget = MODEL_MAX_TOKENS;
    while (i < texts.length) {
      const estTokens = Math.ceil(texts[i].length * TOKENS_PER_CHAR_EST);
      if (batch.length && estTokens > budget) break;
      batch.push(texts[i]);
      budget -= estTokens;
      i++;
      if (batch.length >= 50) break;
    }
    const json = await cf(`/ai/run/${EMBED_MODEL}`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ text: batch }),
    });
    const vecs = json.result?.data || [];
    if (vecs.length !== batch.length) throw new Error(`embed batch mismatch: ${vecs.length} != ${batch.length}`);
    out.push(...vecs);
  }
  return out;
}

async function vectorizeUpsert(records) {
  if (!records.length) return;
  for (let i = 0; i < records.length; i += 1000) {
    const chunk = records.slice(i, i + 1000);
    const ndjson = chunk.map((r) => JSON.stringify(r)).join("\n");
    await cf(`/vectorize/v2/indexes/${VECTORIZE_INDEX}/upsert`, {
      method: "POST",
      headers: { "Content-Type": "application/x-ndjson" },
      body: ndjson,
    });
  }
}

async function vectorizeDelete(ids) {
  if (!ids.length) return;
  for (let i = 0; i < ids.length; i += 1000) {
    const chunk = ids.slice(i, i + 1000);
    await cf(`/vectorize/v2/indexes/${VECTORIZE_INDEX}/delete_by_ids`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ ids: chunk }),
    });
  }
}

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
    if (!h) continue;
    if (/^(mailto:|javascript:|tel:)/i.test(h)) continue;
    if (/^https?:\/\//i.test(h)) {
      if (!h.includes("blog.shaneoh.org") && !h.includes("ohshane.github.io")) continue;
      h = new URL(h).pathname.replace(/^\//, "");
    } else if (h.startsWith("/")) {
      h = h.replace(/^\//, "");
    } else {
      h = join(dirname(postPath), h).replace(/^\.\//, "");
    }
    if (!h.startsWith("posts/")) continue;
    if (!h.endsWith(".html")) continue;
    if (h === postPath) continue;
    hrefs.add(h);
  }
  return [...hrefs];
}

function buildHierarchyEdges(headings, postId) {
  const edges = [];
  const stack = [{ level: 1, id: postId }];
  for (const h of headings) {
    const id = `${postId}#${h.id}`;
    while (stack.length && stack[stack.length - 1].level >= h.level) stack.pop();
    if (stack.length) {
      const parent = stack[stack.length - 1].id;
      edges.push({ src: id, dst: parent, type: "parent" });
      edges.push({ src: parent, dst: id, type: "child" });
    }
    stack.push({ level: h.level, id });
  }
  for (let i = 0; i < headings.length - 1; i++) {
    if (headings[i].level !== headings[i + 1].level) continue;
    const a = `${postId}#${headings[i].id}`;
    const b = `${postId}#${headings[i + 1].id}`;
    edges.push({ src: a, dst: b, type: "next" });
    edges.push({ src: b, dst: a, type: "prev" });
  }
  return edges;
}

function depthFromAnchor(headings, anchor) {
  if (!anchor) return 1;
  const h = headings.find((x) => x.id === anchor);
  return h ? h.level : 2;
}

function parentChunkIdFor(headings, postId, anchor) {
  if (!anchor) return null;
  const idx = headings.findIndex((x) => x.id === anchor);
  if (idx < 0) return null;
  const lvl = headings[idx].level;
  for (let i = idx - 1; i >= 0; i--) {
    if (headings[i].level < lvl) return `${postId}#${headings[i].id}`;
  }
  return postId;
}

async function main() {
  console.log("Reading search.json + post HTML...");
  const searchRaw = JSON.parse(await readFile(SEARCH_JSON, "utf8"));
  // Drop hub pages (index.html "Posts" listing, about.html) — not real content.
  const HUB_PAGES = new Set(["index.html", "about.html"]);
  const search = searchRaw.filter((s) => !HUB_PAGES.has(s.objectID.split("#")[0]));

  const postFiles = (await readdir(POSTS_DIR)).filter((f) => f.endsWith(".html"));
  const htmlByPost = {};
  for (const f of postFiles) {
    htmlByPost[`posts/${f}`] = await readFile(join(POSTS_DIR, f), "utf8");
  }

  const headingsByPost = {};
  const hrefEdges = {};
  const hierEdges = [];
  for (const [postId, html] of Object.entries(htmlByPost)) {
    const headings = parseHeadings(html);
    headingsByPost[postId] = headings;
    hrefEdges[postId] = parseHrefs(html, postId);
    hierEdges.push(...buildHierarchyEdges(headings, postId));
  }

  console.log("Loading manifest...");
  const manifestRaw = await kvGet("manifest");
  const manifest = manifestRaw ? JSON.parse(manifestRaw) : {};

  // Vectorize caps id at 64 bytes; objectID URLs can exceed. Hash to fixed-length id.
  const vecIdOf = (objectID) => `v_${sha(objectID)}`;
  const chunks = search.map((s) => {
    const postId = postIdOf(s.objectID);
    const anchor = anchorOf(s.objectID);
    const headings = headingsByPost[postId] || [];
    const depth = depthFromAnchor(headings, anchor);
    const parentObjectID = parentChunkIdFor(headings, postId, anchor);
    const body = `${s.title}${s.section ? ` > ${s.section}` : ""}\n\n${s.text}`;
    return {
      id: vecIdOf(s.objectID),
      objectID: s.objectID,
      postId,
      title: s.title,
      section: s.section || "",
      href: s.href,
      depth,
      parentChunkId: parentObjectID ? vecIdOf(parentObjectID) : "",
      text: s.text,
      embedInput: body,
      hash: sha(`${EMBED_MODEL}\n${body}`),
    };
  });

  const toEmbed = chunks.filter((c) => manifest[c.id] !== c.hash);
  console.log(`Total chunks: ${chunks.length}. Need re-embed: ${toEmbed.length}.`);

  let records = [];
  if (toEmbed.length) {
    console.log("Embedding...");
    const vecs = await embed(toEmbed.map((c) => c.embedInput));
    records = toEmbed.map((c, i) => ({
      id: c.id,
      values: vecs[i],
      metadata: {
        postId: c.postId,
        title: c.title,
        section: c.section,
        href: c.href,
        depth: c.depth,
        parentChunkId: c.parentChunkId || "",
        text: c.text.slice(0, 1000),
      },
    }));
    console.log(`Upserting ${records.length} vectors...`);
    await vectorizeUpsert(records);
  }

  const currentIds = new Set(chunks.map((c) => c.id));
  const staleIds = Object.keys(manifest).filter((id) => !currentIds.has(id));
  if (staleIds.length) {
    console.log(`Deleting ${staleIds.length} stale vectors...`);
    await vectorizeDelete(staleIds);
  }

  const newManifest = {};
  for (const c of chunks) newManifest[c.id] = c.hash;

  const hierByNode = {};
  for (const e of hierEdges) {
    (hierByNode[e.src] ||= []).push({ dst: e.dst, type: e.type });
  }

  // Graph snapshot uses objectIDs as node ids (hier/href edges reference objectIDs).
  // Vec ids (c.id) are only for Vectorize storage and live in metadata.parentChunkId.
  const nodes = chunks.map((c) => ({
    id: c.objectID,
    postId: c.postId,
    title: c.title,
    section: c.section,
    href: c.href,
    depth: c.depth,
  }));
  // Add nodes for every heading in every post (Quarto's search.json skips short sections,
  // so hier edges can point to anchors that have no chunk → renders as floating singletons).
  const existingIds = new Set(nodes.map((n) => n.id));
  for (const [postId, headings] of Object.entries(headingsByPost)) {
    const postTitle = nodes.find((n) => n.id === postId)?.title || postId;
    for (const h of headings) {
      const id = `${postId}#${h.id}`;
      if (existingIds.has(id)) continue;
      existingIds.add(id);
      nodes.push({
        id,
        postId,
        title: postTitle,
        section: h.title,
        href: id,
        depth: h.level,
      });
    }
  }

  const edges = [];
  for (const [chunkId, list] of Object.entries(hierByNode)) {
    for (const e of list) {
      if (e.type === "child") {
        edges.push({ src: chunkId, dst: e.dst, type: e.type });
      }
    }
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
  for (const [postId, neighbors] of Object.entries(hrefEdges)) {
    for (const dst of neighbors) {
      edges.push({ src: postId, dst, type: "href" });
    }
  }

  const snapshot = {
    builtAt: new Date().toISOString(),
    embedModel: EMBED_MODEL,
    nodes,
    edges,
  };

  console.log("Writing KV (manifest + edges + snapshot)...");
  const kvEntries = [
    { key: "manifest", value: JSON.stringify(newManifest) },
    { key: "graph:snapshot", value: JSON.stringify(snapshot) },
    ...Object.entries(hrefEdges).map(([postId, neighbors]) => ({
      key: `edges:href:${postId}`,
      value: JSON.stringify(neighbors),
    })),
    ...Object.entries(hierByNode).map(([chunkId, edges]) => ({
      key: `edges:hier:${chunkId}`,
      value: JSON.stringify(edges),
    })),
  ];
  await kvPutBulk(kvEntries);

  const oldHierKeys = manifestRaw ? Object.keys(JSON.parse(manifestRaw)) : [];
  const newHierKeys = new Set(Object.keys(hierByNode));
  const staleHier = oldHierKeys
    .filter((id) => !newHierKeys.has(id) && !currentIds.has(id))
    .map((id) => `edges:hier:${id}`);
  if (staleHier.length) await kvDeleteBulk(staleHier);

  console.log("Done.");
  console.log(`  chunks=${chunks.length} embedded=${toEmbed.length} stale=${staleIds.length}`);
  console.log(`  hrefEdges=${Object.values(hrefEdges).reduce((a, b) => a + b.length, 0)}`);
  console.log(`  hierEdges=${hierEdges.length}`);
  console.log(`  snapshot nodes=${nodes.length} edges=${edges.length}`);
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
