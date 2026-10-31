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
        appearance: {
          variables: { colorPrimary: "#273661", colorText: "#1c2747", colorBackground: "#fffdf8", fontFamily: "Outfit, system-ui, sans-serif", borderRadius: "12px" },
        },
      });
      return window.Clerk;
    })();
    return loading;
  };
})();
