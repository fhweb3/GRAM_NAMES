import { initializeApp } from "https://www.gstatic.com/firebasejs/11.6.0/firebase-app.js";
import { getAuth, signInWithEmailAndPassword, signOut, onAuthStateChanged, getIdTokenResult } from "https://www.gstatic.com/firebasejs/11.6.0/firebase-auth.js";
import { getFirestore, collection, onSnapshot, query, orderBy } from "https://www.gstatic.com/firebasejs/11.6.0/firebase-firestore.js";
import { getFunctions, httpsCallable } from "https://www.gstatic.com/firebasejs/11.6.0/firebase-functions.js";
import { firebaseConfig, FUNCTIONS_REGION } from "./firebase-config.js";

const app = initializeApp(firebaseConfig);
const auth = getAuth(app);
const db = getFirestore(app);
const functions = getFunctions(app, FUNCTIONS_REGION);
const call = name => httpsCallable(functions, name);
const $ = s => document.querySelector(s);
let records = [];
let importRows = [];
let stopInventory = null;

function esc(s = "") { return String(s).replace(/[&<>"']/g, c => ({ "&":"&amp;","<":"&lt;",">":"&gt;",'"':"&quot;","'":"&#39;" }[c])); }
function note(el, msg, bad = false) { el.hidden = false; el.textContent = msg; el.className = "notice" + (bad ? " error" : ""); }
function clearNote(el) { el.hidden = true; el.textContent = ""; }
function normalizeStatus(v) {
  const s = String(v || "").trim().toLowerCase().replace(/[_-]+/g," ").replace(/\s+/g," ");
  return s === "offer" ? "current offer" : s;
}
function normalizeUsername(v) { return String(v || "").trim().replace(/^@+/, "").toLowerCase(); }
function csvParse(text) {
  const rows = []; let row = [], cell = "", quoted = false;
  text = text.replace(/^\uFEFF/, "");
  for (let i=0; i<text.length; i++) {
    const c = text[i];
    if (quoted) {
      if (c === '"' && text[i+1] === '"') { cell += '"'; i++; }
      else if (c === '"') quoted = false;
      else cell += c;
    } else {
      if (c === '"' && cell.length === 0) quoted = true;
      else if (c === ",") { row.push(cell.trim()); cell = ""; }
      else if (c === "\n" || c === "\r") {
        if (c === "\r" && text[i+1] === "\n") i++;
        row.push(cell.trim()); cell = "";
        if (row.some(v => v !== "")) rows.push(row);
        row = [];
      } else cell += c;
    }
  }
  row.push(cell.trim()); if (row.some(v => v !== "")) rows.push(row);
  if (!rows.length) return [];
  const headers = rows.shift().map(h => h.toLowerCase().trim().replace(/^\ufeff/,""));
  return rows.map((cells, index) => {
    const o = {}; headers.forEach((h, i) => o[h] = cells[i] ?? "");
    return { ...o, __row: index + 2 };
  });
}
function validateRows(rows) {
  const seen = new Set();
  return rows.map(r => {
    const usernameRaw = r.username || r.user_name || r.handle || "";
    const key = normalizeUsername(usernameRaw);
    const status = normalizeStatus(r.status);
    const category = String(r.category || "").trim();
    const price = r.price === "" || r.price === undefined || r.price === null ? null : Number(r.price);
    let error = "";
    if (!/^[a-z0-9_]{1,64}$/.test(key)) error = "Invalid username (letters, numbers and underscores only).";
    else if (!["available","current offer","sold"].includes(status)) error = "Status must be available, current offer, or sold.";
    else if (!category || category.length > 80) error = "Category is required (max 80 characters).";
    else if (price !== null && (!Number.isFinite(price) || price < 0)) error = "Price must be blank or a non-negative number.";
    else if (seen.has(key)) error = "Duplicate username within this CSV; later duplicate skipped.";
    if (key) seen.add(key);
    return { username: key ? "@" + key : usernameRaw, status, category, price, __row: r.__row, __error: error };
  });
}
function renderStats() {
  const active = records.filter(r => !r.archived);
  $("#statTotal").textContent = active.length;
  $("#statAvailable").textContent = active.filter(r => r.status === "available").length;
  $("#statOffer").textContent = active.filter(r => r.status === "current offer").length;
  $("#statSold").textContent = active.filter(r => r.status === "sold").length;
  const categories = [...new Set(records.map(r => r.category).filter(Boolean))].sort();
  $("#categoryList").innerHTML = categories.map(c => `<option value="${esc(c)}"></option>`).join("");
}
function renderRows() {
  const term = $("#adminSearch").value.trim().toLowerCase();
  const status = $("#adminStatus").value;
  const showArchived = $("#showArchived").checked;
  const filtered = records.filter(r => (showArchived || !r.archived) && (!status || r.status === status) && `${r.username} ${r.category}`.toLowerCase().includes(term));
  $("#adminRows").innerHTML = filtered.length ? filtered.map(r => `<tr class="${r.archived ? "archived-row" : ""}">
    <td><strong>${esc(r.username)}</strong>${r.archived ? '<small class="archived-label">Archived</small>' : ""}</td>
    <td><span class="status ${r.status === "available" ? "available" : r.status === "sold" ? "sold" : "offer"}">${esc(r.status)}</span></td>
    <td>${esc(r.category)}</td><td>${r.price === null || r.price === undefined || r.price === "" ? "Price not set" : "$" + Number(r.price).toFixed(2)}</td>
    <td><div class="actions">${r.archived
      ? `<button class="mini-button" data-action="restore" data-id="${esc(r.id)}">Restore</button>`
      : `<button class="mini-button" data-action="edit" data-id="${esc(r.id)}">Edit</button><button class="mini-button danger" data-action="archive" data-id="${esc(r.id)}">Archive</button>`}
    </div></td></tr>`).join("") : '<tr><td colspan="5">No matching usernames.</td></tr>';
}
function resetEditor() {
  $("#itemForm").reset(); $("#editingKey").value = ""; $("#editorTitle").textContent = "Add a username"; clearNote($("#itemMessage"));
}
function fillEditor(r) {
  $("#editingKey").value = r.id; $("#itemUsername").value = r.username; $("#itemStatus").value = r.status;
  $("#itemCategory").value = r.category; $("#itemPrice").value = r.price; $("#editorTitle").textContent = "Edit username";
  window.scrollTo({ top: 0, behavior: "smooth" });
}
$("#loginForm").addEventListener("submit", async e => {
  e.preventDefault(); clearNote($("#loginMessage"));
  try { await signInWithEmailAndPassword(auth, $("#email").value.trim(), $("#password").value); }
  catch (err) { note($("#loginMessage"), err.code === "auth/invalid-credential" ? "Email or password is incorrect." : err.message, true); }
});
$("#signOut").addEventListener("click", () => signOut(auth));
$("#cancelEdit").addEventListener("click", resetEditor);
$("#itemForm").addEventListener("submit", async e => {
  e.preventDefault(); clearNote($("#itemMessage"));
  const oldKey = $("#editingKey").value;
  const priceText = $("#itemPrice").value.trim();
  const payload = { username: $("#itemUsername").value, status: $("#itemStatus").value, category: $("#itemCategory").value, price: priceText === "" ? null : Number(priceText) };
  try {
    if (oldKey) {
      const old = records.find(r => r.id === oldKey);
      if (old && normalizeUsername(old.username) !== normalizeUsername(payload.username)) {
        note($("#itemMessage"), "Changing a username's identity is disabled. Archive the old entry and add a new username instead.", true); return;
      }
      await call("updateInventoryItem")(payload);
      note($("#itemMessage"), "Username updated.");
    } else {
      await call("createInventoryItem")(payload);
      note($("#itemMessage"), "Username added.");
    }
    resetEditor();
  } catch (err) { note($("#itemMessage"), err.message || "Save failed.", true); }
});
$("#adminRows").addEventListener("click", async e => {
  const b = e.target.closest("[data-action]"); if (!b) return;
  const r = records.find(x => x.id === b.dataset.id); if (!r) return;
  try {
    if (b.dataset.action === "edit") fillEditor(r);
    else if (b.dataset.action === "archive" && confirm(`Archive ${r.username}? It can be restored later.`)) {
      await call("archiveInventoryItem")({ username: r.username });
    } else if (b.dataset.action === "restore") {
      await call("restoreInventoryItem")({ username: r.username });
    }
  } catch (err) { alert(err.message || "Action failed."); }
});
["#adminSearch","#adminStatus","#showArchived"].forEach(sel => $(sel).addEventListener(sel === "#adminSearch" ? "input" : "change", renderRows));
$("#csvFile").addEventListener("change", async e => {
  const file = e.target.files?.[0]; if (file) $("#csvText").value = await file.text();
});
$("#clearCsv").addEventListener("click", () => {
  $("#csvFile").value = ""; $("#csvText").value = ""; $("#csvPreview").hidden = true; $("#csvPreview").innerHTML = "";
  clearNote($("#csvMessage")); importRows = [];
});
$("#previewCsv").addEventListener("click", () => {
  clearNote($("#csvMessage"));
  try {
    const parsed = csvParse($("#csvText").value);
    if (!parsed.length) { note($("#csvMessage"), "Choose a CSV file or paste CSV text first.", true); return; }
    importRows = validateRows(parsed);
    const good = importRows.filter(r => !r.__error);
    const bad = importRows.filter(r => r.__error);
    const existing = new Set(records.map(r => normalizeUsername(r.username)));
    const willSkip = good.filter(r => existing.has(normalizeUsername(r.username))).length;
    $("#csvPreview").hidden = false;
    $("#csvPreview").innerHTML = `<div class="preview-summary"><strong>${good.length - willSkip} likely new</strong><span>${willSkip} existing will be skipped</span><span>${bad.length} invalid</span></div>
      <div class="table-wrap preview-table"><table><thead><tr><th>Row</th><th>Username</th><th>Status</th><th>Category</th><th>Price</th><th>Validation</th></tr></thead><tbody>${importRows.slice(0,200).map(r => `<tr><td>${r.__row}</td><td>${esc(r.username)}</td><td>${esc(r.status)}</td><td>${esc(r.category)}</td><td>${r.price === null || r.price === "" || !Number.isFinite(r.price) ? "Price not set" : "$"+r.price.toFixed(2)}</td><td class="${r.__error ? "bad-cell" : "good-cell"}">${esc(r.__error || (existing.has(normalizeUsername(r.username)) ? "Existing: skip" : "Ready"))}</td></tr>`).join("")}</tbody></table></div>
      <p class="muted">Preview shows up to 200 rows. Import sends valid rows only; existing usernames are skipped by the server.</p><button id="confirmImport" class="button button-primary" ${good.length ? "" : "disabled"}>Confirm import (${good.length} valid rows)</button>`;
    $("#confirmImport").addEventListener("click", importCsv);
  } catch (err) { note($("#csvMessage"), err.message || "Could not parse CSV.", true); }
});
async function importCsv() {
  const btn = $("#confirmImport"); btn.disabled = true; btn.textContent = "Importing…"; clearNote($("#csvMessage"));
  const valid = importRows.filter(r => !r.__error).map(({username,status,category,price}) => ({username,status,category,price}));
  let added = 0, skipped = 0, invalid = importRows.filter(r => r.__error).length, errors = [];
  try {
    for (let i=0; i<valid.length; i+=100) {
      const res = await call("bulkImportInventory")({ rows: valid.slice(i,i+100) });
      added += res.data.added; skipped += res.data.skipped; invalid += res.data.invalid; errors.push(...(res.data.errors || []));
      btn.textContent = `Importing… ${Math.min(i+100, valid.length)}/${valid.length}`;
    }
    note($("#csvMessage"), `Import complete. Added: ${added}. Skipped existing: ${skipped}. Invalid: ${invalid}.`);
    $("#csvPreview").hidden = true;
  } catch (err) {
    note($("#csvMessage"), `Import stopped: ${err.message}. You can safely upload the same CSV again; existing usernames will be skipped.`, true);
  } finally {
    btn.disabled = false; btn.textContent = "Confirm import"; 
  }
}
$("#exportCsv").addEventListener("click", () => {
  const rows = records.filter(r => !r.archived).map(r => [r.username,r.status,r.category,r.price]);
  const csvCell = v => `"${String(v ?? "").replace(/"/g,'""')}"`;
  const content = [["username","status","category","price"], ...rows].map(r => r.map(csvCell).join(",")).join("\r\n");
  const a = document.createElement("a"); a.href = URL.createObjectURL(new Blob([content], {type:"text/csv;charset=utf-8"})); a.download = "gramnames-inventory.csv"; a.click(); URL.revokeObjectURL(a.href);
});
onAuthStateChanged(auth, async user => {
  $("#loginPanel").hidden = true; $("#adminPanel").hidden = true;
  if (stopInventory) { stopInventory(); stopInventory = null; }
  if (!user) { $("#loginPanel").hidden = false; return; }
  try {
    const token = await getIdTokenResult(user, true);
    if (token.claims.admin !== true) {
      await signOut(auth);
      $("#loginPanel").hidden = false;
      note($("#loginMessage"), "This account is not authorized as an administrator.", true);
      return;
    }
    $("#adminPanel").hidden = false; $("#adminEmail").textContent = user.email || "Authorized administrator";
    stopInventory = onSnapshot(query(collection(db, "inventory"), orderBy("username")), snap => {
      records = snap.docs.map(d => ({id:d.id,...d.data()}));
      renderStats(); renderRows();
    }, err => { alert("Could not load inventory: " + err.message); });
  } catch (err) {
    await signOut(auth);
    $("#loginPanel").hidden = false;
    note($("#loginMessage"), "Could not verify admin access. Please sign in again.", true);
  }
});
