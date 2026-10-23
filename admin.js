
import { initializeApp } from "https://www.gstatic.com/firebasejs/11.6.0/firebase-app.js";

import {
  getAuth,
  signInWithEmailAndPassword,
  signOut,
  onAuthStateChanged
} from "https://www.gstatic.com/firebasejs/11.6.0/firebase-auth.js";

import {
  getFirestore,
  collection,
  query,
  orderBy,
  where,
  limit,
  startAfter,
  getDocs,
  getCountFromServer,
  doc,
  setDoc,
  updateDoc,
  serverTimestamp,
  writeBatch
} from "https://www.gstatic.com/firebasejs/11.6.0/firebase-firestore.js";

import { firebaseConfig } from "./firebase-config.js";

const app = initializeApp(firebaseConfig);
const auth = getAuth(app);
const db = getFirestore(app);
const $ = s => document.querySelector(s);

const PAGE_SIZE = 50;
const BATCH_SIZE = 400;
const IMPORT_CHECK_SIZE = 30;

let records = [];
let lastDocument = null;
let cursorStack = [];
let currentPage = 1;
let currentUser = null;
let archivedMode = false;
let loadingPage = false;
let importing = false;
let importRows = [];
let pageHasNext = false;

function esc(s = "") {
  return String(s).replace(/[&<>"']/g, c => ({
    "&": "&amp;",
    "<": "&lt;",
    ">": "&gt;",
    '"': "&quot;",
    "'": "&#39;"
  }[c]));
}

function note(el, msg, bad = false) {
  if (!el) return;
  el.hidden = false;
  el.textContent = msg;
  el.className = "notice" + (bad ? " error" : "");
}

function clearNote(el) {
  if (!el) return;
  el.hidden = true;
  el.textContent = "";
}

function normalizeUsername(v) {
  return String(v || "").trim().replace(/^@+/, "").toLowerCase();
}

function normalizeStatus(v) {
  const s = String(v || "")
    .trim()
    .toLowerCase()
    .replace(/[_-]+/g, " ")
    .replace(/\s+/g, " ");

  return s === "offer" ? "current offer" : s;
}

function validateItem(input) {
  const username = normalizeUsername(input.username);
  const status = normalizeStatus(input.status);
  const category = String(input.category || "").trim();
  const priceText = input.price === "" || input.price == null
    ? ""
    : input.price;
  const price = priceText === "" ? null : Number(priceText);

  if (!/^[a-z0-9_]{1,64}$/.test(username)) {
    throw new Error("Enter a valid username.");
  }

  if (!["available", "current offer", "sold"].includes(status)) {
    throw new Error("Choose a valid status.");
  }

  if (!category || category.length > 80) {
    throw new Error("Category is required (maximum 80 characters).");
  }

  if (
    price !== null &&
    (!Number.isFinite(price) || price < 0 || price > 100000000)
  ) {
    throw new Error("Price must be blank or a valid non-negative number.");
  }

  return {
    username: "@" + username,
    status,
    category,
    price,
    archived: false,
    updatedAt: serverTimestamp()
  };
}

/* Add pagination controls without editing admin.html. */
function setupPagination() {
  if ($("#inventoryPagination")) return;

  const table = $(".table-wrap");
  if (!table) return;

  const controls = document.createElement("div");
  controls.id = "inventoryPagination";
  controls.className = "button-row";
  controls.style.cssText =
    "display:flex;align-items:center;justify-content:center;gap:12px;padding:16px;";

  controls.innerHTML = `
    <button id="previousPage" class="button button-light" type="button">
      Previous
    </button>
    <span id="pageLabel">Page 1</span>
    <button id="nextPage" class="button button-light" type="button">
      Next
    </button>
  `;

  table.insertAdjacentElement("afterend", controls);

  $("#previousPage").addEventListener("click", async () => {
    if (loadingPage || currentPage <= 1) return;

    currentPage--;

    if (currentPage === 1) {
      lastDocument = null;
    } else {
      lastDocument = cursorStack[currentPage - 1] || null;
    }

    await loadPage();
  });

  $("#nextPage").addEventListener("click", async () => {
    if (loadingPage || !pageHasNext || !lastDocument) return;

    cursorStack[currentPage] = lastDocument;
    currentPage++;
    await loadPage();
  });

  updatePagination();
}

