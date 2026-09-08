import { marked } from "marked";

marked.setOptions({
  gfm: true,
  breaks: true,
});

const ALLOWED_TAGS = new Set([
  "P",
  "BR",
  "STRONG",
  "EM",
  "B",
  "I",
  "U",
  "S",
  "DEL",
  "INS",
  "CODE",
  "PRE",
  "KBD",
  "BLOCKQUOTE",
  "UL",
  "OL",
  "LI",
  "H1",
  "H2",
  "H3",
  "H4",
  "H5",
  "H6",
  "TABLE",
  "THEAD",
  "TBODY",
  "TFOOT",
  "TR",
  "TH",
  "TD",
  "HR",
  "A",
  "IMG",
  "SPAN",
  "DIV",
  "INPUT",
  "SUP",
  "SUB",
]);

const ALLOWED_ATTR = {
  A: ["href", "title"],
  IMG: ["src", "alt", "title"],
  TD: ["align", "colspan", "rowspan"],
  TH: ["align", "colspan", "rowspan"],
  INPUT: ["type", "checked", "disabled"],
  CODE: ["class"],
  PRE: ["class"],
  DIV: ["class"],
  SPAN: ["class"],
  OL: ["start"],
  LI: ["class"],
};

function safeHref(value) {
  const href = String(value || "").trim();
  if (/^(https?:|mailto:|#)/i.test(href)) return href;
  return "";
}

function safeSrc(value) {
  const src = String(value || "").trim();
  if (/^https?:\/\//i.test(src) || /^data:image\//i.test(src)) return src;
  return "";
}

function sanitize(html) {
  if (typeof DOMParser === "undefined") return html;
  const doc = new DOMParser().parseFromString(`<div>${html}</div>`, "text/html");
  const root = doc.body.firstChild;
  if (!root) return "";

  const walk = (node) => {
    let child = node.firstChild;
    while (child) {
      const next = child.nextSibling;
      if (child.nodeType === 8) {
        child.remove();
        child = next;
        continue;
      }
      if (child.nodeType !== 1) {
        child = next;
        continue;
      }
      if (!ALLOWED_TAGS.has(child.tagName)) {
        const first = child.firstChild;
        while (child.firstChild) node.insertBefore(child.firstChild, child);
        child.remove();
        child = first || next;
        continue;
      }
      const allowed = ALLOWED_ATTR[child.tagName] || [];
      for (const attr of [...child.attributes]) {
        if (!allowed.includes(attr.name.toLowerCase())) child.removeAttribute(attr.name);
      }
      if (child.tagName === "A") {
        const href = safeHref(child.getAttribute("href"));
        if (href) {
          child.setAttribute("href", href);
          child.setAttribute("rel", "noreferrer noopener");
        } else {
          child.removeAttribute("href");
        }
      } else if (child.tagName === "IMG") {
        const src = safeSrc(child.getAttribute("src"));
        if (src) child.setAttribute("src", src);
        else {
          child.remove();
          child = next;
          continue;
        }
      } else if (child.tagName === "INPUT") {
        if (child.getAttribute("type") !== "checkbox") {
          child.remove();
          child = next;
          continue;
        }
        child.setAttribute("disabled", "");
      }
      walk(child);
      child = next;
    }
  };

  walk(root);
  return root.innerHTML;
}

function wrapTables(html) {
  return String(html)
    .replaceAll("<table>", '<div class="md-table"><table>')
    .replaceAll("</table>", "</table></div>");
}

export function renderMarkdown(text) {
  if (!text) return "";
  try {
    const html = marked.parse(String(text), { async: false });
    return sanitize(wrapTables(typeof html === "string" ? html : ""));
  } catch {
    return "";
  }
}
