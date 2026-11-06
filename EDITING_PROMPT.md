# Prompt for editing the Twig portal safely

Copy everything below the line into the AI tool before asking for a change. Replace the last
line with what you want changed.

---

You are editing the Twig Learning Center portal. Make only the change I ask for at the end, and
keep the rest of the site exactly as it is.

## What this app does
Students sign in once with Google or email. Free users can open only the apps marked Free. A
student code unlocks every app that is switched on. Admins manage users, student codes and apps
at /admin. Each app is a separate Replit project, opened through a one-time launch code.

## How it is built
- Server: Node, Express 5, TypeScript, Drizzle ORM and PostgreSQL, in `src/`
- Pages: plain HTML, CSS and JavaScript, with no framework, in `public/`
- Sign-in: Clerk, loaded by `public/assets/clerk-loader.js` and `src/auth/`

## Where to make common changes
- Sign-in page and student home wording: `public/index.html`
- App headings, descriptions, tags, button text and section titles: change these in /admin, Page
  text tab, not in code. The original wording is in `src/lib/content.ts`
- App card artwork: `APP_DESIGN` in `public/assets/portal.js`
- Sign-up form choices and consent wording: `src/lib/profile.ts`
- Price, refund policy and the payment switch: change these in /admin, Payment tab, not in code
- Colours, spacing and fonts: `public/assets/twig.css`
- Admin page: `public/admin.html` and `public/assets/admin.js`
- App addresses, Free and On settings: change these in /admin, Apps tab, not in code

## Keep the design
- Use the colour variables at the top of `twig.css`. Do not add new hard-coded colours.
- Keep the Outfit font, the Twig logo files and their proportions, and "We've Got Chemistry!".
- Reuse existing classes such as `.btn` before adding new ones.
- Keep the pages usable on a phone, and keep keyboard focus visible.

## Do not change these without asking me first
- Sign-in: `src/auth/`, `public/assets/clerk-loader.js`, `/config.js`, and the `/sign-in` and
  `/sign-up` routes
- Access rules: `src/lib/access.ts`
- Student codes, launch codes and the app secret checks: `src/lib/portal.ts`,
  `src/routes/portal.ts`
- The admin-only check in `src/routes/admin.ts`
- App connection files: `connector/`
- Database: `src/db/` and `drizzle/`. Do not rename or delete tables or columns.
  Every new migration also needs an entry in `MIGRATION_MARKERS` in `src/db/migrate.ts`, or the
  server will not start.
- Replit settings: `.replit`
- Secrets: never put a key, password or customer detail in code

## Rules
1. Before editing, tell me which files you will change and why, in plain language.
2. If the change would touch a protected area, stop and ask me first.
3. Do not add a framework, redesign other pages, or tidy unrelated code.
4. Show text from users or the database with `textContent`, not `innerHTML`.
5. Do not publish. Tell me when the change is ready to review.
6. After editing, run `npm run typecheck` and `npm test`, and tell me the results honestly.
7. Tell me what to check on a computer and on a phone, including: sign in, entering a student
   code, opening an app, and /admin.

## The change I want
[Describe the change here]
