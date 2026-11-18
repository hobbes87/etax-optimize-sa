'use client';

import React, { useState } from 'react';
import {
  ShieldCheck,
  FileText,
  CheckCircle2,
  AlertTriangle,
  Lock,
  ArrowLeft,
  Copy,
  CreditCard,
  Upload,
  Loader2,
  Zap,
} from 'lucide-react';

type Stage = 1 | 2 | 3 | 4 | 5 | 6;

interface TransactionRecord {
  id: string;
  txDate: string;
  description: string;
  amount: number;
  txType: 'CREDIT' | 'DEBIT';
  sarsCode: string;
  confidence: number;
  clarifiedByUser: boolean;
}

interface DocumentRecord {
  id: string;
  fileName: string;
  docCategory: string;
  sha256Hash: string;
  uploadedAt: string;
}

interface CalculationPreview {
  totalGrossIncome: number;
  totalDeductionsAndExemptions: number;
  totalTaxCredits: number;
  netRefundOrPayable: number;
  auditRiskScore: number;
  advisories: Array<{
    priority: string;
    area: string;
    finding: string;
    actionStep: string;
  }>;
}

interface EfilingStep {
  stepNumber: number;
  container: string;
  label: string;
  sarsCode: string;
  value: string;
  instruction: string;
}

