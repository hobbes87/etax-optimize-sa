window.addEventListener('message', (event) => {
  if (event.source !== window) return;
  if (event.data && event.data.type === 'ETAX_OPTIMIZE_AUTOFILL') {
    chrome.storage.local.set({ pendingTaxPayload: event.data.payload }, () => {
      console.log('[eTaxOptimize SA] Source-code payload cached for SARS eFiling.');
    });
  }
});

if (window.location.hostname.includes('sarsefiling.co.za')) {
  const btn = document.createElement('button');
  btn.textContent = '⚡ Auto-Fill Verified Tax Figures';
  Object.assign(btn.style, {
    position: 'fixed',
    bottom: '20px',
    right: '20px',
    zIndex: '999999',
    backgroundColor: '#002F5F',
    color: '#FFFFFF',
    border: '2px solid #C59B27',
    borderRadius: '6px',
    padding: '10px 16px',
    fontWeight: 'bold',
    cursor: 'pointer',
    boxShadow: '0 4px 12px rgba(0,0,0,0.25)',
  });

  btn.addEventListener('click', () => {
    chrome.storage.local.get(['pendingTaxPayload'], ({ pendingTaxPayload }) => {
      if (!pendingTaxPayload) {
        alert('No unlocked tax payload found. Trigger Auto-Fill from your eTaxOptimize SA dashboard first.');
        return;
      }

      let filledCount = 0;
      const allLabels = Array.from(document.querySelectorAll('label, td, span, div'));

      Object.entries(pendingTaxPayload).forEach(([sarsCode, amountValue]) => {
        const anchor = allLabels.find(
          (el) => el.children.length === 0 && el.textContent && el.textContent.trim() === sarsCode
        );
        if (anchor && anchor.parentElement) {
          const container = anchor.closest('tr') || anchor.parentElement.parentElement || anchor.parentElement;
          const targetInput = container ? container.querySelector('input[type="text"], input[type="number"]') : null;
          if (targetInput && !targetInput.disabled && !targetInput.readOnly) {
            targetInput.focus();
            targetInput.value = String(amountValue);
            targetInput.dispatchEvent(new Event('input', { bubbles: true }));
            targetInput.dispatchEvent(new Event('change', { bubbles: true }));
            targetInput.style.backgroundColor = '#ECFDF5';
            filledCount++;
          }
        }
      });

      alert(`eTaxOptimize SA populated ${filledCount} SARS source-code field(s). Please review before clicking Save & Calculate.`);
    });
  });

  document.body.appendChild(btn);
}