function updatePagination() {
  if ($("#pageLabel")) {
    $("#pageLabel").textContent = `Page ${currentPage}`;
  }

  if ($("#previousPage")) {
    $("#previousPage").disabled = loadingPage || currentPage <= 1;
  }

  if ($("#nextPage")) {
    $("#nextPage").disabled = loadingPage || !pageHasNext;
  }
}

function resetPagination() {
  currentPage = 1;
  lastDocument = null;
  cursorStack = [];
}

function baseQueryParts() {
  const parts = [];

  if (!archivedMode) {
    parts.push(where("archived", "==", false));
  }

  const status = $("#adminStatus")?.value || "";
  if (status) parts.push(where("status", "==", status));

  return parts;
}

async function loadPage() {
  if (loadingPage || !currentUser) return;

  loadingPage = true;
  pageHasNext = false;
  updatePagination();

  if ($("#adminRows")) {
    $("#adminRows").innerHTML =
      '<tr><td colspan="5">Loading this page…</td></tr>';
  }

  try {
    const parts = baseQueryParts();

    parts.push(orderBy("username"));

    if (currentPage > 1 && lastDocument) {
      parts.push(startAfter(lastDocument));
    }

    parts.push(limit(PAGE_SIZE + 1));

    const snap = await getDocs(query(collection(db, "inventory"), ...parts));
    const docs = [...snap.docs];

    pageHasNext = docs.length > PAGE_SIZE;

    if (pageHasNext) docs.pop();

    records = docs.map(d => ({
      id: d.id,
      ...d.data()
    }));

    lastDocument = docs.length ? docs[docs.length - 1] : null;

    renderRows();
    await renderStats();
  } catch (err) {
    console.error("Page load failed:", err);

    if ($("#adminRows")) {
      $("#adminRows").innerHTML =
        '<tr><td colspan="5">Could not load this page. Check connection and Firestore rules.</td></tr>';
    }

    note($("#itemMessage"), err.message || "Could not load inventory.", true);
  } finally {
    loadingPage = false;
    updatePagination();
  }
}

async function renderStats() {
  if (!currentUser) return;

  try {
    const count = async extra => {
      const parts = [];

      if (!archivedMode) {
        parts.push(where("archived", "==", false));
      }

      parts.push(...extra);

      const snap = await getCountFromServer(
        query(collection(db, "inventory"), ...parts)
      );

      return snap.data().count;
    };

    const [total, available, offer, sold] = await Promise.all([
      count([]),
      count([where("status", "==", "available")]),
      count([where("status", "==", "current offer")]),
      count([where("status", "==", "sold")])
    ]);

    if ($("#statTotal")) $("#statTotal").textContent = total;
    if ($("#statAvailable")) $("#statAvailable").textContent = available;
    if ($("#statOffer")) $("#statOffer").textContent = offer;
    if ($("#statSold")) $("#statSold").textContent = sold;
  } catch (err) {
    console.warn("Statistics unavailable:", err);
  }

  const categories = [...new Set(records.map(r => r.category).filter(Boolean))].sort();

  if ($("#categoryList")) {
    $("#categoryList").innerHTML = categories
      .map(c => `<option value="${esc(c)}"></option>`)
      .join("");
  }
}

