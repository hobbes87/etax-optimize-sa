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
