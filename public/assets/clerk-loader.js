// Loads Clerk in the browser, the same two scripts @clerk/react loads (clerk-js + ui).
// Production goes through this site's /api/__clerk proxy; development talks to Clerk directly.
// Exposes window.twigClerk(): Promise<Clerk | null> (null when Clerk isn't configured).
(() => {
  const CLERK_JS_VERSION = "6.42.0";
  const CLERK_UI_VERSION = "1.42.1";

  function frontendApiFromKey(key) {
    try {
      return atob(key.split("_")[2]).replace(/\$$/, "");
    } catch {
      return null;
    }
  }

  function loadScript(src, attrs) {
    return new Promise((resolve, reject) => {
      const s = document.createElement("script");
      s.src = src;
      s.async = true;
      s.crossOrigin = "anonymous";
      for (const [k, v] of Object.entries(attrs)) s.setAttribute(k, v);
      s.onload = resolve;
      s.onerror = () => reject(new Error(`Could not load ${src}`));
      document.head.appendChild(s);
    });
  }

  const NAVY = "#273561";
  const INK = "#2a345e";
  const LINE = "#e4ddcc";
  const FIELD = { height: "46px", borderRadius: "14px", border: `1.5px solid ${LINE}`, boxShadow: "none", background: "#fff" };
  const BUTTON = { height: "46px", borderRadius: "999px", fontWeight: 600, fontSize: "15px", textTransform: "none", boxShadow: "none" };
  const APPEARANCE = {
    layout: { socialButtonsPlacement: "bottom", socialButtonsVariant: "blockButton" },
    variables: { colorPrimary: NAVY, colorText: INK, colorTextSecondary: "#4a5272", colorBackground: "#ffffff", colorInputBackground: "#ffffff", colorInputText: INK, fontFamily: "Outfit, system-ui, sans-serif", borderRadius: "14px" },
    elements: {
      rootBox: { width: "100%" },
      cardBox: { width: "100%", maxWidth: "100%", boxShadow: "none", border: "none", background: "transparent" },
      card: { boxShadow: "none", border: "none", background: "transparent", padding: "0", gap: "18px" },
      headerTitle: { fontSize: "28px", fontWeight: 700, color: NAVY },
      headerSubtitle: { fontSize: "14px", color: "#4a5272" },
      formFieldLabel: { fontWeight: 600, fontSize: "14px", color: NAVY },
      formFieldInput: FIELD,
      formFieldAction: { fontSize: "13px", fontWeight: 500, color: NAVY, textDecoration: "underline" },
      formButtonPrimary: { ...BUTTON, background: NAVY },
      socialButtonsBlockButton: { ...BUTTON, border: `1.5px solid ${LINE}`, background: "#fff" },
      socialButtonsBlockButtonText: { fontWeight: 600, color: NAVY },
      dividerLine: { background: LINE },
      dividerText: { color: "#5e6584" },
      footer: { background: "transparent" },
      footerActionText: { color: "#4a5272" },
      footerActionLink: { color: NAVY, fontWeight: 700, textDecoration: "underline" },
    },
  };
  // /sign-up is a separate page, so its wording is chosen once at load.
  const LOCALIZATION = /^\/sign-up(\/|$)/.test(location.pathname)
    ? { signUp: { start: { title: "Create your Twig account", subtitle: "One account for every Twig chemistry app." } } }
    : { formButtonPrimary: "Log in", signIn: { start: { title: "Student log in", subtitle: "Welcome back. Let's get some practice in." } } };

  let loading;
  window.twigClerk = () => {
    if (loading) return loading;
    loading = (async () => {
      const { clerkPublishableKey: key, clerkProxyPath } = window.TWIG ?? {};
      if (!key) return null;
      const proxyUrl = clerkProxyPath ? `${location.origin}${clerkProxyPath}` : null;
      const host = proxyUrl ?? `https://${frontendApiFromKey(key)}`;
      const attrs = { "data-clerk-publishable-key": key, ...(proxyUrl ? { "data-clerk-proxy-url": proxyUrl } : {}) };
      await Promise.all([
        loadScript(`${host}/npm/@clerk/clerk-js@${CLERK_JS_VERSION}/dist/clerk.browser.js`, { ...attrs, "data-clerk-js-script": "true" }),
        loadScript(`${host}/npm/@clerk/ui@${CLERK_UI_VERSION}/dist/ui.browser.js`, { ...attrs, "data-clerk-ui-script": "true" }),
      ]);
      // The ui script defines the components class; Clerk only builds sign-in/sign-up from it
      // when it is passed here (otherwise mountSignIn throws "not loaded with Ui components").
      await window.Clerk.load({
        ui: { ClerkUI: window.__internal_ClerkUICtor },
        // Where Clerk sends people for sign-in/sign-up steps (served by the portal page).
        signInUrl: "/sign-in",
        signUpUrl: "/sign-up",
        signInFallbackRedirectUrl: "/",
        signUpFallbackRedirectUrl: "/",
        afterSignOutUrl: "/",
        // Wording and look match the portal's sign-in page. Clerk shows only what is switched on in
        // its settings (password, Google, ...); these options just restyle and reword it.
        localization: LOCALIZATION,
        appearance: APPEARANCE,
      });
      return window.Clerk;
    })();
    return loading;
  };
})();
