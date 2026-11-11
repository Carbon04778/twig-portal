// Student-facing page: sign in, see app cards, redeem a student code, open apps.
const $ = (id) => document.getElementById(id);
const params = new URLSearchParams(location.search);

function el(tag, attrs = {}, ...children) {
  const node = document.createElement(tag);
  for (const [k, v] of Object.entries(attrs)) {
    if (k === "class") node.className = v;
    else if (v !== false && v != null) node.setAttribute(k, v === true ? "" : v);
  }
  for (const c of children) if (c != null) node.append(c);
  return node;
}

const SVG_NS = "http://www.w3.org/2000/svg";
const ICONS = {
  arrow: ["M5 12h14", "M13 6l6 6-6 6"],
  lock: ["M7 11V8a5 5 0 0 1 10 0v3", "M5 11h14v10H5z"],
};
function icon(name, size = 16) {
  const svg = document.createElementNS(SVG_NS, "svg");
  for (const [k, v] of Object.entries({
    viewBox: "0 0 24 24", width: size, height: size, fill: "none", stroke: "currentColor",
    "stroke-width": 2.25, "stroke-linecap": "round", "stroke-linejoin": "round", "aria-hidden": "true",
  })) svg.setAttribute(k, v);
  for (const d of ICONS[name]) {
    const path = document.createElementNS(SVG_NS, "path");
    path.setAttribute("d", d);
    svg.append(path);
  }
  return svg;
}

function showMessage(text, kind = "") {
  $("message").replaceChildren(text ? el("div", { class: `notice ${kind}` }, text) : "");
}

// Only follow "next" to our own launch URLs (no open redirects).
function safeNext() {
  const next = params.get("next");
  return next && /^\/launch\/[a-z0-9-]+$/.test(next) ? next : null;
}

async function api(path, init) {
  const res = await fetch(path, { credentials: "same-origin", headers: { "content-type": "application/json" }, ...init });
  const body = await res.json().catch(() => ({}));
  return { status: res.status, body };
}

// ---- Card design for each Twig app -----------------------------------------------------
// Colours and symbols for the six main apps live here, keyed by the app's ID in Admin → Apps.
// The wording comes from the server and is edited in Admin → Page text.
const APP_DESIGN = {
  paper1: { n: 1, symbol: "Pm", colors: ["#D9412F", "#F28C4A"], on: "#FFFFFF", chip: ["#A23A21", "#FBE5DC"] },
  "alevel-mcq": { n: 2, symbol: "Mq", colors: ["#EBC65E", "#8FD68F"], on: "#2A345E", chip: ["#3F6B22", "#E6F2D8"] },
  worksheets: { n: 3, symbol: "Tp", colors: ["#6474F0", "#D673C3"], on: "#FFFFFF", chip: ["#5B3FB0", "#ECE6FA"] },
  "question-bank": { n: 4, symbol: "Eh", colors: ["#4FCFC0", "#B6E57E"], on: "#2A345E", chip: ["#1F6E64", "#DDF3EF"] },
  definitions: { n: 5, symbol: "Dh", colors: ["#FF8FA3", "#FFD07A"], on: "#2A345E", chip: ["#A8324F", "#FDE3E8"] },
  review: { n: 6, symbol: "Ms", colors: ["#5B4BDB", "#3A9BE8"], on: "#FFFFFF", chip: ["#2A345E", "#EDE6D8"] },
};

// Look for any other app: initials from its name and a calm navy-family colour.
const EXTRA_COLORS = [["#273561", "#4F63B5"], ["#2F6B47", "#8FD68F"], ["#7A4BB0", "#C98BD9"]];
function extraDesign(app, index) {
  const words = app.name.trim().split(/\s+/);
  const second = words[1]?.[0] ?? words[0]?.[1] ?? "";
  return {
    n: 7 + index, symbol: (words[0]?.[0] ?? "?").toUpperCase() + second.toLowerCase(),
    colors: EXTRA_COLORS[index % EXTRA_COLORS.length], on: "#FFFFFF", chip: ["#2A345E", "#EDE6D8"],
  };
}

let paymentOn = false; // changes the wording on locked cards

function appCard(app, design, { wide = false } = {}) {
  const locked = !app.canOpen;
  const attrs = { class: `app-card${wide ? " wide" : ""}${locked ? " locked" : ""}` };
  if (locked) { attrs["aria-disabled"] = "true"; attrs.title = paymentOn ? "Enter a student code or pay to unlock this app" : "Enter a student code to unlock this app"; }
  else attrs.href = `/launch/${encodeURIComponent(app.id)}`;
  const card = el(locked ? "div" : "a", attrs);
  if (design.chip) { card.style.setProperty("--chip-fg", design.chip[0]); card.style.setProperty("--chip-bg", design.chip[1]); }

  const art = el("div", { class: "tile-art", "aria-hidden": "true" },
    el("span", { class: "tile-num" }, String(design.n)),
    el("span", { class: "tile-sym" }, design.symbol),
    el("div", { class: "tile-foot" }, el("span", { class: "tile-label" }, design.label), el("span", {}, String(design.n).padStart(2, "0"))),
  );
  art.style.setProperty("--g1", design.colors[0]);
  art.style.setProperty("--g2", design.colors[1]);
  art.style.setProperty("--on-art", design.on);

  const go = locked
    ? el("span", { class: "go lock" }, icon("lock", 15), "Students only")
    : el("span", { class: "go" }, design.cta ?? "Open", icon("arrow"));

  if (wide) {
    card.append(art, el("div", { class: "wide-text" }, el("h3", {}, design.title), el("p", {}, design.text)), go);
  } else {
    card.append(art, el("div", { class: "app-body" },
      el("div", { class: "app-text" }, el("h3", {}, design.title), el("p", {}, design.text)),
      el("div", { class: "app-foot" }, el("div", { class: "chips" }, ...(design.tags ?? []).map((t) => el("span", { class: "chip" }, t))), go),
    ));
  }
  return card;
}

