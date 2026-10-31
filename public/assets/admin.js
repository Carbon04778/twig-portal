// Donnell's admin panel. All content is built with textContent (no innerHTML), so names and
// emails can't inject markup.
const $ = (id) => document.getElementById(id);

function el(tag, attrs = {}, ...children) {
  const node = document.createElement(tag);
  for (const [k, v] of Object.entries(attrs)) {
    if (k === "class") node.className = v;
    else if (k.startsWith("on")) node.addEventListener(k.slice(2), v);
    else if (k === "checked" || k === "selected" || k === "disabled") node[k] = !!v;
    else if (v != null && v !== false) node.setAttribute(k, v);
  }
  for (const c of children) if (c != null) node.append(c);
  return node;
}

function toast(text, error = false) {
  const t = el("div", { class: `toast ${error ? "error" : ""}`, role: "status" }, text);
  document.body.append(t);
  setTimeout(() => t.remove(), 3500);
}

async function api(path, init = {}) {
  const res = await fetch(`/api/admin${path}`, {
    credentials: "same-origin", headers: { "content-type": "application/json" }, ...init,
    body: init.body === undefined ? undefined : JSON.stringify(init.body),
  });
  const body = await res.json().catch(() => ({}));
  if (!res.ok) {
    const msg = body.message || body.issues?.map((i) => `${i.path}: ${i.message}`).join("; ") || body.error || `Error ${res.status}`;
    toast(msg, true);
    throw new Error(msg);
  }
  return body;
}

const date = (d) => (d ? new Date(d).toLocaleDateString(undefined, { day: "numeric", month: "short", year: "numeric" }) : "");
const dateTime = (d) => (d ? new Date(d).toLocaleString(undefined, { day: "numeric", month: "short", hour: "2-digit", minute: "2-digit" }) : "");
const ROLE_LABEL = { public: "Free", student: "Student", admin: "Admin" };

let appsCache = [];

// ---- Tabs ------------------------------------------------------------------------------
const loaders = { users: loadUsers, codes: loadCodes, apps: loadApps, activity: loadActivity };
document.querySelectorAll(".tabs button").forEach((b) => b.addEventListener("click", () => {
  document.querySelectorAll(".tabs button").forEach((x) => x.classList.toggle("active", x === b));
  for (const name of Object.keys(loaders)) $(`tab-${name}`).hidden = name !== b.dataset.tab;
  loaders[b.dataset.tab]();
}));

// ---- Users -----------------------------------------------------------------------------
async function loadUsers() {
  if (!appsCache.length) appsCache = (await api("/apps")).data;
  const f = new FormData($("user-filters"));
  const qs = new URLSearchParams([...f].filter(([, v]) => v));
  const { data, total } = await api(`/users?${qs}`);
  $("user-count").textContent = `${total} user${total === 1 ? "" : "s"}`;
  $("users").replaceChildren(...data.map(userRow));
  if (!data.length) $("users").append(el("tr", {}, el("td", { colspan: 5, class: "muted" }, "No users yet.")));
}

