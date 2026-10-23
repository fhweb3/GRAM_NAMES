
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
  onSnapshot,
  query,
  orderBy,
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

const BATCH_SIZE = 400;

let records = [];
let stopInventory = null;
let importRows = [];
let importing = false;

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
  const priceText =
    input.price === "" || input.price == null ? "" : input.price;
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

function renderStats() {
  const active = records.filter(r => !r.archived);

  if ($("#statTotal")) $("#statTotal").textContent = active.length;
  if ($("#statAvailable")) {
    $("#statAvailable").textContent =
      active.filter(r => r.status === "available").length;
  }
  if ($("#statOffer")) {
    $("#statOffer").textContent =
      active.filter(r => r.status === "current offer").length;
  }
  if ($("#statSold")) {
    $("#statSold").textContent =
      active.filter(r => r.status === "sold").length;
  }

  const categories = [
    ...new Set(records.map(r => r.category).filter(Boolean))
  ].sort();

  if ($("#categoryList")) {
    $("#categoryList").innerHTML = categories
      .map(c => `<option value="${esc(c)}"></option>`)
      .join("");
  }
}

function renderRows() {
  if (!$("#adminRows")) return;

  const term = ($("#adminSearch")?.value || "").trim().toLowerCase();
  const status = $("#adminStatus")?.value || "";
  const showArchived = $("#showArchived")?.checked || false;

  const filtered = records.filter(r =>
    (showArchived || !r.archived) &&
    (!status || r.status === status) &&
    `${r.username} ${r.category}`.toLowerCase().includes(term)
  );

  $("#adminRows").innerHTML = filtered.length
    ? filtered.map(r => `
      <tr class="${r.archived ? "archived-row" : ""}">
        <td><strong>${esc(r.username)}</strong>
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
    : '<tr><td colspan="5">No matching usernames.</td></tr>';
}

function resetEditor() {
  $("#itemForm")?.reset();

  if ($("#editingKey")) $("#editingKey").value = "";
  if ($("#editorTitle")) {
    $("#editorTitle").textContent = "Add a username";
  }

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

/* CSV parser that supports quoted fields and commas inside quotes. */
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
      if (row.some(value => value !== "")) rows.push(row);

      row = [];
      cell = "";
    } else {
      cell += ch;
    }
  }

  row.push(cell.trim());
  if (row.some(value => value !== "")) rows.push(row);

  if (rows.length < 2) return [];

  const header = rows[0].map(v => v.toLowerCase().trim());
  const usernameIndex = header.indexOf("username");
  const statusIndex = header.indexOf("status");
  const categoryIndex = header.indexOf("category");
  const priceIndex = header.indexOf("price");

  if (
    usernameIndex < 0 ||
    statusIndex < 0 ||
    categoryIndex < 0 ||
    priceIndex < 0
  ) {
    throw new Error(
      "CSV must contain these columns: username, status, category, price."
    );
  }

  return rows.slice(1).map((cells, index) => ({
    username: cells[usernameIndex] || "",
    status: cells[statusIndex] || "",
    category: cells[categoryIndex] || "",
    price: cells[priceIndex] || "",
    row: index + 2
  }));
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
    note(
      $("#loginMessage"),
      "Sign-in failed. Check your email and password.",
      true
    );
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
      normalizeUsername(existing.username) !==
        normalizeUsername(payload.username)
    ) {
      throw new Error(
        "Username identity cannot be changed. Archive it and add a new entry."
      );
    }

    const ref = id
      ? doc(db, "inventory", id)
      : doc(db, "inventory", normalizeUsername(payload.username));

    if (id) {
      delete payload.archived;
      await updateDoc(ref, payload);
      note($("#itemMessage"), "Username updated.");
    } else {
      if (
        records.some(
          r =>
            normalizeUsername(r.username) ===
            normalizeUsername(payload.username)
        )
      ) {
        throw new Error("That username already exists.");
      }

      await setDoc(ref, {
        ...payload,
        createdAt: serverTimestamp()
      });

      note($("#itemMessage"), "Username added.");
    }

    resetEditor();
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
    if (b.dataset.action === "edit") fillEditor(r);

    if (
      b.dataset.action === "archive" &&
      confirm(`Archive ${r.username}?`)
    ) {
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
  } catch (err) {
    alert(err.message || "Action failed.");
  }
});

["#adminSearch", "#adminStatus", "#showArchived"].forEach(sel => {
  $(sel)?.addEventListener(
    sel === "#adminSearch" ? "input" : "change",
    renderRows
  );
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

  clearNote($("#csvMessage"));
  importRows = [];
});

$("#previewCsv")?.addEventListener("click", () => {
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
    note(
      $("#csvMessage"),
      "Choose a CSV file or paste CSV text first.",
      true
    );
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

    if (!/^[a-z0-9_]{1,64}$/.test(key)) {
      error = "Invalid username";
    } else if (!["available", "current offer", "sold"].includes(status)) {
      error = "Invalid status";
    } else if (!category || category.length > 80) {
      error = "Category required";
    } else if (
      price !== null &&
      (!Number.isFinite(price) || price < 0 || price > 100000000)
    ) {
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

  const existing = new Set(
    records.map(r => normalizeUsername(r.username))
  );

  const valid = importRows.filter(
    r => !r.error && !existing.has(normalizeUsername(r.username))
  );

  const invalid = importRows.filter(r => r.error).length;
  const existingSkipped = importRows.filter(
    r => !r.error && existing.has(normalizeUsername(r.username))
  ).length;

  $("#csvPreview").hidden = false;
  $("#csvPreview").innerHTML = `
    <p>
      ${valid.length} new rows ready;
      ${invalid} invalid or duplicate rows;
      ${existingSkipped} existing usernames skipped.
    </p>
    <div class="table-wrap">
      <table>
        <thead>
          <tr>
            <th>Row</th><th>Username</th><th>Status</th>
            <th>Category</th><th>Price</th><th>Result</th>
          </tr>
        </thead>
        <tbody>
          ${importRows.slice(0, 200).map(r => {
            const key = normalizeUsername(r.username);
            const result = r.error ||
              (existing.has(key) ? "Existing: skip" : "Ready");

            return `<tr>
              <td>${r.row}</td>
              <td>${esc(r.username)}</td>
              <td>${esc(r.status)}</td>
              <td>${esc(r.category)}</td>
              <td>${r.price == null ? "Price not set" : esc(r.price)}</td>
              <td>${esc(result)}</td>
            </tr>`;
          }).join("")}
        </tbody>
      </table>
    </div>
    ${importRows.length > 200
      ? `<p>Showing first 200 rows of ${importRows.length}.</p>`
      : ""}
    <button id="confirmImport" class="button button-primary"
      ${valid.length ? "" : "disabled"}>
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

    /*
     * Reserve usernames already in Firestore and within this import.
     * Batch writes avoid waiting for each individual username.
     */
    const reserved = new Set(
      records.map(r => normalizeUsername(r.username))
    );

    const queue = [];

    for (const r of valid) {
      const key = normalizeUsername(r.username);

      if (reserved.has(key)) continue;

      reserved.add(key);
      queue.push(r);
    }

    const total = queue.length;

    try {
      for (let start = 0; start < total; start += BATCH_SIZE) {
        const group = queue.slice(start, start + BATCH_SIZE);
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
            `Rows ${group[0].row}–${group[group.length - 1].row}: ${
              err.message || "Batch failed"
            }`
          );
        }

        processed += group.length;

        note(
          $("#csvMessage"),
          `Importing… ${processed}/${total} processed. ` +
          `Added: ${added}. Failed: ${failed}.`
        );

        button.textContent = `Processed ${processed}/${total}`;
      }

      const summary =
        `Import finished. Added: ${added}. ` +
        `Failed: ${failed}. Existing usernames were skipped.`;

      note(
        $("#csvMessage"),
        summary +
          (failures.length
            ? ` First errors: ${failures.slice(0, 3).join(" | ")}`
            : ""),
        failed > 0
      );

      if (failed > 0) {
        console.error("CSV import batch failures:", failures);
      }

      if (failed === 0) {
        $("#csvPreview").hidden = true;
      }
    } catch (err) {
      note(
        $("#csvMessage"),
        `Import stopped. Added so far: ${added}. ${err.message || "Unknown error"}`,
        true
      );
    } finally {
      importing = false;
      previewButton.disabled = false;
      clearButton.disabled = false;
      button.disabled = false;
      button.textContent = `Import finished: ${added} added`;
    }
  });
});