function renderSections(apps, content) {
  const byId = new Map(apps.map((a) => [a.id, a]));
  // One grid of same-size cards, in the sections' order (no headings).
  const cards = [];
  let extras = 0;
  for (const s of content.sections) {
    for (const a of s.ids.map((id) => byId.get(id)).filter(Boolean)) {
      const look = APP_DESIGN[a.id] ?? extraDesign(a, extras++);
      cards.push(appCard(a, { tags: [], ...look, ...content.apps[a.id] }));
    }
  }
  $("sections").replaceChildren(cards.length
    ? el("div", { class: "cards" }, ...cards)
    : el("p", { class: "muted" }, "No apps are available yet."));
}

// ---- Page states -----------------------------------------------------------------------
const ROLE_PILL = {
  student: "Student · full access to every app",
  admin: "Admin · open every app and manage access",
  public: "Free account · enter a student code to unlock every app",
};

function initials(user) {
  const source = (user.name || user.email || "").trim();
  if (!source) return "?";
  const parts = source.includes("@") ? [source] : source.split(/\s+/);
  return (parts.length > 1 ? parts[0][0] + parts[1][0] : parts[0].slice(0, 2)).toUpperCase();
}

function showHome() {
  $("loading").hidden = true;
  $("signed-out").hidden = true;
  $("signed-in").hidden = false;
}

const longDate = (d) => new Date(d).toLocaleDateString("en-SG", { day: "numeric", month: "short", year: "numeric" });
const money = (cents, currency) => `${currency === "SGD" ? "S$" : `${currency} `}${(cents / 100).toFixed(cents % 100 ? 2 : 0)}`;

function renderPayBox(payment, user) {
  const offer = payment?.offer;
  paymentOn = !!offer;
  $("pay-box").hidden = !offer;
  if (!offer) return;
  $("pay-title").textContent = user.paidUntil && user.role === "student" ? "Renew your full access" : "Get full access to every app";
  $("pay-price").textContent = money(offer.priceCents, offer.currency);
  $("pay-was").textContent = offer.compareAtCents > offer.priceCents ? money(offer.compareAtCents, offer.currency) : "";
  $("pay-period").textContent = `for ${offer.months} months. One-time payment.`;
  $("pay-refund").textContent = offer.refundPolicy;
}

function showProfileForm(data) {
  showHome();
  $("home-content").hidden = true;
  $("profile-view").hidden = false;
  $("who-id").hidden = false;
  $("who-name").textContent = data.user.name || data.user.email;
  $("avatar").textContent = initials(data.user);
  $("admin-link").hidden = true;
  const options = (list, prompt) => [el("option", { value: "", selected: true, disabled: true }, prompt), ...list.map((v) => el("option", { value: v }, v))];
  $("pf-level").replaceChildren(...options(data.profileForm.levels, "Choose your level"));
  $("pf-exam-year").replaceChildren(...options(data.profileForm.examYears, "Choose your exam year"));
  $("pf-heard").replaceChildren(...options(data.profileForm.heardFrom, "Choose one"));
  $("pf-consent").textContent = data.profileForm.consent;
  if (!$("pf-name").value) $("pf-name").value = data.user.name ?? "";
}

function render({ user, apps, content, payment }) {
  showHome();
  $("profile-view").hidden = true;
  $("home-content").hidden = false;
  $("who-id").hidden = false;
  $("intro-text").textContent = content.intro;
  renderPayBox(payment, user);
  $("who-name").textContent = user.name || user.email;
  $("avatar").textContent = initials(user);
  $("admin-link").hidden = user.role !== "admin";
  $("hello").textContent = `Hi ${user.name ? user.name.split(" ")[0] : "there"}!`;
  $("role-pill").className = `pill ${user.role}`;
  $("role-pill-text").textContent = user.paidUntil && user.role === "student"
    ? `Full access to every app until ${longDate(user.paidUntil)}`
    : ROLE_PILL[user.role] ?? "";
  $("code-form").hidden = user.role !== "public";

  const denied = params.get("denied");
  if (denied) {
    const name = apps.find((a) => a.id === denied)?.name ?? "that app";
    showMessage(`Your account doesn't have access to ${name}${user.role === "public" ? ". Enter a student code to unlock it." : "."}`, "error");
    // Show it once: drop ?denied= so a later update (like redeeming a code) doesn't bring it back.
    params.delete("denied");
    const rest = params.toString();
    history.replaceState(null, "", location.pathname + (rest ? `?${rest}` : "") + location.hash);
  }
  renderSections(apps, content);
}

