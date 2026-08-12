// ScholarAssist recorder content script. Injected on demand via activeTab —
// no host permissions, nothing runs until the user clicks Record.
//
// Privacy invariant: this script NEVER reads element values. It captures
// selectors and labeling evidence only, so an exported recording is free of
// personal data by construction.
(() => {
  if (window.__scholarRecorder) return;
  window.__scholarRecorder = true;

  const events = [];

  const evidenceOf = (el) => {
    const labelEl = el.labels && el.labels[0] ? el.labels[0] : el.closest("label");
    return {
      label: labelEl ? labelEl.textContent.replace(/\s+/g, " ").trim().slice(0, 120) : undefined,
      ariaLabel: el.getAttribute("aria-label") || undefined,
      placeholder: el.getAttribute("placeholder") || undefined,
      name: el.getAttribute("name") || undefined,
      id: el.id || undefined,
      autocomplete: el.getAttribute("autocomplete") || undefined,
      type: el.getAttribute("type") || undefined,
      tag: el.tagName.toLowerCase(),
    };
  };

  const cssOf = (el) => {
    if (el.id) return "#" + CSS.escape(el.id);
    const name = el.getAttribute("name");
    if (name) return el.tagName.toLowerCase() + '[name="' + name + '"]';
    const parts = [];
    let cur = el;
    while (cur && cur.tagName !== "BODY" && parts.length < 4) {
      const siblings = cur.parentElement
        ? Array.from(cur.parentElement.children).filter((c) => c.tagName === cur.tagName)
        : [];
      parts.unshift(cur.tagName.toLowerCase() + ":nth-of-type(" + (siblings.indexOf(cur) + 1) + ")");
      cur = cur.parentElement;
    }
    return parts.join(" > ");
  };

  const selectorsOf = (el, ev) => {
    const out = [];
    const testid =
      el.getAttribute("data-testid") || el.getAttribute("data-test") || el.getAttribute("data-qa");
    if (ev.label) out.push({ label: ev.label });
    if (ev.ariaLabel) out.push({ label: ev.ariaLabel });
    if (ev.placeholder) out.push({ placeholder: ev.placeholder });
    if (testid) out.push({ testid });
    out.push({ css: cssOf(el) });
    return out;
  };

  const flash = (el) => {
    const prev = el.style.outline;
    el.style.outline = "2px solid #e8b64c";
    setTimeout(() => (el.style.outline = prev), 400);
  };

  const push = (e) => {
    events.push(e);
    chrome.storage.session.set({ scholarEvents: events, scholarUrl: location.href });
  };

  document.addEventListener(
    "input",
    (e) => {
      const el = e.target;
      if (!el || !/^(INPUT|TEXTAREA|SELECT)$/.test(el.tagName)) return;
      const ev = evidenceOf(el);
      const sig = JSON.stringify(ev) + cssOf(el);
      if (events.some((x) => x.kind === "field" && x.sig === sig)) return;
      flash(el);
      push({ kind: "field", sig, evidence: ev, selectors: selectorsOf(el, ev), ts: Date.now() });
    },
    true,
  );

  document.addEventListener(
    "click",
    (e) => {
      const el =
        e.target && e.target.closest
          ? e.target.closest("button, a, [role=button], input[type=submit]")
          : null;
      if (!el) return;
      const text = (el.innerText || el.value || "").replace(/\s+/g, " ").trim().slice(0, 80);
      const sels = [];
      if (text) sels.push({ role: el.tagName === "A" ? "link" : "button", name: text });
      const testid = el.getAttribute("data-testid");
      if (testid) sels.push({ testid });
      sels.push({ css: el.id ? "#" + CSS.escape(el.id) : el.tagName.toLowerCase() });
      push({ kind: "click", text, selectors: sels, ts: Date.now() });
    },
    true,
  );

  push({ kind: "nav", url: location.href, ts: Date.now() });
})();
