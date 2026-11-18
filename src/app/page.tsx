"use client";

import { FormEvent, useState } from "react";

export default function Home() {
  const stages = [
    "Vault",
    "Taxpayer profile",
    "Documents",
    "Source codes",
    "Preview",
    "eFiling",
  ];
  const [stage, setStage] = useState(0);
  const [taxpayerType, setTaxpayerType] = useState("Salaried Employee");
  const [age, setAge] = useState("");
  const [medicalConsent, setMedicalConsent] = useState(false);
  const [financialConsent, setFinancialConsent] = useState(false);
  const [aiConsent, setAiConsent] = useState(false);
  const [grossIncome, setGrossIncome] = useState("");
  const [deductions, setDeductions] = useState("");
  const [result, setResult] = useState<Record<string, number> | null>(null);
  const [loading, setLoading] = useState(false);

  async function calculate(event: FormEvent) {
    event.preventDefault();
    setLoading(true);
    try {
      const response = await fetch("/api/tax/calculate", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          grossIncome: Number(grossIncome),
          deductions: Number(deductions),
          age: Number(age),
        }),
      });
      setResult(await response.json());
    } finally {
      setLoading(false);
    }
  }

  return (
    <main className="min-h-screen bg-[#F4F6F9] text-slate-900">
      <header className="bg-[#002F5F] px-6 py-5 text-white">
        <div className="mx-auto flex max-w-6xl items-center justify-between">
          <div><strong className="text-xl">eTaxOptimize SA</strong><div className="text-xs text-slate-300">POPIA-aware tax preparation</div></div>
          <button className="rounded-md border border-white/30 px-3 py-2 text-sm">Account</button>
        </div>
      </header>
      <div className="mx-auto max-w-6xl px-6 py-8">
        <nav className="mb-8 grid grid-cols-2 gap-2 md:grid-cols-6">
          {stages.map((label, index) => (
            <button key={label} onClick={() => setStage(index)} className={`rounded-lg border px-3 py-3 text-sm ${stage === index ? "border-[#C59B27] bg-[#002F5F] text-white" : "border-slate-200 bg-white"}`}>
              {index + 1}. {label}
            </button>
          ))}
        </nav>

        {stage === 0 && (
          <section className="rounded-2xl bg-white p-8 shadow-sm">
            <h1 className="text-2xl font-bold">Tax Year Vault</h1>
            <p className="mt-2 text-slate-600">March–February tax-year records and locked archives.</p>
            <button onClick={() => setStage(1)} className="mt-6 rounded-lg bg-[#007A87] px-5 py-3 font-semibold text-white">Start 2026 tax year</button>
          </section>
        )}

        {stage === 1 && (
          <section className="rounded-2xl bg-white p-8 shadow-sm">
            <h1 className="text-2xl font-bold">Taxpayer classification</h1>
            <div className="mt-6 grid gap-5 md:grid-cols-2">
              <label><span className="block text-sm font-medium">Classification</span><select className="mt-2 w-full rounded-lg border px-3 py-2" value={taxpayerType} onChange={(event) => setTaxpayerType(event.target.value)}><option>Salaried Employee</option><option>Commission Earner</option><option>Provisional Taxpayer IRP6</option><option>Registered Sole Proprietor</option><option>Small Business Corporation</option></select></label>
              <label><span className="block text-sm font-medium">Age</span><input className="mt-2 w-full rounded-lg border px-3 py-2" type="number" min="18" value={age} onChange={(event) => setAge(event.target.value)} /></label>
            </div>
            <div className="mt-6 space-y-3">
              <label className="block"><input type="checkbox" checked={financialConsent} onChange={(event) => setFinancialConsent(event.target.checked)} /> Financial-processing consent</label>
              <label className="block"><input type="checkbox" checked={medicalConsent} onChange={(event) => setMedicalConsent(event.target.checked)} /> Special Personal Information consent (medical aid/health)</label>
              <label className="block"><input type="checkbox" checked={aiConsent} onChange={(event) => setAiConsent(event.target.checked)} /> Zero-training AI processing consent</label>
            </div>
            <button disabled={!financialConsent} onClick={() => setStage(2)} className="mt-6 rounded-lg bg-[#007A87] px-5 py-3 font-semibold text-white disabled:opacity-40">Continue</button>
          </section>
        )}

        {stage === 2 && (
          <section className="rounded-2xl bg-white p-8 shadow-sm">
            <h1 className="text-2xl font-bold">Categorized documents</h1>
            <label className="mt-6 block"><span className="block text-sm font-medium">Document category</span><select className="mt-2 w-full rounded-lg border px-3 py-2"><option>Bank Statement</option><option>IRP5 / Payslip</option><option>Prior ITR12</option><option>Medical Certificate / Receipts</option><option>RA Certificate IT3f</option><option>IT3b/c Investment Certificate</option><option>Trade/Home Office/Travel Invoices</option></select></label>
            <label className="mt-4 block"><span className="block text-sm font-medium">Upload PDF or image</span><input className="mt-2 block w-full" type="file" accept=".pdf,image/*" /></label>
            <div className="mt-6 rounded-lg border border-dashed p-5 text-sm text-slate-600">March–February coverage tracker: upload statements to update SHA-256-deduplicated coverage.</div>
            <button onClick={() => setStage(3)} className="mt-6 rounded-lg bg-[#007A87] px-5 py-3 font-semibold text-white">Continue to source codes</button>
          </section>
        )}

        {stage === 3 && (
          <section className="rounded-2xl bg-white p-8 shadow-sm">
            <h1 className="text-2xl font-bold">Source-code ledger</h1>
            <div className="mt-5 rounded-lg border-l-4 border-[#C59B27] bg-amber-50 p-4">Ambiguous items will appear here when classification confidence is below 80%.</div>
            <div className="mt-5 overflow-x-auto"><table className="w-full text-left"><thead><tr className="border-b text-sm"><th className="p-3">Source code</th><th className="p-3">Description</th><th className="p-3">Status</th></tr></thead><tbody>{["3601","3616","4201","4005","4020","4006","4028","4014","4011","9999"].map((code) => <tr key={code} className="border-b"><td className="p-3 font-semibold">{code}</td><td className="p-3">Document-derived item</td><td className="p-3 text-slate-500">Review queue</td></tr>)}</tbody></table></div>
            <button onClick={() => setStage(4)} className="mt-6 rounded-lg bg-[#007A87] px-5 py-3 font-semibold text-white">Preview totals</button>
          </section>
        )}

        {stage === 4 && (
          <section className="rounded-2xl bg-white p-8 shadow-sm">
            <h1 className="text-2xl font-bold">Free-tier calculation preview</h1>
            <form onSubmit={calculate} className="mt-6 grid gap-4 md:grid-cols-2">
              <label><span className="block text-sm font-medium">Annual gross income (R)</span><input className="mt-2 w-full rounded-lg border px-3 py-2" required min="0" type="number" value={grossIncome} onChange={(event) => setGrossIncome(event.target.value)} /></label>
              <label><span className="block text-sm font-medium">Deductions (R)</span><input className="mt-2 w-full rounded-lg border px-3 py-2" min="0" type="number" value={deductions} onChange={(event) => setDeductions(event.target.value)} /></label>
              <button className="rounded-lg bg-[#007A87] px-5 py-3 font-semibold text-white md:col-span-2" disabled={loading}>{loading ? "Calculating..." : "Calculate"}</button>
            </form>
            {result && <dl className="mt-6 grid gap-3 rounded-xl bg-[#F4F6F9] p-5 md:grid-cols-2"><div><dt className="text-sm text-slate-500">Gross income</dt><dd className="font-bold">R {result.grossIncome.toFixed(2)}</dd></div><div><dt className="text-sm text-slate-500">Total deductions</dt><dd className="font-bold">R {result.totalDeductions.toFixed(2)}</dd></div><div><dt className="text-sm text-slate-500">Rebates/credits</dt><dd className="font-bold">R {result.rebates.toFixed(2)}</dd></div><div><dt className="text-sm text-slate-500">Estimated tax</dt><dd className="font-bold">R {result.estimatedTax.toFixed(2)}</dd></div></dl>}
            {result && <label className="mt-6 block"><input type="checkbox" /> I declare that the supplied information is complete and accurate.</label>}
            <button onClick={() => setStage(5)} className="mt-6 rounded-lg bg-[#C59B27] px-5 py-3 font-semibold text-[#002F5F]">Continue to PayGate checkout</button>
          </section>
        )}

        {stage === 5 && (
          <section className="rounded-2xl bg-white p-8 shadow-sm">
            <h1 className="text-2xl font-bold">Guided SARS eFiling</h1>
            <p className="mt-3 text-slate-600">Advanced source-code mappings unlock after confirmed payment.</p>
            <ol className="mt-6 list-decimal space-y-3 pl-5"><li>Log in to your own SARS eFiling browser session.</li><li>Open the ITR12 or IRP6 form.</li><li>Choose automated fill or single-instruction walkthrough.</li><li>Upload your ITA34 and final ITSA for verification and closure.</li></ol>
          </section>
        )}
      </div>
    </main>
  );
}