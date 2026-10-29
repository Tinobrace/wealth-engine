# Wealth Engine — Demo Setup

An illustrative personal-finance planning dashboard with fictional sample data.  
The forecast spans **five years from the current month**, updating automatically as time passes.

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
├── schema.json         ← JSON Schema documenting the data.js shape (IDE validation)
└── README.md           ← This file
```

## Product Scope

**Audience:** Nigerian salaried professionals in Lagos or working remotely, with roughly ₦300k–₦1.5M take-home pay, at least one active loan, and a savings goal. V1 is not designed for freelance or business income.

**Core task:** “Will my cash balance go negative, and when?” Overview leads with dated shortfalls and the largest scheduled outflows before each lowest point, so users can review what might need to move.

The **Actuals** tab lets signed-in users record dated income and expenses, add optional notes, and compare totals by category with their plan. Account actuals are stored with that account on the server. The read-only sample demo has no editable transactions. The current month is compared month-to-date with its full-month plan; historical months outside the rolling forecast are shown without a plan comparison.

---

## Quick Start (Local)

The app uses ES Modules (`type="module"`), so it needs to be served — not opened as a `file://` URL.

**Option 1 — Vercel local development** (serves the frontend and API on one origin)
```bash
npx vercel dev
```
Open the exact **Available at** URL printed by Vercel (for example, `http://localhost:3001` if port 3000 is already occupied). This FastAPI app serves both the dashboard and the `/api` endpoints.

**Option 2 — Python static server** (sample demo only; account API requires Vercel local development)
```bash
python3 -m http.server 8080
# opens http://localhost:8080
```

---

## Customising Your Plan

**The fictional demo dataset is in `js/data.js`.** Replace it only with data you are authorized to use; any values in a static deployment are visible to visitors.

| What you want to change | Where |
|---|---|
| Salary or COLA | `INCOME.salary` / `INCOME.cola` |
| Fixed monthly expense | `FIXED_DEF` — change the second element of the tuple |
| Add a new fixed expense | Add a new key to `FIXED_DEF`, e.g. `gym: ['Gym', 15000]` |
| Loan repayment amounts | `VARIABLE.loan_bundle` array |
| Home-project payment schedule | `VARIABLE.home_project` array |
| Savings contribution amounts | `VARIABLE.savings_goal_1` / `VARIABLE.savings_goal_2` |
| Change forecast horizon | Update `FORECAST_YEARS` in `data.js` |
| Debt balances (after payments) | `DEBTS[n].balance` |
| Mark a debt as settled | `DEBTS[n].status = 'settled'` |
| Brand colours (charts) | `BRAND` object; also `--red`, `--teal` etc. in `css/style.css :root` |

**After editing `data.js`, save the file — the browser reloads automatically (Live Server) or on manual refresh.**

The starter scenarios are distinct projections: **Rent focus** adds enough to the second sample savings goal to meet the configured home-fund target, while **Aggressive debt payoff** redirects sample savings contributions to the combined loan-payment stream.

## Dated Cash-Flow Forecast

The five-year forecast starts in the current month and carries the entered opening balance forward. Salary and fixed expenses repeat monthly; variable amounts are month-specific, and months without an entered variable amount are treated as zero. Salary and allowances are assumed to arrive together on payday. Payments occur on their configured due days; days 29–31 fall on that month's last day when needed. If an expense and payday are on the same day, the forecast counts the expense first as a conservative assumption. Overview highlights months that go below zero and the largest scheduled outflows leading up to each lowest point.

The model repeats those dates monthly and does not yet handle multiple paydays, transaction-level bank data, weekends/holidays, or dates that vary month by month. It is an estimate for planning—not financial advice. Confirm actual balances and payment dates before acting.

## Accounts and privacy (Vercel + Supabase)

The app starts in a **read-only sample demo**. Demo plan, scenario, and actuals requests use separate `/demo` routes; they never access account storage. A new private account starts with zeroed income, cash, and expense amounts and generic expense categories; fictional demo amounts, debts, savings goals, and actuals are not copied into it. Payday and due-day fields start at day 1 and can be changed under **Edit Inputs**.

Signed-in users can add, edit, and delete their own debts and savings goals in the **Debts** and **Savings** tabs. Debt balance, annual interest, monthly payment, and payment day feed an estimated paydown and dated cash-flow schedule. Savings target, starting amount, monthly contribution, and contribution day feed progress projections and the cash-flow schedule. Goal contributions stop at the target; debt projections use the entered interest rate and payment. These are planning estimates, not lender calculations or financial advice. Resetting a private plan clears debt and savings entries but retains recorded actual transactions.

