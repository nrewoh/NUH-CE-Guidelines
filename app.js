import * as pdfjsLib from "https://cdn.jsdelivr.net/npm/pdfjs-dist@4/build/pdf.min.mjs";
pdfjsLib.GlobalWorkerOptions.workerSrc = "https://cdn.jsdelivr.net/npm/pdfjs-dist@4/build/pdf.worker.min.mjs";

(function () {
  const listEl = document.getElementById("doc-list");
  const searchInput = document.getElementById("search-input");
  const clearBtn = document.getElementById("clear-search");
  const resultCount = document.getElementById("result-count");
  const viewerEmpty = document.getElementById("viewer-empty");
  
  // Swap out the old viewerContainer assignments with these targets:
  const viewerControls = document.getElementById("viewer-controls");
  const pdfScrollViewer = document.getElementById("pdf-scroll-viewer");
  const pagesContainer = document.getElementById("pages-container");
  const viewerLoading = document.getElementById("viewer-loading");
  
  const btnPrev = document.getElementById("btn-prev");
  const btnNext = document.getElementById("btn-next");
  const pageInput = document.getElementById("page-input");
  const pageCountEl = document.getElementById("page-count");
  const activeDocTitle = document.getElementById("active-doc-title");
  const zoomPctEl = document.getElementById("zoom-pct");
  
  const btnZoomIn = document.getElementById("btn-zoom-in");
  const btnZoomOut = document.getElementById("btn-zoom-out");
  const btnFit = document.getElementById("btn-fit");
  const btnMenu = document.getElementById("btn-menu");
  const layoutContainer = document.querySelector(".layout");

  let documents = [];
  let docById = new Map();
  let idx = null;
  let activeId = null;

  // Premium Canvas Virtualization States
  let pdfDoc = null;
  let totalPages = 0;
  let currentPage = 1;
  let scale = 1;
  let fitMode = true;
  let baseWidth = 0, baseHeight = 0; 
  let fitScale = 1; 
  let slotW = 0, slotH = 0;          
  const slots = [];          
  const renderedPages = new Set();    
  let scrollScheduled = false;
  let zoomDebounce = null;
  
  const GAP = 14;      
  const BUFFER = 2;    
  const KEEP = 5;       

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

  function renderList(docs, terms = []) {
    if (!docs.length) {
      listEl.innerHTML = `<li class="empty">No documents match your search.</li>`;
      return;
    }

    if (terms.length) {
      listEl.innerHTML = docs.map((doc) => docItemHtml(doc, terms, true)).join("");
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
        return `
          <li class="category-header">${escapeHtml(category)}</li>
          ${items}`;
      })
      .join("");
  }

  // CORE CANVAS RENDERING ENGINE LOGIC
  async function openDoc(doc) {
    activeId = doc.id;
    viewerEmpty.style.display = "none";
    viewerContainer.hidden = false;
    activeDocTitle.textContent = doc.title;
    
    document
      .querySelectorAll(".doc-item")
      .forEach((el) => el.classList.toggle("active", el.dataset.id === doc.id));

    // Auto collapse layout overlay drawer on mobile viewports
    layoutContainer.classList.remove("sidebar-open");

    // Flush and reset previous canvas pipelines entirely
    pdfDoc = null;
    totalPages = 0;
    currentPage = 1;
    scale = 1;
    fitMode = true;
    renderedPages.clear();
    slots.length = 0;
    pagesContainer.innerHTML = "";
    viewerLoading.hidden = false;
    viewerLoading.textContent = "Loading document pages…";
    pageCountEl.textContent = "…";
    pageInput.value = "1";
    updatePrevNextDisabled();

    try {
      const loadingTask = pdfjsLib.getDocument({
        url: doc.path,
        cMapUrl: "https://cdn.jsdelivr.net/npm/pdfjs-dist@4/cmaps/",
        cMapPacked: true,
        standardFontDataUrl: "https://cdn.jsdelivr.net/npm/pdfjs-dist@4/standard_fonts/"
      });
      
      pdfDoc = await loadingTask.promise;
      totalPages = pdfDoc.numPages;
      pageCountEl.textContent = totalPages;

      const firstPage = await pdfDoc.getPage(1);
      const vp1 = firstPage.getViewport({ scale: 1 });
      baseWidth = vp1.width;
      baseHeight = vp1.height;

      computeScale();
      fitScale = scale;
      buildSlots();
      viewerLoading.hidden = true;
      updateVisible();
    } catch (err) {
      console.error("Failed to render PDF into canvas channels:", err);
      viewerLoading.textContent = "Couldn't load page stream vector layers.";
    }
  }

  function computeScale() {
    if (fitMode) {
      const available = pdfScrollViewer.clientWidth - 32;
      scale = Math.max(0.3, available / baseWidth);
    }
    slotW = baseWidth * scale;
    slotH = baseHeight * scale;
  }

  function buildSlots() {
    pagesContainer.innerHTML = '';
    slots.length = 0;
    pagesContainer.style.width = slotW + 'px';
    pagesContainer.style.height = (totalPages * (slotH + GAP) - GAP) + 'px';
    for (let i = 0; i < totalPages; i++) {
      const div = document.createElement('div');
      div.className = 'page-slot';
      div.style.top = (i * (slotH + GAP)) + 'px';
      div.style.width = slotW + 'px';
      div.style.height = slotH + 'px';
      div.dataset.page = i + 1;
      pagesContainer.appendChild(div);
      slots.push(div);
    }
  }

  function relayoutSlots() {
    pagesContainer.style.width = slotW + 'px';
    pagesContainer.style.height = (totalPages * (slotH + GAP) - GAP) + 'px';
    slots.forEach((div, i) => {
      div.style.top = (i * (slotH + GAP)) + 'px';
      div.style.width = slotW + 'px';
      div.style.height = slotH + 'px';
      div.innerHTML = ''; 
    });
    renderedPages.clear();
  }

  async function ensureRendered(pageNum) {
    if (renderedPages.has(pageNum)) return;
    const slot = slots[pageNum - 1];
    if (!slot || slot.querySelector('canvas')) { renderedPages.add(pageNum); return; }
    renderedPages.add(pageNum);
    try {
      const page = await pdfDoc.getPage(pageNum);
      const viewport = page.getViewport({ scale });
      const canvas = document.createElement('canvas');
      canvas.width = viewport.width;
      canvas.height = viewport.height;
      slot.appendChild(canvas);
      const ctx = canvas.getContext('2d');
      await page.render({ canvasContext: ctx, viewport }).promise;
    } catch (e) {
      renderedPages.delete(pageNum);
    }
  }

  function unrender(pageNum) {
    renderedPages.delete(pageNum);
    const slot = slots[pageNum - 1];
    if (slot) slot.innerHTML = '';
  }

  function unitHeight() { return slotH + GAP; }

  function updateVisible() {
    if (!totalPages || !pdfDoc) return;
    const unit = unitHeight();
    const scrollTop = pdfScrollViewer.scrollTop;
    const viewH = pdfScrollViewer.clientHeight;
    const firstIdx = Math.max(0, Math.floor(scrollTop / unit) - BUFFER);
    const lastIdx = Math.min(totalPages - 1, Math.ceil((scrollTop + viewH) / unit) + BUFFER);

    for (let i = firstIdx; i <= lastIdx; i++) ensureRendered(i + 1);

    renderedPages.forEach(p => {
      const idx = p - 1;
      if (idx < firstIdx - KEEP || idx > lastIdx + KEEP) unrender(p);
    });

    const curIdx = Math.min(totalPages - 1, Math.max(0, Math.round(scrollTop / unit)));
    if (curIdx + 1 !== currentPage) {
      currentPage = curIdx + 1;
      pageInput.value = currentPage;
      updatePrevNextDisabled();
    }
  }

  function updatePrevNextDisabled() {
    btnPrev.disabled = currentPage <= 1;
    btnNext.disabled = currentPage >= totalPages;
  }

  function goToPage(n) {
    if (!totalPages || !pdfDoc) return;
    n = Math.min(totalPages, Math.max(1, n));
    pdfScrollViewer.scrollTop = (n - 1) * unitHeight();
    updateVisible();
  }

  function applyZoom() {
    if (!pdfDoc) return;
    clearTimeout(zoomDebounce);
    zoomDebounce = setTimeout(() => {
      const anchorPage = currentPage;
      computeScale();
      if (fitMode) fitScale = scale;
      relayoutSlots();
      goToPage(anchorPage);
      zoomPctEl.textContent = Math.round((scale / fitScale) * 100) + '%';
    }, 60);
  }

  // EVENT ACTION HOOK HANDLERS
  pdfScrollViewer.addEventListener('scroll', () => {
    if (scrollScheduled) return;
    scrollScheduled = true;
    requestAnimationFrame(() => { updateVisible(); scrollScheduled = false; });
  });

  btnPrev.addEventListener('click', () => goToPage(currentPage - 1));
  btnNext.addEventListener('click', () => goToPage(currentPage + 1));
  pageInput.addEventListener('keydown', (e) => {
    if (e.key === 'Enter') {
      const n = parseInt(e.target.value, 10);
      if (!isNaN(n)) goToPage(n);
    }
  });

  btnZoomIn.addEventListener('click', () => { if (!pdfDoc) return; fitMode = false; scale = Math.min(4, scale * 1.15); applyZoom(); });
  btnZoomOut.addEventListener('click', () => { if (!pdfDoc) return; fitMode = false; scale = Math.max(0.25, scale / 1.15); applyZoom(); });
  btnFit.addEventListener('click', () => { if (!pdfDoc) return; fitMode = true; applyZoom(); });
  window.addEventListener('resize', () => { if (fitMode) applyZoom(); });
  btnMenu.addEventListener('click', () => { layoutContainer.classList.toggle("sidebar-open"); });

  document.addEventListener('keydown', (e) => {
    if (document.activeElement === pageInput || document.activeElement === searchInput) return;
    if (e.key === 'ArrowRight') goToPage(currentPage + 1);
    if (e.key === 'ArrowLeft') goToPage(currentPage - 1);
  });

  function runSearch(query) {
    const q = query.trim();
    clearBtn.classList.toggle("visible", q.length > 0);

    if (!q) {
      resultCount.textContent = `${documents.length} document${documents.length === 1 ? "" : "s"}`;
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

  async function init() {
  try {
    const [indexJson, docsJson] = await Promise.all([
      fetch("data/search-index.json").then((r) => r.json()),
      fetch("data/documents.json").then((r) => r.json()),
    ]);
    
    // Fix: Safely force all IDs to strings so they match HTML dataset strings perfectly
    documents = docsJson.map(d => ({ ...d, id: String(d.id) }));
    
    docById = new Map(documents.map((d) => [d.id, d]));
    idx = lunr.Index.load(indexJson);
    runSearch("");
  } catch (err) {
    console.error("Failed to load library:", err);
    listEl.innerHTML = `<li class="empty">Could not load the library. Make sure the site was built (see README).</li>`;
  }
}

  init();
})();
