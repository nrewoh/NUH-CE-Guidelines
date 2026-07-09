// scripts/build.js
//
// 1. Reads every .pdf in /pdfs, recursively — PDFs directly inside a
//    subfolder of pdfs/ (e.g. "pdfs/A) Triage/foo.pdf") are grouped in the
//    sidebar under that folder name as a category. PDFs sitting directly in
//    pdfs/ (no subfolder) are grouped under "Uncategorized".
// 2. Extracts title from the filename (ignoring internal PDF metadata) + full text
// 3. Builds a Lunr.js search index (title + text, title boosted)
// 4. Writes dist/data/search-index.json (the index) and dist/data/documents.json
//    (id, title, filename, path, category, preview snippet, page count)
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
const UNCATEGORIZED = "Uncategorized";

// pdfjs-dist legacy build works in Node without a DOM, as long as we only
// extract text (no rendering to canvas).
const { getDocument } = await import("pdfjs-dist/legacy/build/pdf.mjs");

// OPTION A: Displays the exact file name as written on GitHub (removes only the .pdf)
function titleFromFilename(filename) {
  return path.basename(filename, path.extname(filename));
}

/* // OPTION B: Cleans up names automatically (swaps dashes/underscores with spaces & capitalizes words)
function titleFromFilename(filename) {
  return path
    .basename(filename, path.extname(filename))
    .replace(/[-_]+/g, " ")
    .replace(/\s+/g, " ")
    .trim()
    .replace(/\b\w/g, (c) => c.toUpperCase());
}
*/

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

  // Bypassed internal PDF metadata reading completely to prioritize GitHub filename

  let text = "";
  for (let i = 1; i <= doc.numPages; i++) {
    const page = await doc.getPage(i);
    const content = await page.getTextContent();
    text += content.items.map((item) => ("str" in item ? item.str : "")).join(" ") + "\n";
  }

  return {
    title: titleFromFilename(filePath),
    text: collapseWhitespace(text),
    pageCount: doc.numPages,
  };
}

// Walks pdfs/ and returns [{ absPath, filename, category }]. A PDF's
// category is the name of the immediate subfolder of pdfs/ it lives in
// (only one level deep is treated as a category — nested subfolders beyond
// that are still scanned, but folded into the same top-level category).
function collectPdfs(dir) {
  const results = [];

  function walk(current, category) {
    for (const entry of fs.readdirSync(current, { withFileTypes: true })) {
      const entryPath = path.join(current, entry.name);
      if (entry.isDirectory()) {
        const nextCategory = category === null ? entry.name : category;
        walk(entryPath, nextCategory);
      } else if (entry.isFile() && entry.name.toLowerCase().endsWith(".pdf")) {
        results.push({
          absPath: entryPath,
          filename: entry.name,
          relPath: path.relative(dir, entryPath),
          category: category || UNCATEGORIZED,
        });
      }
    }
  }

  walk(dir, null);
  return results;
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

  const files = collectPdfs(PDFS_DIR).sort((a, b) => a.relPath.localeCompare(b.relPath));

  if (files.length === 0) {
    console.warn("No PDF files found in pdfs/. Building an empty index.");
  }

  const documents = [];

  for (let i = 0; i < files.length; i++) {
    const { absPath, filename, relPath, category } = files[i];
    // Encode each path segment separately so folder/file names with spaces
    // or special characters still resolve as a valid URL.
    const urlPath = `pdfs/${relPath.split(path.sep).map(encodeURIComponent).join("/")}`;
    process.stdout.write(`Processing ${relPath} ... `);
    try {
      const { title, text, pageCount } = await extractPdf(absPath);
      documents.push({
        id: String(i),
        title,
        filename,
        category,
        path: urlPath,
        pageCount,
        preview: text.slice(0, 260),
        text,
      });
      console.log(`ok (${pageCount} pages, "${title}")`);
    } catch (err) {
      console.log("FAILED");
      console.error(`  Error extracting ${relPath}:`, err.message);
      // Still list the file (without searchable text) so it's not silently dropped.
      documents.push({
        id: String(i),
        title: titleFromFilename(filename),
        filename,
        category,
        path: urlPath,
        pageCount: null,
        preview: "(Could not extract text from this PDF.)",
        text: "",
      });
    }
  }

  // Sort by category (alphabetically — name folders "A) ...", "B) ..." etc.
  // to control order), then by title within each category.
  documents.sort((a, b) => a.category.localeCompare(b.category) || a.title.localeCompare(b.title));
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
