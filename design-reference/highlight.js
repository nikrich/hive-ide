/* Hive IDE — lightweight syntax highlighter.
   Exposes window.highlightCode(text, lang) -> HTML string of escaped tokens.
   Re-run on every keystroke; kept simple + fast (single pass scanners). */
(function () {
  const KEYWORDS = new Set([
    "import","from","export","default","const","let","var","function","return",
    "if","else","for","while","do","switch","case","break","continue","new",
    "class","extends","implements","interface","type","enum","namespace",
    "public","private","protected","readonly","static","abstract",
    "async","await","yield","try","catch","finally","throw","typeof","instanceof",
    "in","of","as","is","keyof","void","null","undefined","true","false",
    "this","super","get","set","delete","Promise"
  ]);
  const TYPES = new Set([
    "string","number","boolean","object","unknown","any","never","bigint","symbol",
    "Array","Record","Partial","ReactNode","RequestInit"
  ]);

  function esc(s) {
    return s.replace(/[&<>]/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;" }[c]));
  }
  const span = (cls, s) => '<span class="' + cls + '">' + esc(s) + "</span>";

  /* ---- c-like / TS / JS / TSX / JSON / CSS ---- */
  function tokenizeCode(src) {
    let out = "";
    let i = 0;
    const n = src.length;
    const isIdStart = (c) => /[A-Za-z_$]/.test(c);
    const isId = (c) => /[A-Za-z0-9_$]/.test(c);

    while (i < n) {
      const c = src[i];

      // whitespace / newline — pass through raw
      if (c === "\n" || c === " " || c === "\t" || c === "\r") { out += c; i++; continue; }

      // line comment
      if (c === "/" && src[i + 1] === "/") {
        let j = i; while (j < n && src[j] !== "\n") j++;
        out += span("t-com", src.slice(i, j)); i = j; continue;
      }
      // block comment
      if (c === "/" && src[i + 1] === "*") {
        let j = i + 2; while (j < n && !(src[j] === "*" && src[j + 1] === "/")) j++;
        j = Math.min(n, j + 2);
        out += span("t-com", src.slice(i, j)); i = j; continue;
      }
      // strings (', ", `)
      if (c === "'" || c === '"' || c === "`") {
        let j = i + 1; while (j < n && src[j] !== c) { if (src[j] === "\\") j++; j++; }
        j = Math.min(n, j + 1);
        out += span("t-str", src.slice(i, j)); i = j; continue;
      }
      // numbers
      if (/[0-9]/.test(c) || (c === "." && /[0-9]/.test(src[i + 1] || ""))) {
        let j = i; while (j < n && /[0-9a-fxA-FX._]/.test(src[j])) j++;
        out += span("t-num", src.slice(i, j)); i = j; continue;
      }
      // identifiers / keywords / types / functions
      if (isIdStart(c)) {
        let j = i; while (j < n && isId(src[j])) j++;
        const word = src.slice(i, j);
        // look ahead for "(" => function call
        let k = j; while (k < n && (src[k] === " ")) k++;
        const isCall = src[k] === "(";
        if (KEYWORDS.has(word)) out += span("t-key", word);
        else if (TYPES.has(word) || /^[A-Z]/.test(word)) out += span("t-type", word);
        else if (isCall) out += span("t-fn", word);
        else out += span("t-var", word);
        i = j; continue;
      }
      // jsx / generic punctuation
      if ("{}()[];,.:".includes(c)) { out += span("t-punct", c); i++; continue; }
      if ("=+-*/%<>!&|?^~".includes(c)) { out += span("t-op", c); i++; continue; }

      out += esc(c); i++;
    }
    return out;
  }

  /* ---- markdown (line based) ---- */
  function tokenizeMd(src) {
    const lines = src.split("\n");
    let inFence = false;
    return lines.map((line) => {
      if (/^```/.test(line)) { inFence = !inFence; return span("t-com", line); }
      if (inFence) return span("t-str", line);
      if (/^#{1,6}\s/.test(line)) return span("t-md-h", line);
      if (/^\s*[-*]\s/.test(line)) {
        return line.replace(/^(\s*[-*]\s)(.*)$/, (m, b, rest) => span("t-op", b) + inlineMd(rest));
      }
      return inlineMd(line);
    }).join("\n");
  }
  function inlineMd(s) {
    // escape first, then re-introduce a couple of safe spans on the escaped text
    let e = esc(s);
    e = e.replace(/(\*\*[^*]+\*\*)/g, '<span class="t-md-b">$1</span>');
    e = e.replace(/(`[^`]+`)/g, '<span class="t-str">$1</span>');
    e = e.replace(/(\[[^\]]+\]\([^)]+\))/g, '<span class="t-fn">$1</span>');
    return e;
  }

  window.highlightCode = function (text, lang) {
    if (text == null) return "";
    try {
      if (lang === "md") return tokenizeMd(text);
      return tokenizeCode(text);
    } catch (e) {
      return esc(text);
    }
  };
})();
