(function () {
  const listEl = document.getElementById("doc-list");
  const searchInput = document.getElementById("search-input");
  const clearBtn = document.getElementById("clear-search");
  const resultCount = document.getElementById("result-count");
  const viewer = document.getElementById("viewer");
  const viewerEmpty = document.getElementById("viewer-empty");
  const canvasViewer = document.getElementById("pdf-canvas-viewer");

  const btnMenu = document.getElementById("btn-menu");
  const appLayout = document.getElementById("app-layout");
  const scrim = document.getElementById("scrim");

  let documents = [];
  let docById = new Map();
  let idx = null;
  let activeId = null;
  const expandedCategories = new Set();

  const MOBILE_QUERY = window.matchMedia("(max-width: 800px)");
  let currentMobileDocPath = null;

  function escapeHtml(str) {
    return String(str)
      .replace(/&/g, "&amp;")
      .replace(/</g, "&lt;")
      .replace(/>/g, "&gt;");
  }

  function highlight(text, terms) {
    if (!terms.length) return escapeHtml(text);
    const escaped = escapeHtml(text);
    const pattern = terms
      .map((t) => t.replace(/[.*+?^${}()|[\]\\]/g, "\\$&"))
      .filter(Boolean)
      .join("|");
    if (!pattern) return escaped;
    const re = new RegExp(`(${pattern})`, "ig");
    return escaped.replace(re, "<mark>$1</mark>");
  }

  function docItemHtml(doc, terms, showCategoryTag) {
    const categoryTag = showCategoryTag
      ? `<span class="doc-category-tag">${escapeHtml(doc.category)}</span>`
      : "";
    return `
      <li>
        <a class="doc-item${doc.id === activeId ? " active" : ""}" href="#" data-id="${doc.id}">
          <p class="doc-title">${highlight(doc.title, terms)}${categoryTag}</p>
          <span class="open-link" data-path="${doc.path}">Open in new tab &rarr;</span>
        </a>
      </li>`;
  }

  function renderList(docs, terms = []) {
    if (!listEl) return;

    if (!docs.length) {
      listEl.innerHTML = `<div class="empty">No documents match your search.</div>`;
      return;
    }

    if (terms.length) {
      listEl.innerHTML = `<ul class="doc-items flat">${docs
        .map((doc) => docItemHtml(doc, terms, true))
        .join("")}</ul>`;
      return;
    }

    const groups = new Map();
    for (const doc of docs) {
      if (!groups.has(doc.category)) groups.set(doc.category, []);
      groups.get(doc.category).push(doc);
    }
    const orderedCategories = [...groups.keys()].sort((a, b) => {
      if (a === "Uncategorized") return 1;
      if (b === "Uncategorized") return -1;
      return a.localeCompare(b);
    });

    listEl.innerHTML = orderedCategories
      .map((category) => {
        const items = groups.get(category).map((doc) => docItemHtml(doc, terms, false)).join("");
        const isOpen = expandedCategories.has(category);
        return `
          <details class="category-group" data-category="${escapeHtml(category)}" ${isOpen ? "open" : ""}>
            <summary class="category-header">${escapeHtml(category)}</summary>
            <ul class="doc-items">${items}</ul>
          </details>`;
      })
      .join("");

    listEl.querySelectorAll("details.category-group").forEach((details) => {
      details.addEventListener("toggle", () => {
        const category = details.dataset.category;
        if (details.open) expandedCategories.add(category);
        else expandedCategories.delete(category);
      });
    });
  }

  async function renderPdfMobile(url) {
    if (!canvasViewer) return;
    canvasViewer.innerHTML = `<div class="pdf-canvas-loading">Loading PDF...</div>`;

    try {
      const pdf = await pdfjsLib.getDocument(url).promise;
      canvasViewer.innerHTML = "";

      const containerWidth = Math.max(canvasViewer.clientWidth - 24, 200);
      const dpr = window.devicePixelRatio || 1;

      for (let pageNum = 1; pageNum <= pdf.numPages; pageNum++) {
        const page = await pdf.getPage(pageNum);
        const baseViewport = page.getViewport({ scale: 1 });
        const scale = containerWidth / baseViewport.width;
        const viewport = page.getViewport({ scale: scale * dpr });

        const canvas = document.createElement("canvas");
        canvas.className = "pdf-page-canvas";
        canvas.width = viewport.width;
        canvas.height = viewport.height;
        canvas.style.width = `${containerWidth}px`;
        canvas.style.height = `${viewport.height / dpr}px`;
        canvasViewer.appendChild(canvas);

        const ctx = canvas.getContext("2d");
        await page.render({ canvasContext: ctx, viewport }).promise;
      }
    } catch (err) {
      console.error("Failed to render PDF:", err);
      canvasViewer.innerHTML = `<div class="pdf-canvas-loading">Could not load this PDF. <a href="${url}" target="_blank" rel="noopener">Open it directly instead</a>.</div>`;
    }
  }

  function openDoc(doc) {
    activeId = doc.id;

    document
      .querySelectorAll(".doc-item")
      .forEach((el) => el.classList.toggle("active", el.dataset.id === doc.id));

    if (viewerEmpty) viewerEmpty.hidden = true;

    if (MOBILE_QUERY.matches) {
      if (viewer) viewer.hidden = true;
      if (canvasViewer) canvasViewer.hidden = false;
      currentMobileDocPath = doc.path;
      renderPdfMobile(doc.path);
      if (appLayout) appLayout.classList.remove("sidebar-open");
      return;
    }

    currentMobileDocPath = null;
    if (canvasViewer) canvasViewer.hidden = true;
    if (viewer) {
      viewer.hidden = false;
      viewer.src = doc.path;
    }
  }

  let resizeTimer = null;
  window.addEventListener("resize", () => {
    clearTimeout(resizeTimer);
    resizeTimer = setTimeout(() => {
      if (currentMobileDocPath && MOBILE_QUERY.matches && canvasViewer && !canvasViewer.hidden) {
        renderPdfMobile(currentMobileDocPath);
      }
    }, 250);
  });

  function runSearch(query) {
    const q = query.trim();
    if (clearBtn) clearBtn.classList.toggle("visible", q.length > 0);

    if (!q) {
      if (resultCount) resultCount.textContent = `${documents.length} document${documents.length === 1 ? "" : "s"}`;
      renderList(documents);
      return;
    }

    const rawTerms = q.split(/\s+/).filter(Boolean);
    const lunrQuery = rawTerms
      .map((t) => {
        const escaped = t.replace(/[*~^:]/g, "");
        return `${escaped} ${escaped}*`;
      })
      .join(" ");

    let results = [];
    try {
      results = idx.search(lunrQuery);
    } catch (e) {
      results = [];
    }

    let matches = results.map((r) => docById.get(r.ref)).filter(Boolean);

    if (matches.length === 0) {
      const lower = q.toLowerCase();
      matches = documents.filter(
        (d) => d.title.toLowerCase().includes(lower) || d.preview.toLowerCase().includes(lower)
      );
    }

    if (resultCount) resultCount.textContent = `${matches.length} result${matches.length === 1 ? "" : "s"}`;
    renderList(matches, rawTerms);
  }

  if (listEl) {
    listEl.addEventListener("click", (e) => {
      const openLink = e.target.closest(".open-link");
      const item = e.target.closest(".doc-item");
      if (!item) return;
      e.preventDefault();

      const doc = docById.get(String(item.dataset.id));
      if (!doc) return;

      if (openLink) {
        window.open(doc.path, "_blank", "noopener");
      } else {
        openDoc(doc);
      }
    });
  }

  if (btnMenu && appLayout) {
    btnMenu.addEventListener("click", () => {
      appLayout.classList.toggle("sidebar-open");
    });
  }

  if (scrim && appLayout) {
    scrim.addEventListener("click", () => {
      appLayout.classList.remove("sidebar-open");
    });
  }

  if (searchInput) {
    searchInput.addEventListener("input", () => runSearch(searchInput.value));
  }

  if (clearBtn && searchInput) {
    clearBtn.addEventListener("click", () => {
      searchInput.value = "";
      runSearch("");
      searchInput.focus();
    });
  }

  async function init() {
    try {
      const [indexJson, docsJson] = await Promise.all([
        fetch("data/search-index.json").then((r) => r.json()),
        fetch("data/documents.json").then((r) => r.json()),
      ]);

      documents = docsJson.map((d) => ({ ...d, id: String(d.id) }));
      docById = new Map(documents.map((d) => [d.id, d]));

      idx = lunr.Index.load(indexJson);
      runSearch("");
    } catch (err) {
      console.error("Failed to load library:", err);
      if (listEl) {
        listEl.innerHTML = `<div class="empty">Could not load the library. Make sure the site was built (see README).</div>`;
      }
    }
  }

  init();
})();
