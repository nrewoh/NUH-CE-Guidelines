(function () {
  const listEl = document.getElementById("doc-list");
  const searchInput = document.getElementById("search-input");
  const clearBtn = document.getElementById("clear-search");
  const resultCount = document.getElementById("result-count");
  const viewer = document.getElementById("viewer");
  const viewerEmpty = document.getElementById("viewer-empty");
  
  // Mobile UI additions
  const layoutEl = document.querySelector(".layout");
  const menuToggleBtn = document.getElementById("menu-toggle"); 

  let documents = [];
  let docById = new Map();
  let idx = null;
  let activeId = null;
  // Categories are collapsed by default; this tracks which ones the user
  // has explicitly expanded.
  const expandedCategories = new Set();

  function escapeHtml(str) {
    return String(str)
      .replace(/&/g, "&amp;")
      .replace(/</g, "&lt;")
      .replace(/>/g, "&gt;");
  }

  // Wrap case-insensitive whole/partial matches of any query term in <mark>.
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
    const pages = doc.pageCount ? `${doc.pageCount} page${doc.pageCount === 1 ? "" : "s"}` : "";
    const categoryTag = showCategoryTag
      ? `<span class="doc-category-tag">${escapeHtml(doc.category)}</span>`
      : "";
    return `
      <li>
        <a class="doc-item${doc.id === activeId ? " active" : ""}" href="#" data-id="${doc.id}">
          <p class="doc-title">${highlight(doc.title, terms)}${categoryTag}</p>
          <p class="doc-preview">${highlight(doc.preview, terms)}</p>
          <p class="doc-meta">${pages}</p>
          <span class="open-link" data-path="${doc.path}">Open in new tab &rarr;</span>
        </a>
      </li>`;
  }

  // No active search: group into collapsible <details> sections per category.
  // During a search: flat list (relevance order), with a small category tag
  // per result since matches can span categories.
  function renderList(docs, terms = []) {
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

    // Track collapsed/expanded state per category across re-renders.
    listEl.querySelectorAll("details.category-group").forEach((details) => {
      details.addEventListener("toggle", () => {
        const category = details.dataset.category;
        if (details.open) expandedCategories.add(category);
        else expandedCategories.delete(category);
      });
    });
  }

  function openDoc(doc) {
    activeId = doc.id;
    viewerEmpty.hidden = true;
    viewer.hidden = false;
    viewer.src = doc.path;
    document
      .querySelectorAll(".doc-item")
      .forEach((el) => el.classList.toggle("active", el.dataset.id === doc.id));

    // Mobile Modification: Auto-closes the drawer layout once a document is chosen
    if (layoutEl) {
      layoutEl.classList.remove("sidebar-open");
    }
  }

  function runSearch(query) {
    const q = query.trim();
    clearBtn.classList.toggle("visible", q.length > 0);

    if (!q) {
      resultCount.textContent = `${documents.length} document${documents.length === 1 ? "" : "s"}`;
      renderList(documents);
      return;
    }

    const rawTerms = q.split(/\s+/).filter(Boolean);
    // Build a lenient query: exact term OR prefix match OR mild fuzziness.
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
      // Fall back to a very basic substring search if the Lunr query syntax fails.
      results = [];
    }

    let matches = results.map((r) => docById.get(r.ref)).filter(Boolean);

    if (matches.length === 0) {
      // Fallback: plain substring match across title/preview for short/odd queries.
      const lower = q.toLowerCase();
      matches = documents.filter(
        (d) => d.title.toLowerCase().includes(lower) || d.preview.toLowerCase().includes(lower)
      );
    }

    resultCount.textContent = `${matches.length} result${matches.length === 1 ? "" : "s"}`;
    renderList(matches, rawTerms);
  }

  listEl.addEventListener("click", (e) => {
    const openLink = e.target.closest(".open-link");
    const item = e.target.closest(".doc-item");
    if (!item) return;
    e.preventDefault();
    const doc = docById.get(item.dataset.id);
    if (!doc) return;
    if (openLink) {
      window.open(doc.path, "_blank", "noopener");
    } else {
      openDoc(doc);
    }
  });

  searchInput.addEventListener("input", () => runSearch(searchInput.value));
  clearBtn.addEventListener("click", () => {
    searchInput.value = "";
    runSearch("");
    searchInput.focus();
  });

  // Mobile Modification: Clicking the button toggles drawer accessibility
  if (menuToggleBtn && layoutEl) {
    menuToggleBtn.addEventListener("click", () => {
      layoutEl.classList.toggle("sidebar-open");
    });
  }

  async function init() {
    try {
      const [indexJson, docsJson] = await Promise.all([
        fetch("data/search-index.json").then((r) => r.json()),
        fetch("data/documents.json").then((r) => r.json()),
      ]);
      documents = docsJson;
      docById = new Map(documents.map((d) => [d.id, d]));
      idx = lunr.Index.load(indexJson);
      runSearch("");
    } catch (err) {
      console.error("Failed to load library:", err);
      listEl.innerHTML = `<div class="empty">Could not load the library. Make sure the site was built (see README).</div>`;
    }
  }

  init();
})();
