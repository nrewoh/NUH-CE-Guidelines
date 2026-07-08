# PDF Library

A static site for browsing a collection of PDFs on GitHub Pages, with a
sidebar directory and full-text search (titles + content inside the PDFs).

How it works:
- You drop `.pdf` files into `pdfs/`.
- A build script (`scripts/build.js`) extracts each PDF's title and text,
  and builds a [Lunr.js](https://lunrjs.com/) search index.
- A GitHub Action runs that build on every push and deploys the result to
  GitHub Pages — no manual build step needed once it's set up.
- The frontend (`index.html` / `app.js`) loads the prebuilt index and lets
  you search and preview PDFs entirely in the browser.

## One-time setup

1. Create a new GitHub repo and push this folder to it (as `main`).
2. In the repo, go to **Settings → Pages** and set **Source** to
   **GitHub Actions**.
3. Push a commit (or add PDFs and push — see below). The **Build and Deploy**
   workflow will run automatically and your site will be live at
   `https://<username>.github.io/<repo>/` within a minute or two.

## Adding PDFs

Just drop files into `pdfs/` and push:

```bash
cp ~/Downloads/my-report.pdf pdfs/
git add pdfs/my-report.pdf
git commit -m "Add my-report.pdf"
git push
```

The GitHub Action will re-extract text for all PDFs and redeploy
automatically. Nothing else needs updating.

- **Title**: taken from the PDF's own metadata (File → Properties → Title
  in most PDF viewers) if present, otherwise generated from the filename
  (`quarterly-report-2026.pdf` → "Quarterly Report 2026").
- **Search**: both the title and the full extracted text of every PDF are
  indexed, so a search box query can match either.

## Local development (optional)

You don't need Node.js installed to use this — GitHub Actions handles the
build. But if you want to preview locally:

```bash
npm install
npm run build      # extracts PDF text, builds dist/
npx serve dist      # or: python3 -m http.server --directory dist 8000
```

Then open the printed local URL in your browser.

## Project structure

```
pdf-library/
├── pdfs/                     # Your PDF files live here
├── scripts/build.js          # Extracts text/titles, builds the search index
├── index.html                # Sidebar + search UI
├── style.css
├── app.js                    # Loads index, handles search/preview
├── package.json
└── .github/workflows/deploy.yml   # Builds + deploys on every push
```

The build writes everything GitHub Pages needs into `dist/` (gitignored —
it's regenerated on every deploy): the HTML/CSS/JS, the PDFs, and
`dist/data/search-index.json` + `dist/data/documents.json`.

## Notes & limits

- Scanned/image-only PDFs (no embedded text layer) won't have searchable
  content — the build will still list them by filename/title, just without
  a text index. Run them through OCR first if you need their content
  searchable.
- Very large PDF collections (hundreds of files, or PDFs with hundreds of
  pages each) will make the search index bigger and the GitHub Action build
  step slower, but there's no hard limit built into this setup.
- Clicking a document opens it in the right-hand preview pane (an `<iframe>`
  pointed at the PDF); "Open in new tab" opens it directly instead.
