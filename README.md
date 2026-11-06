# Twig portal

One sign-in for all of Twig Learning Center's chemistry apps.

- Students and the public sign in **once** (Google or email, through Clerk) and see every app
  as a tile.
- **Free** (public) users can open only the apps marked free. A **student code** from the
  teacher turns a free account into a **student** account, which opens every app.
- Donnell's **admin panel** (`/admin`) lets him create and revoke student codes, upgrade,
  downgrade or revoke users, block or allow one app for one person, choose which apps are
  free, add apps, and connect them.
- Each app stays its own Replit deployment with its own URL, database and code. Opening a tile
  sends the user to the app with a one-time code (60 seconds, single use). The app's server
  exchanges it with the portal for the user's details and starts its own session.

The content Library (`chem-library`) is a separate app; the portal does not depend on it.

Stack: Node.js 20+, Express 5, TypeScript, Drizzle ORM, PostgreSQL, Clerk, zod.

## Roles and access

| Role | How | Opens |
|---|---|---|
| Free (`public`) | anyone who signs up | apps marked **Free** |
| Student | enters a valid student code, or upgraded by an admin | every app that is switched on |
| Admin | verified email listed in `ADMIN_EMAILS` | every app, plus `/admin` |

Per-user exceptions (always allow / block one app) override the role. Revoked users open nothing.

## Replit setup

1. In the team workspace: Create App → Import from GitHub → `Carbon04778/twig-portal`.
   Stop Replit Agent if it starts by itself.
2. Database tool: create a PostgreSQL database.
3. Sign-in: add Clerk with **Google** and **email** sign-in (Replit's Auth pane, as in the other
   Twig apps), so `CLERK_SECRET_KEY` and `CLERK_PUBLISHABLE_KEY` are set.
4. Secrets: `ADMIN_EMAILS` = `donnellkoh@gmail.com` (add more, comma-separated).
5. Shell: `npm install`, then Run. The server creates its tables on start.
6. Publish (Autoscale, max 1 instance, **Public** sharing, development data not copied).
7. Donnell signs in at the published address with his Google account and opens **Admin**.

## Sign-up details and Google Sheet

New users fill in a required form before they can open apps (admins are exempt). Answers are saved in
the database first, then added to the Sheet, so a Sheet problem never blocks a student. Missed rows go
with the next sign-up or from Admin → Sign-ups, which also has a CSV download.

Connect Google Sheets through Replit Integrations; the connected Google account needs edit access to
the sheet. Secrets: `GOOGLE_SHEET_ID` (the part between `/d/` and `/edit` in its link) and, optionally,
`GOOGLE_SHEET_TAB`. Keep the sheet's sharing Restricted: it holds students' personal details.

## Usage tracking

Admin → Usage shows opens and estimated time per app and per student. Opens are recorded at launch.
Time comes from each app's access re-checks (`connector/portalAuth.ts`). Apps with an older copy of
that file re-check every 30 minutes, so short visits show as "under 5 min" until the file is re-copied
and the app republished.

## Payment (HitPay)

Off until switched on in Admin → Payment. Payment gives the same access as a student code until
`users.paid_until`, then the student is free again; nothing has to run for that to happen.

Secrets: `HITPAY_API_KEY`, `HITPAY_SALT`, `HITPAY_WEBHOOK_SALT`, and `HITPAY_MODE=live` for real money
(anything else uses HitPay's sandbox). In HitPay: Developers → Webhook Endpoints → New Webhook, with URL
`https://<portal>/api/hitpay/webhook` and event `payment_request.completed`. Its salt, on that webhook's
own page, is `HITPAY_WEBHOOK_SALT`.

Access is only given after the portal asks HitPay directly that the request is completed for the full
amount. The webhook and the student's return link just prompt that check. Refunds are made in HitPay's
dashboard; "Mark refunded" in the admin panel then ends the access.

## Connecting an app

1. Portal admin → **Apps** → add the app (ID such as `paper1`, name, its `https://….replit.app`
   address, description), then click **Connect** and copy the secret (shown once).
2. In the app's Replit Secrets: `PORTAL_URL` (the portal's address), `PORTAL_APP_ID`,
   `PORTAL_APP_SECRET`.
3. Server: copy `connector/portalAuth.ts` to `artifacts/api-server/src/middlewares/` and add to
   `src/app.ts`, before `app.use("/api", router)`:
   ```ts
   import { portalRoutes, portalSession, requirePortalUser } from "./middlewares/portalAuth";
   app.use(portalSession);
   app.use("/api/portal", portalRoutes);
   app.use("/api", requirePortalUser({ allow: ["/healthz"] }));
   ```
   Route handlers read the user from `res.locals.portalUser` (`id`, `email`, `name`, `role`).
4. Frontend: copy `connector/PortalGate.tsx` into `src/components/` and wrap the app in
   `src/main.tsx`: `<PortalGate><App /></PortalGate>`.
5. Publish the app, then open it from the portal.

The app re-checks access with the portal every 30 minutes, so a revoked user loses access
within half an hour (or at once for a new session). Clicking **New secret** in the admin panel
signs everyone out of that app until its `PORTAL_APP_SECRET` is updated.

## API

Signed-in pages: `GET /api/me`, `POST /api/redeem`, `GET /launch/:appId`.
Apps (header `x-app-secret`): `POST /api/apps/exchange {app_id, code}`,
`POST /api/apps/check {app_id, user_id}`.
Admin: `/api/admin/users`, `/api/admin/promo-codes`, `/api/admin/apps`, `/api/admin/audit`.

## Development

```sh
export DATABASE_URL=postgres://...  ADMIN_EMAILS=you@example.com
export CLERK_SECRET_KEY=sk_test_...  CLERK_PUBLISHABLE_KEY=pk_test_...
npm install
npm run dev     # http://localhost:3000
npm test        # unit + end-to-end tests against a temporary PostgreSQL 16
```