function renderRows() {
  if (!$("#adminRows")) return;

  const term = ($("#adminSearch")?.value || "").trim().toLowerCase();

  /*
   * Search is intentionally limited to the 50 records currently loaded.
   * Use Next/Previous to browse additional pages.
   */
  const filtered = records.filter(r =>
    `${r.username} ${r.category}`.toLowerCase().includes(term)
  );

  $("#adminRows").innerHTML = filtered.length
    ? filtered.map(r => `
      <tr class="${r.archived ? "archived-row" : ""}">
        <td>
          <strong>${esc(r.username)}</strong>
          ${r.archived ? '<small class="archived-label">Archived</small>' : ""}
        </td>
        <td>
          <span class="status ${
            r.status === "available"
              ? "available"
              : r.status === "sold"
                ? "sold"
                : "offer"
          }">${esc(r.status)}</span>
        </td>
        <td>${esc(r.category)}</td>
        <td>${
          r.price == null || r.price === ""
            ? "Price not set"
            : "$" + Number(r.price).toFixed(2)
        }</td>
        <td>
          <div class="actions">
            ${r.archived
              ? `<button class="mini-button" data-action="restore" data-id="${esc(r.id)}">Restore</button>`
              : `<button class="mini-button" data-action="edit" data-id="${esc(r.id)}">Edit</button>
                 <button class="mini-button danger" data-action="archive" data-id="${esc(r.id)}">Archive</button>`
            }
          </div>
        </td>
      </tr>
    `).join("")
    : '<tr><td colspan="5">No matching usernames on this page.</td></tr>';
}

function resetEditor() {
  $("#itemForm")?.reset();

  if ($("#editingKey")) $("#editingKey").value = "";
  if ($("#editorTitle")) $("#editorTitle").textContent = "Add a username";

  clearNote($("#itemMessage"));
}

function fillEditor(r) {
  $("#editingKey").value = r.id;
  $("#itemUsername").value = r.username;
  $("#itemStatus").value = r.status;
  $("#itemCategory").value = r.category;
  $("#itemPrice").value = r.price ?? "";
  $("#editorTitle").textContent = "Edit username";

  window.scrollTo({ top: 0, behavior: "smooth" });
}

/* CSV parser supporting quoted fields and commas inside quotes. */
function parseCsv(text) {
  text = String(text || "").replace(/^\uFEFF/, "");

  const rows = [];
  let row = [];
  let cell = "";
  let quoted = false;

  for (let i = 0; i < text.length; i++) {
    const ch = text[i];

    if (quoted) {
      if (ch === '"' && text[i + 1] === '"') {
        cell += '"';
        i++;
      } else if (ch === '"') {
        quoted = false;
      } else {
        cell += ch;
      }
    } else if (ch === '"' && cell === "") {
      quoted = true;
    } else if (ch === ",") {
      row.push(cell.trim());
      cell = "";
    } else if (ch === "\n" || ch === "\r") {
      if (ch === "\r" && text[i + 1] === "\n") i++;

      row.push(cell.trim());

      if (row.some(v => v !== "")) rows.push(row);

      row = [];
      cell = "";
    } else {
      cell += ch;
    }
  }

  row.push(cell.trim());
  if (row.some(v => v !== "")) rows.push(row);

  if (rows.length < 2) return [];

  const header = rows[0].map(v => v.toLowerCase().trim());
  const ui = header.indexOf("username");
  const si = header.indexOf("status");
  const ci = header.indexOf("category");
  const pi = header.indexOf("price");

  if ([ui, si, ci, pi].some(i => i < 0)) {
    throw new Error("CSV needs username, status, category, and price columns.");
  }

  return rows.slice(1).map((cells, i) => ({
    username: cells[ui] || "",
    status: cells[si] || "",
    category: cells[ci] || "",
    price: cells[pi] || "",
    row: i + 2
  }));
}

/*
 * Check existing document IDs in groups of 30.
 * This avoids downloading the whole inventory to check duplicates.
 */