export default function TaxEngineWorkspace() {
  const [stage, setStage] = useState<Stage>(1);
  const [loading, setLoading] = useState(false);
  const [statusMsg, setStatusMsg] = useState('');

  // Stage 0: Auth & POPIA Gate
  const [user, setUser] = useState<{ id: string; fullName: string; email: string; phone: string } | null>(null);
  const [authMode, setAuthMode] = useState<'LOGIN' | 'REGISTER' | 'OTP'>('REGISTER');
  const [pendingUserId, setPendingUserId] = useState('');
  const [sandboxOtp, setSandboxOtp] = useState('');

  // Active TaxYear Record
  const [taxYearId, setTaxYearId] = useState('');
  const [assessmentYear, setAssessmentYear] = useState(2027);
  const [age, setAge] = useState(35);
  const [classification, setClassification] = useState('SOLE_PROPRIETOR_SIDE_BUSINESS');
  const [scopeFlags, setScopeFlags] = useState<Record<string, boolean | number>>({
    ra: true,
    medical: true,
    medicalDependants: 1,
    homeOffice: true,
    homeOfficePct: 15,
    travelLogbook: true,
    businessKm: 4200,
    interestTfsa: true,
    donations18a: false,
    sideBusiness: true,
  });

  // Stage 2 & 3: Vault Documents & Deduplicated Transactions
  const [docCategory, setDocCategory] = useState('BANK_STATEMENT');
  const [documents, setDocuments] = useState<DocumentRecord[]>([]);
  const [transactions, setTransactions] = useState<TransactionRecord[]>([]);
  const [irp5Totals, setIrp5Totals] = useState({
    gross3601: 450000,
    paye4102: 88500,
    ra4006: 36000,
    med4005: 28800,
  });

  // Stage 4, 5, 6: Real Deterministic Calculation Results & eFiling Steps
  const [preview, setPreview] = useState<CalculationPreview | null>(null);
  const [unlockedDetails, setUnlockedDetails] = useState<{
    eFilingSteps: EfilingStep[];
    grossSalary3601: number;
    tradeIncome3616: number;
    effectiveRaDeduction: number;
    homeOfficeDeduction4028: number;
    travelDeduction4014: number;
  } | null>(null);
  const [truthConfirmed, setTruthConfirmed] = useState(false);
  const [currentStepIdx, setCurrentStepIdx] = useState(0);
  const [taxYearStatus, setTaxYearStatus] = useState('DRAFT');

  async function handleAuthSubmit(e: React.FormEvent<HTMLFormElement>) {
    e.preventDefault();
    setLoading(true);
    setStatusMsg('');
    const fd = new FormData(e.currentTarget);
    const payload = Object.fromEntries(fd.entries());

    try {
      if (authMode === 'OTP') {
        const res = await fetch('/api/auth/otp', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ action: 'VERIFY_OTP', userId: pendingUserId, otp: payload.otp }),
        });
        const data = await res.json();
        if (data.authenticated) {
          setUser(data.user);
          setStage(1);
        } else {
          setStatusMsg(data.error || 'OTP Verification failed');
        }
        return;
      }

      const res = await fetch('/api/auth/otp', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          action: 'REQUEST_OTP',
          purpose: authMode,
          ...payload,
          popiaConsent: Boolean(payload.popiaConsent),
          specialDataConsent: Boolean(payload.specialDataConsent),
        }),
      });
      const data = await res.json();
      if (data.userId) {
        setPendingUserId(data.userId);
        if (data.sandboxOtp) setSandboxOtp(data.sandboxOtp);
        setAuthMode('OTP');
      } else {
        setStatusMsg(data.error || 'Authentication failed');
      }
    } finally {
      setLoading(false);
    }
  }

  async function saveStage1AndContinue() {
    if (!user) return;
    setLoading(true);
    setStatusMsg('');
    try {
      const res = await fetch('/api/taxyear', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          userId: user.id,
          assessmentYear,
          classification,
          age,
          scopeFlags,
        }),
      });
      const data = await res.json();
      if (data.taxYear) {
        setTaxYearId(data.taxYear.id);
        setTaxYearStatus(data.taxYear.status);
        setDocuments(data.taxYear.documents || []);
        setTransactions(data.taxYear.transactions || []);
        setStage(2);
      } else {
        setStatusMsg(data.error || 'Failed to save tax year');
      }
    } finally {
      setLoading(false);
    }
  }

  async function handleFileUpload(files: FileList | null) {
    if (!files || files.length === 0 || !taxYearId) return;
    setLoading(true);
    setStatusMsg('');
    try {
      for (const file of Array.from(files)) {
        const fd = new FormData();
        fd.append('file', file);
        fd.append('taxYearId', taxYearId);
        fd.append('docCategory', docCategory);

        const res = await fetch('/api/documents/parse', { method: 'POST', body: fd });
        const data = await res.json();
        if (data.transactions) setTransactions(data.transactions);
        if (data.documents) setDocuments(data.documents);
        if (docCategory === 'ITSA') setTaxYearStatus('CLOSED_AND_LOCKED');
      }
      setStatusMsg('Documents hashed (SHA-256) and parsed into your source-code ledger.');
    } finally {
      setLoading(false);
    }
  }

  async function handleLoadSampleStatement() {
    if (!taxYearId) return;
    const sampleCsv = [
      '2026-03-25 SALARY ACME TECH PTY LTD 37500.00 Cr',
      '2026-04-02 DISCOVERY HEALTH MEDICAL AID -2400.00 Dr',
      '2026-04-05 ALLAN GRAY RA CONTRIBUTION -3000.00 Dr',
      '2026-04-12 AFRIHOST FIBRE INTERNET -999.00 Dr',
      '2026-04-18 ESKOM PREPAID ELECTRICITY -1850.00 Dr',
      '2026-05-14 RTC TRANSFER CLIENT CONSULTING 14500.00 Cr',
      '2026-06-09 ENGEN NORTHWOLD FUEL -680.00 Dr',
      '2026-07-19 DIS-CHEM PHARMACY RX -490.00 Dr',
      '2026-08-30 FNB CREDIT INTEREST PAID 4250.00 Cr',
      '2026-09-10 WOOLWORTHS FOOD GROCERIES -1420.00 Dr',
    ].join('\n');

    const file = new File([sampleCsv], 'FNB_2026_Sample_Statement.csv', { type: 'text/csv' });
    const dt = new DataTransfer();
    dt.items.add(file);
    await handleFileUpload(dt.files);
  }

  async function clarifyTransaction(transactionId: string, newCode: string) {
    const res = await fetch('/api/transactions/clarify', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ transactionId, sarsCode: newCode }),
    });
    const data = await res.json();
    if (data.transaction) {
      setTransactions((prev) => prev.map((t) => (t.id === transactionId ? data.transaction : t)));
    }
  }

  async function runCalculation(forceUnlockSandbox = false) {
    if (!taxYearId) return;
    setLoading(true);
    setStatusMsg('');
    try {
      const res = await fetch('/api/tax/calculate', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          taxYearId,
          irp5Totals,
          forceUnlockSandbox,
        }),
      });
      const data = await res.json();
      if (data.previewSummary) {
        setPreview(data.previewSummary);
        setTaxYearStatus(data.status);
        if (data.unlockedDetails) {
          setUnlockedDetails(data.unlockedDetails);
        }
        setStage(forceUnlockSandbox ? 5 : 4);
      } else {
        setStatusMsg(data.error || 'Calculation error');
      }
    } finally {
      setLoading(false);
    }
  }

  function triggerChromeExtensionAutoFill() {
    if (!unlockedDetails) return;
    const payload: Record<string, string> = {};
    unlockedDetails.eFilingSteps.forEach((s) => {
      if (/^\d{4}$/.test(s.sarsCode)) payload[s.sarsCode] = s.value;
    });
    window.postMessage({ type: 'ETAX_OPTIMIZE_AUTOFILL', payload }, '*');
    setStatusMsg('Verified SARS source-code figures dispatched to the Chrome Extension.');
  }

  const unclarifiedItems = transactions.filter((t) => t.confidence < 80 && !t.clarifiedByUser);

  return (
    <div className="min-h-screen flex flex-col">
      <header className="bg-gradient-to-r from-[#002F5F] via-[#004B87] to-[#007A87] text-white border-b-4 border-[#C59B27] px-6 py-4 shadow">
        <div className="max-w-6xl mx-auto flex flex-wrap items-center justify-between gap-4">
          <div>
            <h1 className="text-xl font-bold tracking-tight">eTaxOptimize SA — SARS Compliance & Guided eFiling Vault</h1>
            <p className="text-xs text-slate-200 mt-0.5">
              POPIA Act 4 of 2013 & Tax Administration Act 28 of 2011 Compliant • Zero SARS Credential Storage
            </p>
          </div>
          {user && (
            <div className="flex items-center gap-3 text-xs bg-[#002F5F]/70 px-3 py-1.5 rounded border border-[#C59B27]/50">
              <ShieldCheck className="w-4 h-4 text-[#C59B27]" />
              <span>{user.fullName} ({user.phone})</span>
              <span className="bg-[#C59B27] text-[#002F5F] px-2 py-0.5 rounded font-bold">{taxYearStatus}</span>
            </div>
          )}
        </div>
      </header>

      {user && (
        <nav className="bg-white border-b border-slate-200 px-6 py-3">
          <div className="max-w-6xl mx-auto flex flex-wrap gap-2">
            {[
              [1, '1. Classification & Scope'],
              [2, '2. Document Upload'],
              [3, '3. Ledger & Clarify'],
              [4, '4. Preview & Unlock'],
              [5, '5. Guided eFiling'],
              [6, '6. ITA34 & Lock'],
            ].map(([num, label]) => (
              <button
                key={num}
                onClick={() => setStage(num as Stage)}
                className={`px-3 py-1.5 rounded text-xs font-semibold transition ${
                  stage === num ? 'bg-[#002F5F] text-white' : 'bg-slate-100 text-[#002F5F] hover:bg-slate-200'
                }`}
              >
                {label}
              </button>
            ))}
          </div>
        </nav>
      )}

      <main className="flex-1 max-w-6xl w-full mx-auto p-6">
        {statusMsg && (
          <div className="mb-4 p-3 rounded bg-blue-50 border border-blue-200 text-xs text-[#002F5F] font-medium">
            {statusMsg}
          </div>
        )}

        {/* STAGE 0: AUTHENTICATION */}
        {!user && (
          <div className="max-w-md mx-auto bg-white rounded-lg border border-slate-300 border-t-4 border-t-[#002F5F] p-6 shadow-sm">
            <h2 className="text-lg font-bold text-[#002F5F] mb-1">
              {authMode === 'LOGIN'
                ? 'Taxpayer Vault Sign In'
                : authMode === 'REGISTER'
                  ? 'Create Multi-Year Taxpayer Account'
                  : 'Verify 6-Digit SMS OTP'}
            </h2>
            <p className="text-xs text-slate-500 mb-4">Protected by +27 mobile OTP verification & POPIA consent gate.</p>

            {sandboxOtp && (
              <div className="mb-4 p-3 bg-amber-50 border border-amber-300 rounded text-xs text-amber-900">
                <strong>Local Dev Sandbox OTP:</strong> <span className="font-mono text-sm font-bold">{sandboxOtp}</span>
              </div>
            )}

            <form onSubmit={handleAuthSubmit} className="space-y-3">
              {authMode === 'REGISTER' && (
                <>
                  <input name="fullName" required placeholder="Full Legal Name (e.g. Ryan Pillay)" className="w-full border rounded px-3 py-2 text-sm" />
                  <input name="email" type="email" required placeholder="Email Address" className="w-full border rounded px-3 py-2 text-sm" />
                  <input name="phone" required placeholder="SA Mobile Number (e.g. 0821234567)" className="w-full border rounded px-3 py-2 text-sm" />
                  <input name="password" type="password" required placeholder="Create Password" className="w-full border rounded px-3 py-2 text-sm" />
                  <label className="flex items-start gap-2 text-xs text-slate-600">
                    <input type="checkbox" name="popiaConsent" defaultChecked required className="mt-0.5" />
                    <span>I consent to POPIA processing of my financial records for South African tax calculation.</span>
                  </label>
                  <label className="flex items-start gap-2 text-xs text-slate-600">
                    <input type="checkbox" name="specialDataConsent" defaultChecked className="mt-0.5" />
                    <span>I consent to processing Special Personal Information (Medical Aid data under POPIA Sec 26).</span>
                  </label>
                </>
              )}

              {authMode === 'LOGIN' && (
                <>
                  <input name="identifier" required placeholder="Email or SA Mobile (+27 / 082...)" className="w-full border rounded px-3 py-2 text-sm" />
                  <input name="password" type="password" required placeholder="Password" className="w-full border rounded px-3 py-2 text-sm" />
                </>
              )}

              {authMode === 'OTP' && (
                <input
                  name="otp"
                  maxLength={6}
                  defaultValue={sandboxOtp}
                  required
                  placeholder="Enter 6-Digit SMS OTP"
                  className="w-full border rounded px-3 py-2 text-center tracking-widest font-mono text-lg"
                />
              )}

              <button
                type="submit"
                disabled={loading}
                className="w-full flex items-center justify-center gap-2 bg-[#002F5F] hover:bg-[#007A87] text-white font-semibold py-2 rounded text-sm"
              >
                {loading && <Loader2 className="w-4 h-4 animate-spin" />}
                <span>{authMode === 'OTP' ? 'Verify Code & Enter Vault' : 'Continue with SMS OTP'}</span>
              </button>
            </form>

            <div className="mt-4 pt-3 border-t text-center">
              <button
                type="button"
                onClick={() => setAuthMode(authMode === 'LOGIN' ? 'REGISTER' : 'LOGIN')}
                className="text-xs font-semibold text-[#007A87] hover:underline"
              >
                {authMode === 'LOGIN' ? 'New Taxpayer? Register Account' : 'Already Registered? Sign In'}
              </button>
            </div>
          </div>
        )}

        {/* STAGE 1 */}
        {user && stage === 1 && (
          <div className="bg-white rounded-lg border border-slate-300 border-t-4 border-t-[#002F5F] p-6 shadow-sm">
            <h2 className="text-lg font-bold text-[#002F5F]">Stage 1: Taxpayer Classification & Consideration Scope</h2>
            <p className="text-xs text-slate-600 mb-5">
              Select your assessment year, classification, and applicable deduction checkboxes. All Rand values are parsed from your documents in Stage 2.
            </p>

            <div className="grid md:grid-cols-2 gap-6">
              <div className="space-y-4">
                <div>
                  <label className="block text-xs font-bold text-slate-700 mb-1">SARS Assessment Year (1 Mar – 28/29 Feb)</label>
                  <select
                    value={assessmentYear}
                    onChange={(e) => setAssessmentYear(Number(e.target.value))}
                    className="w-full border rounded px-3 py-2 text-sm"
                  >
                    <option value={2027}>2027 Tax Year (1 Mar 2026 – 28 Feb 2027)</option>
                    <option value={2026}>2026 Tax Year (1 Mar 2025 – 28 Feb 2026)</option>
                  </select>
                </div>

                <div>
                  <label className="block text-xs font-bold text-slate-700 mb-1">Taxpayer Classification</label>
                  <select
                    value={classification}
                    onChange={(e) => setClassification(e.target.value)}
                    className="w-full border rounded px-3 py-2 text-sm"
                  >
                    <option value="SALARIED_EMPLOYEE">Salaried Employee (IRP5 Only)</option>
                    <option value="COMMISSION_EARNER">Commission Earner (&gt;50% Commission)</option>
                    <option value="PROVISIONAL_IRP6">Provisional Taxpayer (IRP6)</option>
                    <option value="SOLE_PROPRIETOR_SIDE_BUSINESS">Registered Sole Proprietor / Side-Business</option>
                  </select>
                </div>

                <div>
                  <label className="block text-xs font-bold text-slate-700 mb-1">Taxpayer Age (Determines Section 6 Rebates)</label>
                  <input
                    type="number"
                    value={age}
                    onChange={(e) => setAge(Number(e.target.value))}
                    className="w-full border rounded px-3 py-2 text-sm"
                  />
                </div>
              </div>

              <div className="bg-slate-50 p-4 rounded border border-slate-200 space-y-2.5">
                <p className="text-xs font-bold text-[#002F5F] uppercase">Tax Factors to Evaluate</p>
                {[
                  ['ra', 'Section 11F Retirement Annuity Contributions (Code 4006)'],
                  ['medical', 'Section 6A/6B Medical Aid & Out-of-Pocket Receipts (Code 4005 / 4020)'],
                  ['homeOffice', 'Section 23(b) Dedicated Home Office Utilities & Fibre (Code 4028)'],
                  ['travelLogbook', 'Section 8(1) Business Travel Logbook & Fuel (Code 4014)'],
                  ['interestTfsa', 'Section 10(1)(i) Local Interest Exemption (Code 4201)'],
                  ['donations18a', 'Section 18A Public Benefit Organisation Donations (Code 4011)'],
                  ['sideBusiness', 'Section 11(a) Side-Business Revenue & Operating Costs (Code 3616)'],
                ].map(([key, label]) => (
                  <label key={key} className="flex items-center gap-2.5 text-xs text-slate-800 cursor-pointer">
                    <input
                      type="checkbox"
                      checked={Boolean(scopeFlags[key])}
                      onChange={(e) => setScopeFlags({ ...scopeFlags, [key]: e.target.checked })}
                    />
                    <span>{label}</span>
                  </label>
                ))}
              </div>
            </div>

            <div className="mt-6 flex justify-end">
              <button
                onClick={saveStage1AndContinue}
                disabled={loading}
                className="bg-[#002F5F] hover:bg-[#007A87] text-white px-5 py-2 rounded text-sm font-semibold"
              >
                {loading ? 'Saving...' : 'Save Scope & Proceed to Stage 2 →'}
              </button>
            </div>
          </div>
        )}

        {/* STAGE 2 */}
        {user && stage === 2 && (
          <div className="bg-white rounded-lg border border-slate-300 border-t-4 border-t-[#002F5F] p-6 shadow-sm">
            <div className="flex flex-wrap items-center justify-between gap-2 mb-2">
              <h2 className="text-lg font-bold text-[#002F5F]">Stage 2: Categorized Document Upload & SHA-256 Vault</h2>
              <button
                type="button"
                onClick={handleLoadSampleStatement}
                className="flex items-center gap-1.5 bg-amber-100 hover:bg-amber-200 text-amber-900 border border-amber-300 px-3 py-1.5 rounded text-xs font-bold"
              >
                <Zap className="w-3.5 h-3.5" /> Load Sample SA Bank Statement (Instant Demo)
              </button>
            </div>
            <p className="text-xs text-slate-600 mb-4">
              Upload your PDF/CSV statements or click the sample button above to test live SHA-256 deduplication and SARS source-code classification.
            </p>

            <div className="grid md:grid-cols-2 gap-4 mb-4">
              <div>
                <label className="block text-xs font-bold text-slate-700 mb-1">Select Document Category</label>
                <select
                  value={docCategory}
                  onChange={(e) => setDocCategory(e.target.value)}
                  className="w-full border rounded px-3 py-2 text-sm"
                >
                  <option value="BANK_STATEMENT">Bank Statement (FNB / Capitec / Standard / Nedbank / Absa)</option>
                  <option value="IRP5">IRP5 / IT3(a) Employee Tax Certificate</option>
                  <option value="RA_IT3F">Retirement Annuity Tax Certificate (IT3f)</option>
                  <option value="MEDICAL">Medical Aid Certificate & Pharmacy Invoices</option>
                  <option value="ITSA">Final SARS Statement of Account (ITSA — Locks Year)</option>
                </select>
              </div>
              <div>
                <label className="block text-xs font-bold text-slate-700 mb-1">Upload PDF or CSV Files</label>
                <input
                  type="file"
                  multiple
                  accept=".pdf,.csv,.txt"
                  onChange={(e) => handleFileUpload(e.target.files)}
                  className="w-full border rounded px-3 py-1.5 text-sm bg-slate-50"
                />
              </div>
            </div>

            {documents.length > 0 && (
              <div className="mt-4 border rounded p-3 bg-slate-50">
                <p className="text-xs font-bold text-[#002F5F] mb-2">Vaulted Documents ({documents.length})</p>
                <div className="space-y-1.5 text-xs">
                  {documents.map((doc) => (
                    <div key={doc.id} className="flex justify-between bg-white p-2 rounded border">
                      <span className="font-semibold">{doc.fileName} ({doc.docCategory})</span>
                      <span className="font-mono text-slate-500">SHA-256: {doc.sha256Hash.slice(0, 16)}...</span>
                    </div>
                  ))}
                </div>
              </div>
            )}

            <div className="mt-6 flex justify-between">
              <button onClick={() => setStage(1)} className="border border-slate-300 px-4 py-2 rounded text-sm font-semibold">
                ← Back
              </button>
              <button onClick={() => setStage(3)} className="bg-[#002F5F] hover:bg-[#007A87] text-white px-5 py-2 rounded text-sm font-semibold">
                Review Parsed Ledger ({transactions.length} items) →
              </button>
            </div>
          </div>
        )}

        {/* STAGE 3 */}
        {user && stage === 3 && (
          <div className="bg-white rounded-lg border border-slate-300 border-t-4 border-t-[#002F5F] p-6 shadow-sm">
            <h2 className="text-lg font-bold text-[#002F5F]">Stage 3: Uncertain Item Clarification & Source-Code Ledger</h2>
            <p className="text-xs text-slate-600 mb-4">
              Review parsed bank transactions and verify your IRP5 summary figures before running the deterministic South African tax engine.
            </p>

            {/* IRP5 Certificate Summary Inputs */}
            <div className="grid grid-cols-2 md:grid-cols-4 gap-3 bg-slate-50 p-4 rounded border mb-5 text-xs">
              <div>
                <label className="block font-bold text-slate-700 mb-1">IRP5 Gross Income (3601)</label>
                <input
                  type="number"
                  value={irp5Totals.gross3601}
                  onChange={(e) => setIrp5Totals({ ...irp5Totals, gross3601: Number(e.target.value) })}
                  className="w-full border rounded px-2 py-1.5 bg-white font-mono"
                />
              </div>
              <div>
                <label className="block font-bold text-slate-700 mb-1">PAYE Withheld (4102)</label>
                <input
                  type="number"
                  value={irp5Totals.paye4102}
                  onChange={(e) => setIrp5Totals({ ...irp5Totals, paye4102: Number(e.target.value) })}
                  className="w-full border rounded px-2 py-1.5 bg-white font-mono"
                />
              </div>
              <div>
                <label className="block font-bold text-slate-700 mb-1">RA Contributions (4006)</label>
                <input
                  type="number"
                  value={irp5Totals.ra4006}
                  onChange={(e) => setIrp5Totals({ ...irp5Totals, ra4006: Number(e.target.value) })}
                  className="w-full border rounded px-2 py-1.5 bg-white font-mono"
                />
              </div>
              <div>
                <label className="block font-bold text-slate-700 mb-1">Medical Contrib (4005)</label>
                <input
                  type="number"
                  value={irp5Totals.med4005}
                  onChange={(e) => setIrp5Totals({ ...irp5Totals, med4005: Number(e.target.value) })}
                  className="w-full border rounded px-2 py-1.5 bg-white font-mono"
                />
              </div>
            </div>

            {unclarifiedItems.length > 0 && (
              <div className="bg-amber-50 border-l-4 border-amber-500 p-4 rounded mb-5 space-y-3">
                <div className="flex items-center gap-2 text-amber-900 font-bold text-xs">
                  <AlertTriangle className="w-4 h-4" />
                  <span>{unclarifiedItems.length} Ambiguous Item(s) Require Confirmation</span>
                </div>
                {unclarifiedItems.map((item) => (
                  <div key={item.id} className="flex flex-wrap items-center justify-between gap-3 bg-white p-3 rounded border border-amber-200 text-xs">
                    <div>
                      <span className="font-mono font-bold">{item.txDate}</span> — {item.description} (<strong>R {item.amount.toFixed(2)}</strong>)
                    </div>
                    <div className="flex items-center gap-2">
                      <select
                        defaultValue={item.sarsCode}
                        onChange={(e) => clarifyTransaction(item.id, e.target.value)}
                        className="border rounded px-2 py-1"
                      >
                        <option value="9999">9999 — Non-Taxable Personal / Private</option>
                        <option value="3616">3616 — Taxable Trade / Business Turnover</option>
                        <option value="4014">4014 — Business Travel (Logbook Verified)</option>
                        <option value="4020">4020 — Qualifying Out-of-Pocket Medical</option>
                      </select>
                      <button
                        onClick={() => clarifyTransaction(item.id, item.sarsCode)}
                        className="bg-[#007A87] text-white px-3 py-1 rounded font-semibold"
                      >
                        Confirm
                      </button>
                    </div>
                  </div>
                ))}
              </div>
            )}

            {transactions.length > 0 && (
              <div className="overflow-x-auto border rounded mb-5">
                <table className="w-full text-left text-xs">
                  <thead className="bg-slate-100 text-slate-700 font-bold">
                    <tr>
                      <th className="p-2.5">Date</th>
                      <th className="p-2.5">POPIA-Scrubbed Description</th>
                      <th className="p-2.5">SARS Code</th>
                      <th className="p-2.5 text-right">Amount (ZAR)</th>
                    </tr>
                  </thead>
                  <tbody className="divide-y">
                    {transactions.map((tx) => (
                      <tr key={tx.id}>
                        <td className="p-2.5 font-mono">{tx.txDate}</td>
                        <td className="p-2.5">{tx.description}</td>
                        <td className="p-2.5 font-mono font-bold text-[#002F5F]">{tx.sarsCode}</td>
                        <td className="p-2.5 text-right font-mono">R {tx.amount.toFixed(2)}</td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            )}

            <div className="mt-6 flex justify-between">
              <button onClick={() => setStage(2)} className="border border-slate-300 px-4 py-2 rounded text-sm font-semibold">
                ← Back
              </button>
              <button
                onClick={() => runCalculation(false)}
                disabled={loading}
                className="bg-[#002F5F] hover:bg-[#007A87] text-white px-5 py-2 rounded text-sm font-semibold"
              >
                {loading ? 'Calculating...' : 'Run Deterministic SARS Tax Calculation →'}
              </button>
            </div>
          </div>
        )}

        {/* STAGE 4 */}
        {user && stage === 4 && preview && (
          <div className="bg-white rounded-lg border border-slate-300 border-t-4 border-t-[#002F5F] p-6 shadow-sm">
            <h2 className="text-lg font-bold text-[#002F5F]">Stage 4: Calculated Assessment Preview & Unlock</h2>
            <p className="text-xs text-slate-600 mb-4">
              Calculated directly using South African Income Tax Act (1962) progressive brackets, Section 11F caps, and Section 6A/6B medical credits.
            </p>

            <table className="w-full text-left border-collapse text-sm mb-5">
              <thead>
                <tr className="bg-[#002F5F] text-white text-xs">
                  <th className="p-3">Assessment Component</th>
                  <th className="p-3 text-right">Calculated Amount</th>
                </tr>
              </thead>
              <tbody className="divide-y divide-slate-200 text-xs">
                <tr>
                  <td className="p-3 font-semibold">Total Assessable Gross Income</td>
                  <td className="p-3 text-right font-mono font-bold">R {preview.totalGrossIncome.toLocaleString('en-ZA', { minimumFractionDigits: 2 })}</td>
                </tr>
                <tr>
                  <td className="p-3 font-semibold">Total Statutory Deductions & Exemptions</td>
                  <td className="p-3 text-right font-mono text-emerald-700 font-bold">
                    - R {preview.totalDeductionsAndExemptions.toLocaleString('en-ZA', { minimumFractionDigits: 2 })}
                  </td>
                </tr>
                <tr>
                  <td className="p-3 font-semibold">Rebates & Medical Tax Credits (Sec 6 / 6A / 6B)</td>
                  <td className="p-3 text-right font-mono text-emerald-700 font-bold">
                    - R {preview.totalTaxCredits.toLocaleString('en-ZA', { minimumFractionDigits: 2 })}
                  </td>
                </tr>
                <tr className="bg-slate-50 font-bold text-sm">
                  <td className="p-3 text-[#002F5F]">Estimated Net SARS Outcome</td>
                  <td className={`p-3 text-right font-mono ${preview.netRefundOrPayable >= 0 ? 'text-emerald-700' : 'text-red-700'}`}>
                    {preview.netRefundOrPayable >= 0
                      ? `+ R ${preview.netRefundOrPayable.toLocaleString('en-ZA', { minimumFractionDigits: 2 })} (Refund Due)`
                      : `- R ${Math.abs(preview.netRefundOrPayable).toLocaleString('en-ZA', { minimumFractionDigits: 2 })} (Payable to SARS)`}
                  </td>
                </tr>
              </tbody>
            </table>

            {preview.advisories.length > 0 && (
              <div className="mb-5 space-y-2">
                <p className="text-xs font-bold text-[#002F5F]">Optimization & Audit Defense Advisories (Risk Score: {preview.auditRiskScore}/100)</p>
                {preview.advisories.map((adv, idx) => (
                  <div key={idx} className="p-3 bg-slate-50 border rounded text-xs">
                    <span className="font-bold text-[#002F5F]">[{adv.priority}] {adv.area}:</span> {adv.finding} — <em>{adv.actionStep}</em>
                  </div>
                ))}
              </div>
            )}

            <div className="bg-slate-50 p-4 rounded border border-slate-200 mb-5">
              <label className="flex items-start gap-2.5 text-xs text-slate-800 cursor-pointer">
                <input
                  type="checkbox"
                  checked={truthConfirmed}
                  onChange={(e) => setTruthConfirmed(e.target.checked)}
                  className="mt-0.5"
                />
                <span>
                  <strong>Declaration of Accuracy:</strong> I confirm all details and supporting documents provided are true, accurate, and complete in terms of the Tax Administration Act (Act No. 28 of 2011).
                </span>
              </label>
            </div>

            <div className="flex flex-wrap items-center justify-between gap-3">
              <button onClick={() => setStage(3)} className="border border-slate-300 px-4 py-2 rounded text-xs font-semibold">
                ← Edit Ledger / Figures
              </button>

              <button
                disabled={!truthConfirmed || loading}
                onClick={() => runCalculation(true)}
                className="flex items-center gap-2 bg-[#007A87] disabled:bg-slate-300 text-white px-5 py-2.5 rounded text-sm font-bold"
              >
                <CreditCard className="w-4 h-4" />
                <span>Unlock Full eFiling Guide & Auto-Fill (Sandbox Instant Unlock)</span>
              </button>
            </div>
          </div>
        )}

        {/* STAGE 5 */}
        {user && stage === 5 && unlockedDetails && (
          <div className="bg-white rounded-lg border border-slate-300 border-t-4 border-t-[#007A87] p-6 shadow-sm">
            <div className="flex flex-wrap items-center justify-between gap-3 mb-4">
              <div>
                <h2 className="text-lg font-bold text-[#002F5F]">Stage 5: Guided SARS eFiling Execution & Auto-Fill</h2>
                <p className="text-xs text-slate-600">
                  Log into SARS eFiling in Chrome, open your ITR12 form, and trigger Auto-Fill or follow each single instruction below.
                </p>
              </div>
              <button
                onClick={triggerChromeExtensionAutoFill}
                className="bg-[#C59B27] text-[#002F5F] px-4 py-2 rounded text-xs font-bold shadow-sm hover:opacity-95"
              >
                ⚡ Auto-Fill All Applicable SARS Boxes
              </button>
            </div>

            {unlockedDetails.eFilingSteps.length > 0 && (
              <div className="bg-[#F4F6F9] border-2 border-[#002F5F] rounded-lg p-6 max-w-2xl mx-auto my-4">
                <div className="flex justify-between text-xs font-bold text-[#007A87] mb-2">
                  <span>
                    STEP {currentStepIdx + 1} OF {unlockedDetails.eFilingSteps.length}
                  </span>
                  <span>{unlockedDetails.eFilingSteps[currentStepIdx].container}</span>
                </div>

                <h3 className="text-base font-bold text-[#002F5F] mb-2">{unlockedDetails.eFilingSteps[currentStepIdx].label}</h3>
                <p className="text-sm text-slate-700 mb-4">{unlockedDetails.eFilingSteps[currentStepIdx].instruction}</p>

                <div className="flex items-center justify-between bg-white border border-slate-300 rounded px-4 py-3 mb-5">
                  <span className="font-mono text-lg font-bold text-[#002F5F]">{unlockedDetails.eFilingSteps[currentStepIdx].value}</span>
                  <button
                    onClick={() => navigator.clipboard.writeText(unlockedDetails.eFilingSteps[currentStepIdx].value)}
                    className="flex items-center gap-1 text-xs font-semibold text-[#007A87] hover:underline"
                  >
                    <Copy className="w-3.5 h-3.5" /> Copy Value
                  </button>
                </div>

                <div className="flex items-center justify-between">
                  <button
                    disabled={currentStepIdx === 0}
                    onClick={() => setCurrentStepIdx((i) => Math.max(0, i - 1))}
                    className="flex items-center gap-1 border border-slate-300 bg-white disabled:opacity-40 px-4 py-2 rounded text-xs font-semibold"
                  >
                    <ArrowLeft className="w-3.5 h-3.5" /> Back
                  </button>

                  {currentStepIdx < unlockedDetails.eFilingSteps.length - 1 ? (
                    <button
                      onClick={() => setCurrentStepIdx((i) => i + 1)}
                      className="flex items-center gap-1.5 bg-[#002F5F] hover:bg-[#007A87] text-white px-5 py-2 rounded text-xs font-bold"
                    >
                      <CheckCircle2 className="w-4 h-4" /> Done — Next Instruction
                    </button>
                  ) : (
                    <button
                      onClick={() => setStage(6)}
                      className="flex items-center gap-1.5 bg-emerald-700 text-white px-5 py-2 rounded text-xs font-bold"
                    >
                      <CheckCircle2 className="w-4 h-4" /> All Fields Captured — Proceed to Stage 6
                    </button>
                  )}
                </div>
              </div>
            )}
          </div>
        )}

        {/* STAGE 6 */}
        {user && stage === 6 && (
          <div className="bg-white rounded-lg border border-slate-300 border-t-4 border-t-[#002F5F] p-6 shadow-sm space-y-5">
            <h2 className="text-lg font-bold text-[#002F5F]">Stage 6: SARS Calculation Verification, ITA34 Assessment & Final Lock</h2>

            <div className="grid md:grid-cols-3 gap-4 text-xs">
              <div className="border rounded p-4 bg-slate-50">
                <div className="flex items-center gap-2 font-bold text-[#002F5F] mb-2">
                  <FileText className="w-4 h-4" /> 1. Pre-Submission Calculation
                </div>
                <p className="text-slate-600 mb-3">
                  Upload your SARS eFiling calculation summary PDF to verify compliance before clicking Submit.
                </p>
                <input
                  type="file"
                  accept=".pdf"
                  onChange={(e) => {
                    setDocCategory('ITR12');
                    handleFileUpload(e.target.files);
                  }}
                  className="w-full text-xs"
                />
              </div>

              <div className="border rounded p-4 bg-slate-50">
                <div className="flex items-center gap-2 font-bold text-[#002F5F] mb-2">
                  <AlertTriangle className="w-4 h-4 text-amber-600" /> 2. Notice of Assessment (ITA34)
                </div>
                <p className="text-slate-600 mb-3">
                  Upload your SARS ITA34 notice to check for disallowed deductions or Request for Correction (RFC) eligibility.
                </p>
                <input
                  type="file"
                  accept=".pdf"
                  onChange={(e) => {
                    setDocCategory('ITA34');
                    handleFileUpload(e.target.files);
                  }}
                  className="w-full text-xs"
                />
              </div>

              <div className="border rounded p-4 bg-slate-50">
                <div className="flex items-center gap-2 font-bold text-[#002F5F] mb-2">
                  <Lock className="w-4 h-4 text-emerald-700" /> 3. Statement of Account (ITSA)
                </div>
                <p className="text-slate-600 mb-3">
                  Upload your final SARS Statement of Account confirming settlement/refund to permanently lock this tax year.
                </p>
                <input
                  type="file"
                  accept=".pdf"
                  onChange={(e) => {
                    setDocCategory('ITSA');
                    handleFileUpload(e.target.files);
                  }}
                  className="w-full text-xs"
                />
              </div>
            </div>
          </div>
        )}
      </main>
    </div>
  );
}
