# Wealth Engine — Personal Planning App

A private personal-finance planning dashboard. Sign in before viewing or entering plan data. New accounts start blank, and each user can choose a **1–10 year forecast** (default five years).

---

## Project Structure

```
wealth_engine_web/
├── index.html          ← Shell / markup (tabs, panels, canvas IDs)
├── css/
│   └── style.css       ← All CSS tokens, layout, component styles
├── js/
│   ├── data.js         ← ★ ALL YOUR NUMBERS LIVE HERE ★ (edit this file)
│   └── app.js          ← Computation engine, chart rendering, event wiring
├── api/
│   └── index.py        ← FastAPI auth, read-only demo, and account API
├── supabase/
│   └── schema.sql      ← Account table and row-level security policies
├── schema.json         ← Reference schema for illustrative fixture data
└── README.md           ← This file
```

## Product Scope

**Audience:** Nigerian salaried professionals in Lagos or working remotely, with roughly ₦300k–₦1.5M take-home pay, at least one active loan, and a savings goal. V1 is not designed for freelance or business income.

**Core task:** “Will my cash balance go negative, and when?” Overview leads with dated shortfalls and the largest scheduled outflows before each lowest point, so users can review what might need to move.

The **Actuals** tab lets signed-in users record dated income and expenses, add optional notes, and compare totals by category with their plan. Account actuals are stored with that account on the server. The current month is compared month-to-date with its full-month plan; historical months outside the rolling forecast are shown without a plan comparison.

On narrow screens, the Cash Flow tab shows one selected month at a time, and the Actuals comparison and shortfall details stack into readable cards instead of requiring sideways scrolling.

---

## Quick Start (Local)

The app uses ES Modules (`type="module"`), so it needs to be served — not opened as a `file://` URL.

**Option 1 — Vercel local development** (serves the frontend and API on one origin)
```bash
npx vercel dev
```
Open the exact **Available at** URL printed by Vercel (for example, `http://localhost:3001` if port 3000 is already occupied). This FastAPI app serves both the dashboard and the `/api` endpoints.

**Option 2 — Python static server** (frontend only; sign-in requires the account API)
```bash
python3 -m http.server 8080
# opens http://localhost:8080
```

---

## Customising Your Plan

**The illustrative fixtures in `js/data.js` and `api/index.py` are for read-only demo API routes and tests.** The app's normal startup does not load or display them. Sign in, then enter your own plan values in **Edit Inputs**.

| What you want to change | Where |
|---|---|
| Default forecast horizon | `FORECAST_YEARS` in `data.js` (new plans default to five years) |
| Salary or COLA | **Edit Inputs → Income** |
| Fixed monthly expense | **Edit Inputs → Fixed Monthly Expenses** |
| Irregular expenses or savings contributions | **Edit Inputs → Variable Expenses** |
| Debt balances and payment details | **Debts** |
| Savings goals and contributions | **Savings** |
| Brand colours (charts) | `BRAND` object; also `--red`, `--teal` etc. in `css/style.css :root` |

The **Plan controls** section lets you save and apply your own named scenarios.

## Dated Cash-Flow Forecast

The selected forecast starts in the current month and carries the entered opening balance forward. Its duration (one to ten years, default five) is saved with the private plan and each saved scenario. Salary and fixed expenses repeat monthly; variable amounts are month-specific, and months without an entered variable amount are treated as zero. Salary and allowances are assumed to arrive together on payday. Payments occur on their configured due days; days 29–31 fall on that month's last day when needed. If an expense and payday are on the same day, the forecast counts the expense first as a conservative assumption. Overview highlights months that go below zero and the largest scheduled outflows leading up to each lowest point. On narrow screens, Cash Flow shows one selected month at a time; use the month selector to view other months.

The model repeats those dates monthly and does not yet handle multiple paydays, transaction-level bank data, weekends/holidays, or dates that vary month by month. It is an estimate for planning—not financial advice. Confirm actual balances and payment dates before acting.

## Accounts and privacy (Vercel + Supabase)

The app requires sign-in before displaying the dashboard; it does not show a demo account. A missing, invalid, or expired session returns the app to the sign-in gate. Demo plan, scenario, and actuals endpoints remain separate from the signed-in interface and never access account storage. A new private account starts with zeroed income, cash, and expense amounts and generic expense categories; fictional demo amounts, debts, savings goals, and actuals are not copied into it. Payday and due-day fields start at day 1 and can be changed under **Edit Inputs**.

Signed-in users can add, edit, and delete their own debts and savings goals in the **Debts** and **Savings** tabs. Debt balance, annual interest, monthly payment, and payment day feed an estimated paydown and dated cash-flow schedule. Savings target, starting amount, monthly contribution, and contribution day feed progress projections and the cash-flow schedule. Goal contributions stop at the target; debt projections use the entered interest rate and payment. These are planning estimates, not lender calculations or financial advice. Resetting a private plan clears debt and savings entries but retains recorded actual transactions.

