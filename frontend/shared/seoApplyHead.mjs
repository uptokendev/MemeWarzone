// Applies computed head values to a document. Pure apart from the document it is given.

const BRAND = "MemeWarzone";

function ensure(doc, selector, tag, attr) {
  let el = doc.querySelector(selector);
  if (!el) {
    el = doc.createElement(tag);
    el.setAttribute(attr[0], attr[1]);
    doc.head.appendChild(el);
  }
  return el;
}

/**
 * Merges page overrides into a head computed by headForPath.
 * A noindex result never carries a canonical.
 * @param {{ title?: string, description?: string, canonical?: string|null, robots?: string }} head
 * @param {{ robots?: string }} [overrides]
 */
export function resolveHead(head, overrides = {}) {
  const robots = overrides?.robots || head?.robots;
  const canonical = /noindex/.test(String(robots || "")) ? null : head?.canonical ?? null;
  return { ...head, robots, canonical };
}

/**
 * @param {any} doc document-like object
 * @param {{ title?: string, description?: string, canonical?: string|null, robots?: string }} head
 */
export function applyHead(doc, head) {
  const title = String(head?.title ?? "").trim();
  doc.title = !title || title === BRAND ? BRAND : `${title} · ${BRAND}`;

  const description = String(head?.description ?? "").trim();
  if (description) {
    ensure(doc, 'meta[name="description"]', "meta", ["name", "description"]).setAttribute("content", description);
  }

  const existing = doc.querySelector('link[rel="canonical"]');
  if (typeof head?.canonical === "string" && head.canonical) {
    ensure(doc, 'link[rel="canonical"]', "link", ["rel", "canonical"]).setAttribute("href", head.canonical);
  } else if (existing) {
    if (typeof existing.remove === "function") existing.remove();
    else if (existing.parentNode) existing.parentNode.removeChild(existing);
  }

  if (head?.robots) {
    ensure(doc, 'meta[name="robots"]', "meta", ["name", "robots"]).setAttribute("content", head.robots);
  }
}