function userRow(u) {
  const isAdmin = u.role === "admin";
  const role = el("select", {
    disabled: isAdmin, "aria-label": "Role",
    onchange: async (e) => { await api(`/users/${u.id}`, { method: "PATCH", body: { role: e.target.value } }); toast("Saved"); loadUsers(); },
  }, ...(isAdmin ? [el("option", { selected: true }, "Admin")] : ["public", "student"].map((r) =>
    el("option", { value: r, selected: u.role === r }, ROLE_LABEL[r]))));

  // Per-app exceptions: a one-line summary, with a tidy list behind a "Change" button.
  // Admins always open every app, so they get no controls.
  const overrides = u.appOverrides ?? {};
  const nameOf = (id) => appsCache.find((a) => a.id === id)?.name ?? id;
  const blocked = Object.keys(overrides).filter((id) => overrides[id] === false).map(nameOf);
  const allowed = Object.keys(overrides).filter((id) => overrides[id] === true).map(nameOf);
  const summary = [blocked.length ? `Blocked: ${blocked.join(", ")}` : "", allowed.length ? `Always allowed: ${allowed.join(", ")}` : ""]
    .filter(Boolean).join(" · ") || "None";

  let exceptions;
  if (isAdmin) {
    exceptions = el("span", { class: "muted small" }, "All apps (admin)");
  } else {
    const list = el("div", { class: "exceptions", hidden: true });
    for (const a of appsCache) {
      const v = overrides[a.id];
      list.append(el("span", {}, a.name), el("select", {
        "aria-label": `${a.name} access`,
        onchange: async (e) => {
          const allowed = e.target.value === "" ? null : e.target.value === "allow";
          await api(`/users/${u.id}/apps/${a.id}`, { method: "PUT", body: { allowed } });
          toast("Saved");
          loadUsers();
        },
      },
      el("option", { value: "", selected: v === undefined }, "Normal"),
      el("option", { value: "allow", selected: v === true }, "Always allow"),
      el("option", { value: "block", selected: v === false }, "Block")));
    }
    exceptions = el("div", { class: "small" },
      el("span", {}, summary), " ",
      el("button", { class: "btn small ghost", onclick: () => { list.hidden = !list.hidden; } }, "Change"),
      list);
  }

  const revoked = u.status === "revoked";
  const toggle = isAdmin ? "" : el("button", {
    class: `btn small ${revoked ? "" : "danger"}`,
    onclick: async () => {
      if (!revoked && !confirm(`Switch off all access for ${u.email}?`)) return;
      await api(`/users/${u.id}`, { method: "PATCH", body: { status: revoked ? "active" : "revoked" } });
      toast(revoked ? "Access restored" : "Access switched off");
      loadUsers();
    },
  }, revoked ? "Restore" : "Revoke");

  return el("tr", { class: revoked ? "dim" : "" },
    el("td", {}, el("strong", {}, u.name || "(no name)"), el("div", { class: "muted small" }, u.email),
      revoked ? el("div", { class: "small", style: "color:var(--danger)" }, "Access revoked") : null),
    el("td", {}, role, u.studentSince ? el("div", { class: "muted small" }, `student since ${date(u.studentSince)}`) : null),
    el("td", {}, exceptions),
    el("td", { class: "small" }, dateTime(u.lastSeenAt)),
    el("td", {}, toggle));
}
$("user-filters").addEventListener("submit", (e) => { e.preventDefault(); loadUsers(); });

// ---- Student codes ---------------------------------------------------------------------
async function loadCodes() {
  const { data } = await api("/promo-codes");
  $("codes").replaceChildren(...data.map((p) => {
    const expired = p.expiresAt && new Date(p.expiresAt) <= new Date();
    const usedUp = p.maxUses !== null && p.uses >= p.maxUses;
    const status = p.revokedAt ? "Revoked" : expired ? "Expired" : usedUp ? "Used up" : "Active";
    return el("tr", { class: status === "Active" ? "" : "dim" },
      el("td", {}, el("strong", { style: "letter-spacing:.06em" }, p.code)),
      el("td", {}, p.label),
      el("td", {}, el("a", { href: "#", onclick: (e) => { e.preventDefault(); showRedemptions(p); } },
        `${p.uses}${p.maxUses ? ` / ${p.maxUses}` : ""}`)),
      el("td", {}, date(p.expiresAt) || "never"),
      el("td", {}, status),
      el("td", {}, p.revokedAt ? "" : el("button", {
        class: "btn small danger",
        onclick: async () => {
          if (!confirm(`Stop code ${p.code} from working? Students who already used it keep their access.`)) return;
          await api(`/promo-codes/${p.id}/revoke`, { method: "POST", body: {} });
          loadCodes();
        },
      }, "Revoke")));
  }));
  if (!data.length) $("codes").append(el("tr", {}, el("td", { colspan: 6, class: "muted" }, "No codes yet.")));
}

async function showRedemptions(p) {
  const { data } = await api(`/promo-codes/${p.id}/redemptions`);
  $("redemptions").replaceChildren(el("div", { class: "card", style: "margin-top:14px" },
    el("strong", {}, `Used by (${p.code})`),
    data.length ? el("ul", {}, ...data.map((r) => el("li", {}, `${r.name || r.email} (${r.email}), ${dateTime(r.redeemedAt)}`)))
      : el("p", { class: "muted" }, "Nobody has used this code yet.")));
}

$("code-form").addEventListener("submit", async (e) => {
  e.preventDefault();
  const f = new FormData(e.target);
  const body = {
    label: f.get("label") || "",
    ...(f.get("code") ? { code: f.get("code") } : {}),
    max_uses: f.get("max_uses") ? Number(f.get("max_uses")) : null,
    // End of the chosen day, local time.
    expires_at: f.get("expires_at") ? new Date(`${f.get("expires_at")}T23:59:59`).toISOString() : null,
  };
  const { data } = await api("/promo-codes", { method: "POST", body });
  e.target.reset();
  toast(`Code ${data.code} created`);
  loadCodes();
});