// Back from HitPay. The portal asks HitPay itself, so this page only reports what it was told.
// Payment can take a few seconds to clear, so ask a few times before giving up.
async function finishPayment(reference, announce) {
  for (let attempt = 0; attempt < (announce ? 6 : 1); attempt++) {
    if (attempt) await new Promise((r) => setTimeout(r, 2500));
    const { status, body } = await api("/api/pay/check", { method: "POST", body: JSON.stringify({ reference }) });
    if (status !== 200) break;
    if (body.status === "completed") {
      if (announce || attempt === 0) showMessage("Payment received. Every app is now unlocked.", "ok");
      return render(body);
    }
  }
  if (announce) showMessage("We haven't received your payment yet. If you paid, it should show here shortly. Refresh this page in a minute, or WhatsApp us if it doesn't.");
}

async function loadMe() {
  const { status, body } = await api("/api/me");
  if (status === 200) {
    if (body.profileRequired) return showProfileForm(body);
    const next = safeNext();
    if (next) return location.replace(next);
    render(body);
    const returned = params.get("payment");
    if (returned) {
      params.delete("payment");
      const rest = params.toString();
      history.replaceState(null, "", location.pathname + (rest ? `?${rest}` : ""));
      finishPayment(returned, true);
    } else if (body.payment?.pendingReference) {
      finishPayment(body.payment.pendingReference, false); // e.g. they closed the tab after paying
    }
    return;
  }
  if (status === 403 && body.error === "account_revoked") {
    showHome();
    $("home-content").hidden = true;
    $("who-id").hidden = true;
    $("admin-link").hidden = true;
    return showMessage("Your access has been switched off. Please contact Twig Learning Center if you think this is a mistake.", "error");
  }
  return null; // 401: show sign-in
}

$("code-form").addEventListener("submit", async (e) => {
  e.preventDefault();
  const button = e.submitter;
  button.disabled = true;
  const { status, body } = await api("/api/redeem", { method: "POST", body: JSON.stringify({ code: $("code").value }) });
  button.disabled = false;
  if (status === 200) {
    showMessage("Welcome, student! Every app is now unlocked.", "ok");
    render(body);
  } else {
    showMessage(body.message || "That code didn't work. Please check it and try again.", "error");
  }
});

$("profile-form").addEventListener("submit", async (e) => {
  e.preventDefault();
  const button = e.submitter;
  button.disabled = true;
  $("pf-error").replaceChildren();
  const { status, body } = await api("/api/profile", { method: "POST", body: JSON.stringify(Object.fromEntries(new FormData(e.target))) });
  button.disabled = false;
  if (status === 200) {
    const next = safeNext();
    if (next) return location.replace(next);
    return render(body);
  }
  const text = body.issues?.[0]?.message ?? "Something went wrong. Please try again.";
  $("pf-error").replaceChildren(el("div", { class: "notice error" }, text));
});

$("pay-button").addEventListener("click", async (e) => {
  const button = e.currentTarget;
  button.disabled = true;
  const { status, body } = await api("/api/pay/start", { method: "POST", body: "{}" });
  if (status === 200 && body.url) return location.assign(body.url);
  button.disabled = false;
  showMessage(body.message || "We couldn't open the payment page. Please try again.", "error");
});

$("sign-out").addEventListener("click", async () => {
  const clerk = await window.twigClerk();
  await clerk?.signOut();
  location.href = "/";
});

(async () => {
  let clerk = null;
  try {
    clerk = await window.twigClerk();
  } catch (err) {
    console.error(err);
  }
  const onAuthPage = /^\/sign-(in|up)(\/|$)/.test(location.pathname);
  if (clerk?.user && onAuthPage) return location.replace(safeNext() ?? "/");
  if (clerk?.user || !clerk) {
    // Signed in (or no Clerk configured, e.g. tests): ask the server who we are.
    const shown = await loadMe();
    if (shown !== null) return;
  }
  $("loading").hidden = true;
  if (!clerk) return showMessage("Sign in is not set up yet. Please try again later.", "error");
  $("signed-out").hidden = false;
  const redirect = safeNext() ?? "/";
  // Clerk routes inside the box with the URL hash (#/...), so the path only picks the box.
  if (location.pathname.startsWith("/sign-up")) {
    clerk.mountSignUp($("sign-in"), { forceRedirectUrl: redirect, signInForceRedirectUrl: redirect, signInUrl: "/sign-in" });
  } else {
    clerk.mountSignIn($("sign-in"), { forceRedirectUrl: redirect, signUpForceRedirectUrl: redirect, signUpUrl: "/sign-up" });
  }
  clerk.addListener(({ user }) => { if (user) location.replace(redirect); });
})();
