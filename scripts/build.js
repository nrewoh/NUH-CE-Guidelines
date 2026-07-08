// scripts/build.js
//
// 1. Reads every .pdf in /pdfs
// 2. Extracts title (PDF metadata, falling back to filename) + full text
// 3. Builds a Lunr.js search index (title + text, title boosted)
// 4. Writes dist/data/search-index.json (the index) and dist/data/documents.json
//    (id, title, filename, path, preview snippet, page count)
// 5. Copies index.html, style.css, app.js, and the pdfs/ folder into dist/
//
// Run with: npm run build

import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import lunr from "lunr";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(__dirname, "..");
const PDFS_DIR = path.join(ROOT, "pdfs");
const DIST_DIR = path.join(ROOT, "dist");

// pdfjs-dist legacy build works in Node without a DOM, as long as we only
// extract text (no rendering to canvas).
const { getDocument } = await import("pdfjs-dist/legacy/build/pdf.mjs");

function titleFromFilename(filename) {
  return path
    .basename(filename, path.extname(filename))
    .replace(/[-_]+/g, " ")
    .replace(/\s+/g, " ")
    .trim()
    .replace(/\b\w/g, (c) => c.toUpperCase());
}

function collapseWhitespace(str) {
  return str.replace(/\s+/g, " ").trim();
}

async function extractPdf(filePath) {
  const data = new Uint8Array(fs.readFileSync(filePath));
  const doc = await getDocument({
    data,
    useSystemFonts: true,
    isEvalSupported: false,
  }).promise;

  let title = null;
  try {
    const meta = await doc.getMetadata();
    if (meta?.info?.Title && meta.info.Title.trim()) {
      title = meta.info.Title.trim();
    }
  } catch {
    // metadata read failed — fall back to filename below
  }

  let text = "";
  for (let i = 1; i <= doc.numPages; i++) {
    const page = await doc.getPage(i);
    const content = await page.getTextContent();
    text += content.items.map((item) => ("str" in item ? item.str : "")).join(" ") + "\n";
  }

  return {
    title: title || titleFromFilename(filePath),
    text: collapseWhitespace(text),
    pageCount: doc.numPages,
  };
}

function copyRecursive(src, dest) {
  if (!fs.existsSync(src)) return;
  const stat = fs.statSync(src);
  if (stat.isDirectory()) {
    fs.mkdirSync(dest, { recursive: true });
    for (const entry of fs.readdirSync(src)) {
      copyRecursive(path.join(src, entry), path.join(dest, entry));
    }
  } else {
    fs.mkdirSync(path.dirname(dest), { recursive: true });
    fs.copyFileSync(src, dest);
  }
}

async function main() {
  if (!fs.existsSync(PDFS_DIR)) {
    console.error(`No pdfs/ directory found at ${PDFS_DIR}`);
    process.exit(1);
  }

  const files = fs
    .readdirSync(PDFS_DIR)
    .filter((f) => f.toLowerCase().endsWith(".pdf"))
    .sort();

  if (files.length === 0) {
    console.warn("No PDF files found in pdfs/. Building an empty index.");
  }

  const documents = [];

  for (let i = 0; i < files.length; i++) {
    const filename = files[i];
    const filePath = path.join(PDFS_DIR, filename);
    process.stdout.write(`Processing ${filename} ... `);
    try {
      const { title, text, pageCount } = await extractPdf(filePath);
      documents.push({
        id: String(i),
        title,
        filename,
        path: `pdfs/${encodeURIComponent(filename)}`,
        pageCount,
        preview: text.slice(0, 260),
        text,
      });
      console.log(`ok (${pageCount} pages, "${title}")`);
    } catch (err) {
      console.log("FAILED");
      console.error(`  Error extracting ${filename}:`, err.message);
      // Still list the file (without searchable text) so it's not silently dropped.
      documents.push({
        id: String(i),
        title: titleFromFilename(filename),
        filename,
        path: `pdfs/${encodeURIComponent(filename)}`,
        pageCount: null,
        preview: "(Could not extract text from this PDF.)",
        text: "",
      });
    }
  }

  // Sort alphabetically by title for the sidebar listing.
  documents.sort((a, b) => a.title.localeCompare(b.title));
  documents.forEach((d, i) => (d.id = String(i)));

  // Build the Lunr index (title boosted over body text).
  const idx = lunr(function () {
    this.ref("id");
    this.field("title", { boost: 10 });
    this.field("text");
    this.metadataWhitelist = ["position"];
    documents.forEach((doc) => this.add(doc));
  });

  // Strip full text before writing documents.json — keep it lean, it's not
  // needed client-side (the Lunr index already has the searchable content).
  const documentsForClient = documents.map(({ text, ...rest }) => rest);

  fs.rmSync(DIST_DIR, { recursive: true, force: true });
  fs.mkdirSync(path.join(DIST_DIR, "data"), { recursive: true });

  fs.writeFileSync(
    path.join(DIST_DIR, "data", "search-index.json"),
    JSON.stringify(idx)
  );
  fs.writeFileSync(
    path.join(DIST_DIR, "data", "documents.json"),
    JSON.stringify(documentsForClient)
  );

  // Copy static frontend assets + the actual PDFs into dist/.
  for (const file of ["index.html", "style.css", "app.js"]) {
    copyRecursive(path.join(ROOT, file), path.join(DIST_DIR, file));
  }
  copyRecursive(PDFS_DIR, path.join(DIST_DIR, "pdfs"));

  console.log(`\nBuilt ${documents.length} document(s) into dist/`);
}

main();
