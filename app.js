
import { initializeApp } from "https://www.gstatic.com/firebasejs/11.6.0/firebase-app.js";

import {
  getFirestore,
  collection,
  query,
  where,
  onSnapshot
} from "https://www.gstatic.com/firebasejs/11.6.0/firebase-firestore.js";

import { firebaseConfig } from "./firebase-config.js";

const inventoryEl = document.querySelector("#inventory");
const messageEl = document.querySelector("#message");
const searchEl = document.querySelector("#search");
const statusEl = document.querySelector("#statusFilter");
const categoryEl = document.querySelector("#categoryFilters");
const countEl = document.querySelector("#count");
const paginationEl = document.querySelector("#pagination");

let items = [];
let category = "";
let currentPage = 1;

const PAGE_SIZE = 50;

function showError(err) {
  console.error("GRAM NAMES SHOP Firebase error:", err);

  messageEl.hidden = false;

  const code = err?.code || "unknown";
  const details = err?.message || "No additional error details.";

  messageEl.textContent =
    `Firestore error: ${code} — ${details}`;

  countEl.textContent = "Inventory unavailable";
  inventoryEl.innerHTML = "";
  paginationEl.innerHTML = "";
}

function escapeHtml(value = "") {
  return String(value).replace(/[&<>"']/g, char => ({
    "&": "&amp;",
    "<": "&lt;",
    ">": "&gt;",
    '"': "&quot;",
    "'": "&#39;"
  })[char]);
}

function badgeClass(status) {
  if (status === "available") return "available";
  if (status === "sold") return "sold";
  return "offer";
}

function render() {
  const needle = searchEl.value.trim().toLowerCase();

  const filtered = items.filter(item => {
    const username = String(item.username || "");
    const itemCategory = String(item.category || "");

    const matchesText =
      `${username} ${itemCategory}`.toLowerCase().includes(needle);

    const matchesStatus =
      !statusEl.value || item.status === statusEl.value;

    const matchesCategory =
      !category || itemCategory === category;

    return matchesText && matchesStatus && matchesCategory;
  });

  const pageCount = Math.max(
    1,
    Math.ceil(filtered.length / PAGE_SIZE)
  );

  currentPage = Math.min(
    Math.max(1, currentPage),
    pageCount
  );

  const start = (currentPage - 1) * PAGE_SIZE;

  const pageItems = filtered.slice(
    start,
    start + PAGE_SIZE
  );

  countEl.textContent = filtered.length
    ? `${filtered.length} username${filtered.length === 1 ? "" : "s"} found · Showing ${start + 1}–${Math.min(start + PAGE_SIZE, filtered.length)}`
    : "0 usernames found";

  const categories = [
    ...new Set(
      items.map(item => item.category).filter(Boolean)
    )
  ].sort();

  categoryEl.innerHTML =
    `<button class="chip ${category === "" ? "active" : ""}" data-category="">All categories</button>` +
    categories.map(itemCategory => `
      <button
        class="chip ${category === itemCategory ? "active" : ""}"
        data-category="${escapeHtml(itemCategory)}"
      >${escapeHtml(itemCategory)}</button>
    `).join("");

  inventoryEl.innerHTML = pageItems.length
    ? pageItems.map(item => {
        const username = String(item.username || "");
        const itemCategory = String(item.category || "");
        const status = String(item.status || "");
        const telegramName = username.replace(/^@/, "");

        const priceUnset =
          item.price === null ||
          item.price === undefined ||
          item.price === "";

        const priceHtml = priceUnset
          ? '<span class="price-unset">Price not set</span>'
          : "$" + Number(item.price).toLocaleString("en-US", {
              minimumFractionDigits: 2,
              maximumFractionDigits: 2
            });

        const contactLabel =
          status === "sold" ? "View on Telegram" : "Contact seller";

        const buttonClass =
          status === "sold"
            ? "button-disabled"
            : "button-primary";

        return `
          <article class="item-card">
            <div class="item-top">
              <span class="telegram-dot">✈</span>
              <span class="status ${badgeClass(status)}">${escapeHtml(status)}</span>
            </div>

            <h3>${escapeHtml(username)}</h3>
            <p class="item-category">${escapeHtml(itemCategory)}</p>

            <div class="item-bottom">
              <strong>${priceHtml}</strong>

              <a
                class="button button-small ${buttonClass}"
                href="https://t.me/${encodeURIComponent(telegramName)}"
                target="_blank"
                rel="noopener noreferrer"
              >${contactLabel}</a>
            </div>
          </article>
        `;
      }).join("")
    : `
      <div class="empty-state">
        <span>🔎</span>
        <h3>No usernames found</h3>
        <p>Try another search or category.</p>
      </div>
    `;

  paginationEl.innerHTML = pageCount > 1
    ? `
      <button
        class="button button-light pager-button"
        data-page="${currentPage - 1}"
        ${currentPage === 1 ? "disabled" : ""}
      >← Previous</button>

      <span>Page ${currentPage} of ${pageCount}</span>

      <button
        class="button button-primary pager-button"
        data-page="${currentPage + 1}"
        ${currentPage === pageCount ? "disabled" : ""}
      >Next →</button>
    `
    : "";
}

categoryEl.addEventListener("click", event => {
  const button = event.target.closest("[data-category]");

  if (!button) return;

  category = button.dataset.category;
  currentPage = 1;
  render();
});

searchEl.addEventListener("input", () => {
  currentPage = 1;
  render();
});

statusEl.addEventListener("change", () => {
  currentPage = 1;
  render();
});

paginationEl.addEventListener("click", event => {
  const button = event.target.closest("[data-page]");

  if (!button || button.disabled) return;

  currentPage = Number(button.dataset.page);
  render();

  window.scrollTo({
    top: inventoryEl.offsetTop - 20,
    behavior: "smooth"
  });
});

try {
  const app = initializeApp(firebaseConfig);
  const db = getFirestore(app);

  const inventoryQuery = query(
    collection(db, "inventory"),
    where("archived", "==", false)
  );

  onSnapshot(
    inventoryQuery,

    snapshot => {
      items = snapshot.docs
        .map(doc => ({
          id: doc.id,
          ...doc.data()
        }))
        .sort((a, b) =>
          String(a.username || "").localeCompare(
            String(b.username || "")
          )
        );

      messageEl.hidden = true;
      render();
    },

    err => {
      showError(err);
    }
  );
} catch (err) {
  showError(err);
}