async function findExistingIds(ids) {
  const found = new Set();

  for (let i = 0; i < ids.length; i += IMPORT_CHECK_SIZE) {
    const group = ids.slice(i, i + IMPORT_CHECK_SIZE);

    const snap = await getDocs(
      query(
        collection(db, "inventory"),
        where("__name__", "in", group.map(id => id))
      )
    );

    snap.docs.forEach(d => found.add(d.id));
  }

  return found;
}

$("#loginForm")?.addEventListener("submit", async e => {
  e.preventDefault();
  clearNote($("#loginMessage"));

  try {
    await signInWithEmailAndPassword(
      auth,
      $("#email").value.trim(),
      $("#password").value
    );
  } catch {
    note($("#loginMessage"), "Sign-in failed. Check your email and password.", true);
  }
});

$("#signOut")?.addEventListener("click", () => signOut(auth));
$("#cancelEdit")?.addEventListener("click", resetEditor);

$("#itemForm")?.addEventListener("submit", async e => {
  e.preventDefault();
  clearNote($("#itemMessage"));

  try {
    const id = $("#editingKey").value;

    const payload = validateItem({
      username: $("#itemUsername").value,
      status: $("#itemStatus").value,
      category: $("#itemCategory").value,
      price: $("#itemPrice").value.trim()
    });

    const existing = records.find(r => r.id === id);

    if (
      id &&
      existing &&
      normalizeUsername(existing.username) !== normalizeUsername(payload.username)
    ) {
      throw new Error("Username identity cannot be changed. Archive it and add a new entry.");
    }

    const ref = id
      ? doc(db, "inventory", id)
      : doc(db, "inventory", normalizeUsername(payload.username));

    if (id) {
      delete payload.archived;
      await updateDoc(ref, payload);
      note($("#itemMessage"), "Username updated.");
    } else {
      const existingIds = await findExistingIds([
        normalizeUsername(payload.username)
      ]);

      if (existingIds.size) {
        throw new Error("That username already exists.");
      }

      await setDoc(ref, {
        ...payload,
        createdAt: serverTimestamp()
      });

      note($("#itemMessage"), "Username added.");
    }

    resetEditor();
    resetPagination();
    await loadPage();
  } catch (err) {
    note($("#itemMessage"), err.message || "Save failed.", true);
  }
});

$("#adminRows")?.addEventListener("click", async e => {
  const b = e.target.closest("[data-action]");
  if (!b) return;

  const r = records.find(x => x.id === b.dataset.id);
  if (!r) return;

  try {
    if (b.dataset.action === "edit") {
      fillEditor(r);
      return;
    }

    if (b.dataset.action === "archive" && confirm(`Archive ${r.username}?`)) {
      await updateDoc(doc(db, "inventory", r.id), {
        archived: true,
        updatedAt: serverTimestamp()
      });
    }

    if (b.dataset.action === "restore") {
      await updateDoc(doc(db, "inventory", r.id), {
        archived: false,
        updatedAt: serverTimestamp()
      });
    }

    await loadPage();
  } catch (err) {
    alert(err.message || "Action failed.");
  }
});

$("#adminSearch")?.addEventListener("input", renderRows);

$("#adminStatus")?.addEventListener("change", async () => {
  resetPagination();
  await loadPage();
});

$("#showArchived")?.addEventListener("change", async e => {
  archivedMode = e.target.checked;
  resetPagination();
  await loadPage();
});

$("#csvFile")?.addEventListener("change", async e => {
  const file = e.target.files?.[0];
  if (!file) return;

  try {
    $("#csvText").value = await file.text();
    clearNote($("#csvMessage"));
  } catch {
    note($("#csvMessage"), "Could not read this CSV file.", true);
  }
});

$("#clearCsv")?.addEventListener("click", () => {
  if (importing) {
    note($("#csvMessage"), "Wait for the current import to finish.", true);
    return;
  }

  if ($("#csvFile")) $("#csvFile").value = "";
  if ($("#csvText")) $("#csvText").value = "";

  if ($("#csvPreview")) {
    $("#csvPreview").hidden = true;
    $("#csvPreview").innerHTML = "";
  }

  importRows = [];
  clearNote($("#csvMessage"));
});

