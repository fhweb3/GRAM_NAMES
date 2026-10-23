import { initializeApp } from "https://www.gstatic.com/firebasejs/11.6.0/firebase-app.js";
import { getFirestore, collection, query, where, onSnapshot } from "https://www.gstatic.com/firebasejs/11.6.0/firebase-firestore.js";
import { firebaseConfig } from "./firebase-config.js";

const app = initializeApp(firebaseConfig);
const db = getFirestore(app);
const inventoryEl = document.querySelector("#inventory");
const messageEl = document.querySelector("#message");
const searchEl = document.querySelector("#search");
const statusEl = document.querySelector("#statusFilter");
const categoryEl = document.querySelector("#categoryFilters");
let items = [];
let category = "";
let currentPage = 1;
const PAGE_SIZE = 50;

function escapeHtml(s = "") {
  return String(s).replace(/[&<>"']/g, c => ({ "&":"&amp;", "<":"&lt;", ">":"&gt;", '"':"&quot;", "'":"&#39;" }[c]));
}
function badgeClass(status) {
  return status === "available" ? "available" : status === "sold" ? "sold" : "offer";
}
function render() {
  const needle = searchEl.value.trim().toLowerCase();
  const filtered = items.filter(x => {
    const matchText = `${x.username} ${x.category}`.toLowerCase().includes(needle);
    return matchText && (!statusEl.value || x.status === statusEl.value) && (!category || x.category === category);
  });
  const pageCount = Math.max(1, Math.ceil(filtered.length / PAGE_SIZE));
  currentPage = Math.min(Math.max(1, currentPage), pageCount);
  const start = (currentPage - 1) * PAGE_SIZE;
  const pageItems = filtered.slice(start, start + PAGE_SIZE);
  document.querySelector("#count").textContent = filtered.length
    ? `${filtered.length} username${filtered.length === 1 ? "" : "s"} found · Showing ${start + 1}–${Math.min(start + PAGE_SIZE, filtered.length)}`
    : "0 usernames found";
  categoryEl.innerHTML = `<button class="chip ${category === "" ? "active" : ""}" data-category="">All categories</button>` +
    [...new Set(items.map(x => x.category).filter(Boolean))].sort().map(c => `<button class="chip ${category === c ? "active" : ""}" data-category="${escapeHtml(c)}">${escapeHtml(c)}</button>`).join("");
  inventoryEl.innerHTML = pageItems.length ? pageItems.map(x => `
    <article class="item-card">
      <div class="item-top"><span class="telegram-dot">✈</span><span class="status ${badgeClass(x.status)}">${escapeHtml(x.status)}</span></div>
      <h3>${escapeHtml(x.username)}</h3><p class="item-category">${escapeHtml(x.category)}</p>
      <div class="item-bottom"><strong>${x.price === null || x.price === undefined || x.price === "" ? '<span class="price-unset">Price not set</span>' : '$' + Number(x.price).toLocaleString("en-US",{minimumFractionDigits:2,maximumFractionDigits:2})}</strong>
      <a class="button button-small ${x.status === "sold" ? "button-disabled" : "button-primary"}" href="https://t.me/${encodeURIComponent(x.username.replace(/^@/,''))}" target="_blank" rel="noopener noreferrer">${x.status === "sold" ? "View on Telegram" : "Contact seller"}</a></div>
    </article>`).join("") : `<div class="empty-state"><span>🔎</span><h3>No usernames found</h3><p>Try another search or category.</p></div>`;
  const pager = document.querySelector("#pagination");
  pager.innerHTML = pageCount > 1 ? `<button class="button button-light pager-button" data-page="${currentPage - 1}" ${currentPage === 1 ? "disabled" : ""}>← Previous</button><span>Page ${currentPage} of ${pageCount}</span><button class="button button-primary pager-button" data-page="${currentPage + 1}" ${currentPage === pageCount ? "disabled" : ""}>Next →</button>` : "";
}

categoryEl.addEventListener("click", e => {
  const btn = e.target.closest("[data-category]");
  if (btn) { category = btn.dataset.category; currentPage = 1; render(); }
});
searchEl.addEventListener("input", () => { currentPage = 1; render(); });
statusEl.addEventListener("change", () => { currentPage = 1; render(); });
document.querySelector("#pagination").addEventListener("click", e => { const btn = e.target.closest("[data-page]"); if (btn && !btn.disabled) { currentPage = Number(btn.dataset.page); render(); window.scrollTo({ top: document.querySelector("#inventory").offsetTop - 20, behavior: "smooth" }); } });

onSnapshot(query(collection(db, "inventory"), where("archived", "==", false)), snap => {
  items = snap.docs.map(d => ({ id: d.id, ...d.data() })).sort((a,b) => a.username.localeCompare(b.username));
  messageEl.hidden = true;
  render();
}, err => {
  console.error(err);
  messageEl.hidden = false;
  messageEl.textContent = "Firestore error: " + (err.code || err.message || "unknown");
  document.querySelector("#count").textContent = "Inventory unavailable";
});