// ---- Apps ------------------------------------------------------------------------------
async function loadApps() {
  appsCache = (await api("/apps")).data;
  $("apps").replaceChildren(...appsCache.map((a) => {
    const patch = async (body) => { await api(`/apps/${a.id}`, { method: "PATCH", body }); toast("Saved"); loadApps(); };
    const edit = async () => {
      const name = prompt("App name", a.name);
      if (name === null) return;
      const description = prompt("Short description (shown on the tile)", a.description);
      if (description === null) return;
      const url = prompt("Address (https://….replit.app)", a.url);
      if (url === null) return;
      await patch({ name: name.trim(), description: description.trim(), url: url.trim() });
    };
    return el("tr", { class: a.enabled ? "" : "dim" },
      el("td", {}, el("input", {
        type: "number", value: a.sortOrder, style: "width:4.5em", "aria-label": "Order",
        onchange: (e) => patch({ sort_order: Number(e.target.value) || 0 }),
      })),
      el("td", {}, el("strong", {}, a.name), el("div", { class: "muted small" }, a.id), el("div", { class: "small" }, a.description),
        el("button", { class: "btn small ghost", style: "margin-top:6px", onclick: edit }, "Edit")),
      el("td", { class: "small" }, el("a", { href: a.url, target: "_blank", rel: "noopener" }, a.url.replace(/^https:\/\//, ""))),
      el("td", {}, el("input", { type: "checkbox", checked: a.publicAccess, "aria-label": "Free for everyone", onchange: (e) => patch({ public_access: e.target.checked }) })),
      el("td", {}, el("input", { type: "checkbox", checked: a.enabled, "aria-label": "Switched on", onchange: (e) => patch({ enabled: e.target.checked }) })),
      el("td", { class: "small" }, a.hasSecret ? `connected (${a.secretPrefix}…)` : "not connected yet"),
      el("td", {}, el("button", {
        class: "btn small ghost",
        onclick: async () => {
          if (a.hasSecret && !confirm(`Make a new connection secret for ${a.name}? The app stops accepting sign-ins until its PORTAL_APP_SECRET is updated.`)) return;
          const { data } = await api(`/apps/${a.id}/secret`, { method: "POST", body: {} });
          $("secret-box").replaceChildren(el("div", { class: "card", style: "margin-top:14px" },
            el("strong", {}, `Connection secret for ${a.name}`),
            el("p", { class: "small muted" }, "Copy it now: it is shown only once. Put it in that app's Secrets as PORTAL_APP_SECRET."),
            el("div", { class: "secret" }, data.secret),
            el("button", { class: "btn small", onclick: async () => { await navigator.clipboard.writeText(data.secret); toast("Copied"); } }, "Copy")));
          loadApps();
        },
      }, a.hasSecret ? "New secret" : "Connect")));
  }));
  if (!appsCache.length) $("apps").append(el("tr", {}, el("td", { colspan: 7, class: "muted" }, "No apps yet. Add one below.")));
}

$("app-form").addEventListener("submit", async (e) => {
  e.preventDefault();
  const f = new FormData(e.target);
  await api("/apps", {
    method: "POST",
    body: {
      id: f.get("id"), name: f.get("name"), url: f.get("url"), description: f.get("description") || "",
      sort_order: Number(f.get("sort_order") || 0), public_access: f.get("public_access") === "on",
    },
  });
  e.target.reset();
  toast("App added");
  loadApps();
});

// ---- Activity --------------------------------------------------------------------------
async function loadActivity() {
  const { data } = await api("/audit");
  $("activity").replaceChildren(...data.map((a) => el("tr", {},
    el("td", { class: "small" }, dateTime(a.at)), el("td", {}, a.action), el("td", {}, a.target ?? ""),
    el("td", { class: "small muted" }, a.detail ?? ""))));
}

// ---- Start -----------------------------------------------------------------------------
(async () => {
  try { await window.twigClerk(); } catch (err) { console.error(err); }
  const res = await fetch("/api/me", { credentials: "same-origin" });
  $("loading").hidden = true;
  if (res.status === 401) { location.href = "/"; return; }
  const me = await res.json();
  if (me.user?.role !== "admin") {
    $("message").replaceChildren(el("div", { class: "notice error" }, "This page is for Twig admins only."));
    return;
  }
  $("who-name").textContent = me.user.name || me.user.email;
  $("admin").hidden = false;
  loadUsers();
})();