$("#previewCsv")?.addEventListener("click", async () => {
  if (importing) return;

  clearNote($("#csvMessage"));

  let parsed;

  try {
    parsed = parseCsv($("#csvText")?.value || "");
  } catch (err) {
    note($("#csvMessage"), err.message, true);
    return;
  }

  if (!parsed.length) {
    note($("#csvMessage"), "Choose a CSV file or paste CSV text first.", true);
    return;
  }

  const seen = new Set();

  importRows = parsed.map(r => {
    let error = "";
    const key = normalizeUsername(r.username);
    const status = normalizeStatus(r.status);
    const category = String(r.category || "").trim();
    const priceText = String(r.price ?? "").trim();
    const price = priceText === "" ? null : Number(priceText);

    if (!/^[a-z0-9_]{1,64}$/.test(key)) error = "Invalid username";
    else if (!["available", "current offer", "sold"].includes(status)) error = "Invalid status";
    else if (!category || category.length > 80) error = "Category required";
    else if (price !== null && (!Number.isFinite(price) || price < 0 || price > 100000000)) {
      error = "Invalid price";
    } else if (seen.has(key)) {
      error = "Duplicate in CSV";
    }

    if (key) seen.add(key);

    return {
      username: key ? "@" + key : r.username,
      status,
      category,
      price,
      row: r.row,
      error
    };
  });

  const invalid = importRows.filter(r => r.error).length;

  note($("#csvMessage"), "Checking existing usernames…");

  try {
    const candidates = importRows.filter(r => !r.error);
    const ids = [...new Set(candidates.map(r => normalizeUsername(r.username)))];
    const existing = await findExistingIds(ids);

    const valid = candidates.filter(
      r => !existing.has(normalizeUsername(r.username))
    );

    const existingSkipped = candidates.length - valid.length;

    $("#csvPreview").hidden = false;
    $("#csvPreview").innerHTML = `
      <p>${valid.length} new rows ready; ${invalid} invalid/duplicate rows; ${existingSkipped} existing usernames skipped.</p>
      <div class="table-wrap">
        <table>
          <thead><tr><th>Row</th><th>Username</th><th>Status</th><th>Category</th><th>Price</th><th>Result</th></tr></thead>
          <tbody>
            ${importRows.slice(0, 200).map(r => {
              const id = normalizeUsername(r.username);
              return `<tr>
                <td>${r.row}</td>
                <td>${esc(r.username)}</td>
                <td>${esc(r.status)}</td>
                <td>${esc(r.category)}</td>
                <td>${r.price == null ? "Price not set" : esc(r.price)}</td>
                <td>${esc(r.error || (existing.has(id) ? "Existing: skip" : "Ready"))}</td>
              </tr>`;
            }).join("")}
          </tbody>
        </table>
      </div>
      ${importRows.length > 200 ? `<p>Showing the first 200 of ${importRows.length} rows.</p>` : ""}
      <button id="confirmImport" class="button button-primary" ${valid.length ? "" : "disabled"}>
        Import ${valid.length} usernames
      </button>
    `;

    $("#confirmImport")?.addEventListener("click", async () => {
      if (importing) return;

      importing = true;

      const button = $("#confirmImport");
      const previewButton = $("#previewCsv");
      const clearButton = $("#clearCsv");

      button.disabled = true;
      previewButton.disabled = true;
      clearButton.disabled = true;

      let added = 0;
      let failed = 0;
      let processed = 0;
      const failures = [];

      try {
        /*
         * Recheck existing document IDs immediately before writing.
         * This reduces accidental overwrites if inventory changed since preview.
         */
        const ids = valid.map(r => normalizeUsername(r.username));
        const existingNow = await findExistingIds(ids);
        const queue = valid.filter(
          r => !existingNow.has(normalizeUsername(r.username))
        );

        const total = queue.length;

        for (let i = 0; i < total; i += BATCH_SIZE) {
          const group = queue.slice(i, i + BATCH_SIZE);
          const batch = writeBatch(db);

          for (const r of group) {
            const payload = validateItem(r);
            const id = normalizeUsername(payload.username);

            batch.set(doc(db, "inventory", id), {
              ...payload,
              createdAt: serverTimestamp()
            });
          }

          try {
            await batch.commit();
            added += group.length;
          } catch (err) {
            failed += group.length;
            failures.push(
              `Rows ${group[0].row}–${group[group.length - 1].row}: ${err.message || "Batch failed"}`
            );
          }

          processed += group.length;

          note(
            $("#csvMessage"),
            `Importing… ${processed}/${total}. Added: ${added}. Failed: ${failed}.`
          );

          button.textContent = `Processed ${processed}/${total}`;
        }

        note(
          $("#csvMessage"),
          `Import finished. Added: ${added}. Failed: ${failed}. ` +
          (failures.length ? `First error: ${failures[0]}` : ""),
          failed > 0
        );

        if (failed === 0) $("#csvPreview").hidden = true;

        resetPagination();
        await loadPage();
      } catch (err) {
        note($("#csvMessage"), `Import failed: ${err.message || "Unknown error"}`, true);
      } finally {
        importing = false;
        previewButton.disabled = false;
        clearButton.disabled = false;
        button.disabled = false;
        button.textContent = `Import finished: ${added} added`;
      }
    });
  } catch (err) {
    note($("#csvMessage"), `Could not check existing usernames: ${err.message || "Unknown error"}`, true);
  }
});