- `/api/demo/plan`, `/api/demo/scenarios`, and `/api/demo/actuals` return fictional fixtures and are read-only. These routes are not used by the signed-in interface and never call Postgres.
- `/api/auth/*` handles sign-up, sign-in, session refresh, session verification, and sign-out through Supabase Auth.
- `/api/account/data` requires a verified Supabase access token. The API derives the row owner from the verified identity, and Postgres row-level security enforces per-user isolation.
- Private debt and savings-goal records are stored in the account's JSON data and validated by the API; no database migration is needed for an existing account table.
- Resetting a private plan clears its inputs instead of restoring fictional demo defaults.
- The API uses only the Supabase anon key and the signed-in user's token. Never configure a `service_role` key in this app.
- The browser keeps the short-lived sign-in session in `sessionStorage` (cleared when the tab session ends); financial plans and actuals are not stored in browser storage. As with any browser app, an XSS vulnerability could expose an active session, so security review and production hardening are still required.

To configure the API:

1. Create a Supabase project and run [`supabase/schema.sql`](./supabase/schema.sql) in its SQL editor. For an already configured project, do not rerun setup without reviewing the SQL first.
2. In the Supabase project settings, copy the **Project URL** and **anon/public key** (never the `service_role` key).
3. For local development, set `SUPABASE_URL` and `SUPABASE_ANON_KEY` in the same PowerShell window before running `npx vercel dev`:
   ```powershell
   $env:SUPABASE_URL = "https://your-project.supabase.co"
   $env:SUPABASE_ANON_KEY = "your-anon-public-key"
   npx vercel dev
   ```
4. Add those two values as Vercel project environment variables for the deployment targets you use (Production and, if needed, Preview). Do not expose database passwords or the service-role key. Production is configured for the current deployment; Preview must be configured separately if you use it.
5. Configure Supabase email confirmation and allowed redirect URLs for your app's deployed domain.
6. Deploy the project to Vercel. Vercel routes requests to FastAPI; the app serves `index.html` and its CSS/JS assets as well as API endpoints.

Run API tests locally with `python -m unittest discover -s tests`. For account and API testing, use `vercel dev` so frontend requests reach the same-origin function. To run the FastAPI function directly, install `requirements.txt` and run `uvicorn api.index:app --reload`; it listens on `http://127.0.0.1:8000`.

The production app is deployed at [wealth-engine-web.vercel.app](https://wealth-engine-web.vercel.app/). Its account API depends on the Vercel production environment variables and Supabase project configuration described above. JSON/CSV plan exports are downloaded to the device; actuals are not included in those exports. Although deployed and usable, this is not a regulated or fully hardened financial service. Review security, backups, recovery, monitoring, and data-retention requirements before inviting additional users to store sensitive financial information.

---

## Array Length Rule

Variable schedules can hold up to 120 months (the supported ten-year maximum). The selected forecast uses only the first 12, 24, ... or 120 months. Changing the horizon does not discard values outside the currently selected range. Within an entered schedule, missing values are treated as zero.

```js
// New plans default to 5 years; the account selector supports 1–10 years.
// Schedule values are month-specific from the current month onward.
// 0 = no payment in that month
savings_goal_1: [30000,30000,30000,30000,30000,30000,30000,30000, 0,0,0,0,0],
//             current month onward; later unlisted months are zero
```

---

## Managing expense categories

Signed-in users can add or remove a variable expense category in **Edit Inputs → Category manager**. Its monthly values and due day are included in the cash-flow calculation and saved with the private plan. Manage private debts and savings goals in their own tabs; their schedules are generated from those records.

---

## Data schema reference

[`schema.json`](./schema.json) documents the illustrative fixture data in `js/data.js`. It is reference material, not runtime validation: `data.js` is a JavaScript module rather than JSON, and signed-in account data is validated by the API.

---

## Deployment

The account-enabled app requires a host that runs the FastAPI endpoints; a static-only host such as GitHub Pages or a static Netlify drop will not provide sign-in or account storage. The production deployment uses Vercel.

To deploy from the project root with the Vercel CLI:

```powershell
npx vercel
npx vercel --prod
```

Configure `SUPABASE_URL` and `SUPABASE_ANON_KEY` in Vercel before using account features. Keep secrets out of source control. The project is connected to GitHub; pushing to `main` may also trigger a Vercel deployment depending on the project's Git integration settings.

---

## Roadmap (v2 ideas)

- [ ] Sample debt settlement simulator
- [ ] PDF / print-to-file summary export
- [ ] 50/30/20 budget analysis from Jan 2027
- [ ] PWA manifest for offline use
