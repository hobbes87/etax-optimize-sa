# eTaxOptimize SA — Complete Local-Ready Repository

## Quick Start (Zero External Database Setup Required)

1. Extract this ZIP archive into `C:\Users\Ryant\etaxoptimize-sa` (overwrite existing files if prompted).
2. Open PowerShell inside `C:\Users\Ryant\etaxoptimize-sa` and run:
   ```powershell
   npm install
   npx prisma generate
   npx prisma db push
   npm run dev
   ```
3. Open `http://localhost:3000` in Chrome:
   - **Stage 0:** Register an account — the sandbox SMS OTP appears right on screen so you can verify immediately.
   - **Stage 1:** Save your tax year classification and deduction scope.
   - **Stage 2:** Upload real PDF/CSV bank statements OR click **"Load Sample SA Bank Statement"** to populate live transactions.
   - **Stage 3:** Confirm ambiguous items and verify your IRP5 figures.
   - **Stage 4:** Run the deterministic South African Income Tax calculation and unlock Stage 5.
   - **Stage 5 & 6:** Step through the guided SARS eFiling instructions or use the `extension/` folder in Chrome (`chrome://extensions` -> Load unpacked).

## Deploy the Next.js app to Render

The repository-root `render.yaml` defines this app as a separate Node web service named `etaxoptimize-nextjs`; the existing Python/Streamlit service is unchanged. Connect the repository to Render as a Blueprint and sync the Blueprint. The Node service builds from this directory, applies the Prisma schema before deploy, and stores its SQLite database on a persistent disk.

Set `PAYGATE_ID`, `PAYGATE_SECRET`, and `NEXT_PUBLIC_APP_URL` in the Render dashboard. Use the actual PayGate credentials and the deployed service URL. Render generates `AUTH_SECRET` and `OTP_PEPPER`; keep them private and stable between deploys.

The deployment uses `prisma db push` because this repository does not yet contain Prisma migration files. Before making production schema changes, establish and test a migration workflow rather than relying on `db push`.

Do not expose the service publicly until the production dependency findings are resolved. `npm audit --omit=dev` currently reports one critical Next.js vulnerability and high-severity PostCSS and Zod advisories, including after updating Next.js to 14.2.35.