$("#exportCsv")?.addEventListener("click", async () => {
  const button = $("#exportCsv");
  button.disabled = true;

  try {
    note($("#itemMessage"), "Preparing inventory export…");

    const rows = [];
    let cursor = null;

    while (true) {
      const parts = [
        where("archived", "==", false),
        orderBy("username"),
        limit(PAGE_SIZE)
      ];

      if (cursor) parts.splice(2, 0, startAfter(cursor));

      const snap = await getDocs(query(collection(db, "inventory"), ...parts));

      if (snap.empty) break;

      snap.docs.forEach(d => {
        const r = d.data();
        rows.push([r.username, r.status, r.category, r.price ?? ""]);
      });

      cursor = snap.docs[snap.docs.length - 1];
      if (snap.docs.length < PAGE_SIZE) break;
    }

    const cell = v => `"${String(v ?? "").replace(/"/g, '""')}"`;

    const content = [["username", "status", "category", "price"], ...rows]
      .map(r => r.map(cell).join(","))
      .join("\r\n");

    const url = URL.createObjectURL(
      new Blob([content], { type: "text/csv;charset=utf-8" })
    );

    const a = document.createElement("a");
    a.href = url;
    a.download = "gramnames-inventory.csv";
    a.click();

    setTimeout(() => URL.revokeObjectURL(url), 1000);

    note($("#itemMessage"), `Exported ${rows.length} active usernames.`);
  } catch (err) {
    note($("#itemMessage"), `Export failed: ${err.message || "Unknown error"}`, true);
  } finally {
    button.disabled = false;
  }
});

onAuthStateChanged(auth, async user => {
  currentUser = user;

  if ($("#loginPanel")) $("#loginPanel").hidden = true;
  if ($("#adminPanel")) $("#adminPanel").hidden = true;

  if (!user) {
    records = [];
    if ($("#loginPanel")) $("#loginPanel").hidden = false;
    return;
  }

  setupPagination();

  if ($("#adminPanel")) $("#adminPanel").hidden = false;
  if ($("#adminEmail")) {
    $("#adminEmail").textContent = user.email || "Administrator";
  }

  archivedMode = $("#showArchived")?.checked || false;
  resetPagination();
  await loadPage();
});