$("#exportCsv")?.addEventListener("click", () => {
  const rows = records
    .filter(r => !r.archived)
    .map(r => [r.username, r.status, r.category, r.price ?? ""]);

  const cell = v => `"${String(v ?? "").replace(/"/g, '""')}"`;

  const content = [["username", "status", "category", "price"], ...rows]
    .map(r => r.map(cell).join(","))
    .join("\r\n");

  const a = document.createElement("a");
  const url = URL.createObjectURL(
    new Blob([content], { type: "text/csv;charset=utf-8" })
  );

  a.href = url;
  a.download = "gramnames-inventory.csv";
  a.click();

  setTimeout(() => URL.revokeObjectURL(url), 1000);
});

onAuthStateChanged(auth, user => {
  if ($("#loginPanel")) $("#loginPanel").hidden = true;
  if ($("#adminPanel")) $("#adminPanel").hidden = true;

  if (stopInventory) {
    stopInventory();
    stopInventory = null;
  }

  if (!user) {
    if ($("#loginPanel")) $("#loginPanel").hidden = false;
    return;
  }

  stopInventory = onSnapshot(
    query(collection(db, "inventory"), orderBy("username")),
    snap => {
      records = snap.docs.map(d => ({ id: d.id, ...d.data() }));
      renderStats();
      renderRows();

      if ($("#adminPanel")) $("#adminPanel").hidden = false;
      if ($("#adminEmail")) {
        $("#adminEmail").textContent = user.email || "Administrator";
      }
    },
    async err => {
      console.error(err);
      await signOut(auth);

      if ($("#loginPanel")) $("#loginPanel").hidden = false;

      note(
        $("#loginMessage"),
        "Access denied or inventory unavailable. Check Firestore rules.",
        true
      );
    }
  );
});