- `/api/demo/plan`, `/api/demo/scenarios`, and `/api/demo/actuals` return fictional fixtures and are read-only. These routes never call Postgres.
- `/api/auth/*` handles sign-up, sign-in, session refresh, session verification, and sign-out through Supabase Auth.
- `/api/account/data` requires a verified Supabase access token. The API derives the row owner from the verified identity, and Postgres row-level security enforces per-user isolation.
- Private debt and savings-goal records are stored in the account's JSON data and validated by the API; no database migration is needed for an existing account table.
- Resetting a private plan clears its inputs instead of restoring fictional demo defaults. The read-only demo continues to use its own sample fixtures.
- The API uses only the Supabase anon key and the signed-in user's token. Never configure a `service_role` key in this app.
- The browser keeps the short-lived sign-in session in `sessionStorage` (cleared when the tab session ends); financial plans and actuals are not stored in browser storage. As with any browser app, an XSS vulnerability could expose an active session, so security review and production hardening are still required.

To configure the API:

1. Create a Supabase project and run [`supabase/schema.sql`](./supabase/schema.sql) in its SQL editor.
2. In the Supabase project settings, copy the **Project URL** and **anon/public key** (never the `service_role` key).
3. For local development, set `SUPABASE_URL` and `SUPABASE_ANON_KEY` in the same PowerShell window before running `npx vercel dev`:
   ```powershell
   $env:SUPABASE_URL = "https://your-project.supabase.co"
   $env:SUPABASE_ANON_KEY = "your-anon-public-key"
   npx vercel dev
   ```
4. Add those same two values as Vercel project environment variables for Preview and Production. Do not expose database passwords or the service-role key.
5. Configure Supabase email confirmation and allowed redirect URLs for your app's deployed domain.
6. Deploy the project to Vercel. Vercel routes requests to FastAPI; the app serves `index.html` and its CSS/JS assets as well as API endpoints.

Run API tests locally with `python -m unittest discover -s tests`. For account and API testing, use `vercel dev` so frontend requests reach the same-origin function. To run the FastAPI function directly, install `requirements.txt` and run `uvicorn api.index:app --reload`; it listens on `http://127.0.0.1:8000`.

The app and API are connected, but this is not yet a production-ready financial service. Configure Supabase and Vercel before account sign-in will work. JSON/CSV plan exports are downloaded to the device; actuals are not included in those exports. Review security, backups, recovery, monitoring, and data-retention requirements before inviting users to store sensitive financial information.

---

## Array Length Rule

Every array in `VARIABLE` is normalized to the forecast horizon (`NM`, currently 60). If you add an initial schedule in `data.js`, values after its last entry are treated as zero.

```js
// MONTHS is generated for 5 years → the app pads shorter schedules with zeroes
// 0 = no payment in that month
savings_goal_1: [30000,30000,30000,30000,30000,30000,30000,30000, 0,0,0,0,0],
//             current month onward; later unlisted months are zero
```

---

## Adding a New Variable Expense Stream

1. Add the array to `VARIABLE` in `data.js`:
   ```js
   car_loan: [50000,50000,50000,50000,50000,50000,0,0,0,0,0,0,0],
   ```
2. Add a label to `VAR_LABELS` in `app.js` (the read-only preview on the Inputs tab):
   ```js
   car_loan: 'Car Loan',
   ```
3. Add a row to `renderCFTable()` in `app.js`:
   ```js
   h += row('Car Loan', rows.map(r => VARIABLE.car_loan[r.m]), '', v => v > 0 ? 'cv-neg' : 'cv-zero');
   ```
   That's it — totals and charts update automatically.

---

## IDE Validation

`schema.json` documents the data shape.  
To get autocompletion and inline errors in VS Code:

1. Install the **JSON Schema Store** extension (or use the built-in JSON language server).
2. Add this to `.vscode/settings.json`:
   ```json
   {
     "json.schemas": [
       {
         "fileMatch": ["js/data.js"],
         "url": "./schema.json"
       }
     ]
   }
   ```

> Note: `data.js` is a JS module, not JSON. The schema is for reference/documentation; the JSON language server won't auto-attach to a `.js` file without a plugin like **Even Better TOML** or a custom validator.

---

## Deployment (optional)

The app is a static site — any static host works:

| Host | Command |
|---|---|
| GitHub Pages | Push to `main`, enable Pages on `/` |
| Netlify | Drag the folder into [netlify.com/drop](https://netlify.com/drop) |
| Vercel | `npx vercel` in the project root |

No build step required.

---

## Roadmap (v2 ideas)

- [ ] Sample debt settlement simulator
- [ ] PDF / print-to-file summary export
- [ ] 50/30/20 budget analysis from Jan 2027
- [ ] PWA manifest for offline use
