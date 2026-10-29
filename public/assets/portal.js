// Student-facing page: sign in, see app tiles, redeem a student code, open apps.
const $ = (id) => document.getElementById(id);
const params = new URLSearchParams(location.search);

function el(tag, attrs = {}, ...children) {
  const node = document.createElement(tag);
  for (const [k, v] of Object.entries(attrs)) {
    if (k === "class") node.className = v;
    else if (v !== false && v != null) node.setAttribute(k, v === true ? "" : v);
  }
  for (const c of children) node.append(c);
  return node;
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

const ROLE_TEXT = {
  public: "You can use the free app. Have a student code? Enter it below to unlock everything.",
  student: "You have full student access to every app.",
  admin: "Admin. You can open every app and manage access.",
};

function render({ user, apps }) {
  $("loading").hidden = true;
  $("signed-out").hidden = true;
  $("signed-in").hidden = false;
  $("who").hidden = false;
  $("who-name").textContent = user.name || user.email;
  $("admin-link").hidden = user.role !== "admin";
  $("hello").textContent = `Hi ${user.name ? user.name.split(" ")[0] : "there"}!`;
  $("role-badge").textContent = user.role === "public" ? "Free" : user.role === "student" ? "Student" : "Admin";
  $("role-badge").className = `badge ${user.role}`;
  $("role-text").textContent = ROLE_TEXT[user.role];
  $("code-form").hidden = user.role !== "public";

  const denied = params.get("denied");
  if (denied) {
    const name = apps.find((a) => a.id === denied)?.name ?? "that app";
    showMessage(`Your account doesn't have access to ${name}${user.role === "public" ? ". Enter a student code to unlock it." : "."}`, "error");
  }

  $("tiles").replaceChildren(...apps.map((a) => el("div", { class: `tile ${a.canOpen ? "" : "locked"}` },
    el("h3", {}, a.name),
    el("p", {}, a.description || ""),
    a.canOpen
      ? el("a", { class: "btn", href: `/launch/${encodeURIComponent(a.id)}` }, "Open")
      : el("span", { class: "lock" }, "🔒 Students only"),
  )));
  if (!apps.length) $("tiles").append(el("p", { class: "muted" }, "No apps are available yet."));
}

async function loadMe() {
  const { status, body } = await api("/api/me");
  if (status === 200) {
    const next = safeNext();
    if (next) return location.replace(next);
    return render(body);
  }
  if (status === 403 && body.error === "account_revoked") {
    $("loading").hidden = true;
    $("who").hidden = false;
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
  if (clerk?.user || !clerk) {
    // Signed in (or no Clerk configured, e.g. tests): ask the server who we are.
    const shown = await loadMe();
    if (shown !== null) return;
  }
  $("loading").hidden = true;
  if (!clerk) return showMessage("Sign in is not set up yet. Please try again later.", "error");
  $("signed-out").hidden = false;
  const redirect = safeNext() ?? "/";
  clerk.mountSignIn($("sign-in"), { forceRedirectUrl: redirect, signUpForceRedirectUrl: redirect });
  clerk.addListener(({ user }) => { if (user) location.replace(redirect); });
})();
