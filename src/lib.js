// lib.js — 순수 헬퍼. index.html 과 test.mjs 가 공유한다.

// NDJSON 스트림 버퍼에서 완성된 JSON 객체들을 뽑고, 잘린 마지막 줄은 rest 로 돌려준다.
export function parseNDJSON(buffer) {
  const lines = buffer.split("\n");
  const rest = lines.pop() ?? "";
  const objects = [];
  for (const line of lines) {
    const t = line.trim();
    if (!t) continue;
    try { objects.push(JSON.parse(t)); } catch { /* 깨진 줄은 버린다 */ }
  }
  return { objects, rest };
}

// Ollama /api/pull 진행 상태 → 0~100 (%). 계산 불가면 null.
export function pullPercent(s) {
  if (!s || typeof s.total !== "number" || typeof s.completed !== "number" || s.total <= 0) return null;
  return Math.max(0, Math.min(100, (s.completed / s.total) * 100));
}

// 바이트 → 사람이 읽는 단위 (1.5 GB, 340 MB …)
export function humanBytes(n) {
  if (!n || n < 0) return "0 B";
  const u = ["B", "KB", "MB", "GB", "TB"];
  let i = 0;
  while (n >= 1024 && i < u.length - 1) { n /= 1024; i++; }
  return (i === 0 ? Math.round(n) : n.toFixed(n < 10 ? 1 : 0)) + " " + u[i];
}

// 초 → 사람이 읽는 시간 (45초, 1분 20초, 2시간 5분). 계산 불가면 "—".
export function humanTime(sec) {
  if (!isFinite(sec) || sec < 0) return "—";
  sec = Math.round(sec);
  if (sec < 60) return sec + "초";
  const m = Math.floor(sec / 60), s = sec % 60;
  if (m < 60) return s ? `${m}분 ${s}초` : `${m}분`;
  const h = Math.floor(m / 60);
  return `${h}시간 ${m % 60}분`;
}

// 다운로드 두 시점(prev/cur: {completed, total, t(ms)})으로 속도(B/s)와 남은시간(초) 추정.
export function pullRate(prev, cur) {
  if (!prev || !cur || !(cur.t > prev.t)) return { bytesPerSec: null, etaSec: null };
  const bps = (cur.completed - prev.completed) / ((cur.t - prev.t) / 1000);
  if (!(bps > 0)) return { bytesPerSec: null, etaSec: null };
  const rem = (cur.total || 0) - cur.completed;
  return { bytesPerSec: bps, etaSec: rem > 0 ? rem / bps : 0 };
}

// Ollama 오류 응답 본문에서 사람이 읽을 메시지를 뽑는다. Ollama 는 때때로
// {"error": "{\"error\":{\"message\":\"...\"}}"} 처럼 JSON 문자열을 여러 겹 감싸 보낸다.
export function ollamaError(text, fallback) {
  try {
    let e = JSON.parse(text).error;
    for (let i = 0; i < 3 && typeof e === "string"; i++) {
      try {
        const inner = JSON.parse(e);
        e = inner.error ?? inner.message ?? e;
        if (typeof e === "string") return e;
      } catch { break; }
    }
    return (e && (e.message || (typeof e === "string" ? e : null))) || fallback;
  } catch {
    return fallback;
  }
}

// Ollama는 `model`과 `model:latest`를 같은 기본 태그로 취급하는 경우가 있다.
// 저장된 오래된 대화가 현재 설치 목록에 있는지 확인할 때만 이 차이를 흡수한다.
export function modelRefKey(name) {
  return String(name || "").trim().toLowerCase().replace(/:latest$/, "");
}

export function isInstalledModel(name, installed) {
  const key = modelRefKey(name);
  return !!key && Array.isArray(installed) && installed.some((m) => modelRefKey(typeof m === "string" ? m : m?.name) === key);
}

// ---------- 마크다운 렌더링 ----------
const esc = (s) => s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");

// ---------- 초간단 LaTeX 렌더링 ----------
// ponytail: 완전한 수식 엔진이 아니라 치환 기반 근사. 채팅 모델이 흔히 쓰는
// \[ \] · \( \) · $$ 안의 분수/첨자/그리스문자/기호만 처리한다.
// 제대로 된 조판이 필요해지면 KaTeX 번들로 교체.
const TEX_MAP = {
  "\\times": "×", "\\cdot": "·", "\\div": "÷", "\\pm": "±", "\\mp": "∓", "\\ast": "∗",
  "\\leq": "≤", "\\le": "≤", "\\geq": "≥", "\\ge": "≥", "\\neq": "≠", "\\ne": "≠",
  "\\approx": "≈", "\\equiv": "≡", "\\sim": "∼", "\\propto": "∝", "\\ll": "≪", "\\gg": "≫",
  "\\leftrightarrow": "↔", "\\rightarrow": "→", "\\leftarrow": "←", "\\Rightarrow": "⇒",
  "\\Leftarrow": "⇐", "\\iff": "⇔", "\\mapsto": "↦", "\\to": "→", "\\gets": "←",
  "\\infty": "∞", "\\partial": "∂", "\\nabla": "∇", "\\sum": "∑", "\\prod": "∏",
  "\\int": "∫", "\\oint": "∮", "\\sqrt": "√",
  "\\alpha": "α", "\\beta": "β", "\\gamma": "γ", "\\delta": "δ", "\\varepsilon": "ε",
  "\\epsilon": "ε", "\\zeta": "ζ", "\\eta": "η", "\\vartheta": "ϑ", "\\theta": "θ",
  "\\iota": "ι", "\\kappa": "κ", "\\lambda": "λ", "\\mu": "μ", "\\nu": "ν", "\\xi": "ξ",
  "\\varrho": "ϱ", "\\rho": "ρ", "\\varphi": "φ", "\\phi": "φ", "\\chi": "χ", "\\psi": "ψ",
  "\\omega": "ω", "\\varpi": "ϖ", "\\pi": "π", "\\varsigma": "ς", "\\sigma": "σ",
  "\\tau": "τ", "\\upsilon": "υ",
  "\\Gamma": "Γ", "\\Delta": "Δ", "\\Theta": "Θ", "\\Lambda": "Λ", "\\Xi": "Ξ", "\\Pi": "Π",
  "\\Sigma": "Σ", "\\Upsilon": "Υ", "\\Phi": "Φ", "\\Psi": "Ψ", "\\Omega": "Ω",
  "\\in": "∈", "\\notin": "∉", "\\ni": "∋", "\\subseteq": "⊆", "\\subset": "⊂",
  "\\supseteq": "⊇", "\\supset": "⊃", "\\cup": "∪", "\\cap": "∩", "\\emptyset": "∅",
  "\\varnothing": "∅", "\\setminus": "∖", "\\forall": "∀", "\\exists": "∃", "\\neg": "¬",
  "\\land": "∧", "\\lor": "∨", "\\therefore": "∴", "\\because": "∵", "\\angle": "∠",
  "\\perp": "⊥", "\\parallel": "∥", "\\cong": "≅", "\\triangle": "△", "\\cdots": "⋯",
  "\\ldots": "…", "\\dots": "…", "\\vdots": "⋮", "\\ddots": "⋱", "\\prime": "′",
  "\\circ": "∘", "\\bullet": "∙", "\\pm ": "± ",
  "\\quad": "  ", "\\qquad": "    ", "\\,": " ", "\\;": " ", "\\:": " ", "\\!": "", "\\ ": " ",
  "\\left": "", "\\right": "", "\\displaystyle": "", "\\limits": "", "\\nolimits": "",
  "\\%": "%", "\\&": "&", "\\#": "#", "\\$": "$", "\\{": "{", "\\}": "}", "\\_": "_",
};
const TEX_KEYS = Object.keys(TEX_MAP).sort((a, b) => b.length - a.length);

export function renderTeX(tex, display) {
  let s = esc(String(tex).trim());
  for (let k = 0; k < 4; k++) {
    s = s.replace(/\\[dt]?frac\s*\{([^{}]*)\}\s*\{([^{}]*)\}/g,
      '<span class="tex-frac"><span>$1</span><span>$2</span></span>');
  }
  s = s.replace(/\\sqrt\s*\{([^{}]*)\}/g, '<span class="tex-sqrt">$1</span>');
  s = s.replace(/\\boxed\s*\{([^{}]*)\}/g, '<span class="tex-boxed">$1</span>');
  s = s.replace(/\\(?:text|textbf|textit|mathrm|mathbf|mathit|mathcal|mathbb|operatorname)\s*\{([^{}]*)\}/g, "$1");
  s = s.replace(/\^\{([^{}]+)\}/g, "<sup>$1</sup>").replace(/\^([A-Za-z0-9])/g, "<sup>$1</sup>");
  s = s.replace(/_\{([^{}]+)\}/g, "<sub>$1</sub>").replace(/_([A-Za-z0-9])/g, "<sub>$1</sub>");
  for (const key of TEX_KEYS) s = s.split(key).join(TEX_MAP[key]);
  s = s.replace(/\\begin\{[^}]*\}|\\end\{[^}]*\}/g, "").replace(/\\\\/g, "<br>").replace(/&/g, " ");
  s = s.replace(/\\[a-zA-Z]+\s?/g, "").replace(/[{}]/g, "").replace(/\\/g, "");
  return `<span class="tex${display ? " tex-block" : ""}">${s}</span>`;
}

// ---------- 코드 문법 하이라이트 ----------
// 외부 라이브러리 없이 자주 쓰는 언어의 핵심 토큰만 표시한다. 모든 조각을 esc()한 뒤
// span으로 감싸므로, AI 응답 안의 HTML/스크립트가 실행될 수 없다.
const LANG_ALIAS = { js: "javascript", jsx: "javascript", ts: "javascript", tsx: "javascript", mjs: "javascript", cjs: "javascript", py: "python", rs: "rust", sh: "shell", bash: "shell", zsh: "shell", ps1: "powershell", yml: "yaml", md: "markdown", c: "cpp", h: "cpp", hpp: "cpp", cc: "cpp" };
const KEYWORDS = {
  javascript: "const let var function return if else for while do switch case break continue new class extends import export from async await throw try catch finally typeof instanceof in of interface type public private protected static get set",
  python: "def class return if elif else for while in is not and or import from as try except finally raise with lambda yield async await pass break continue True False None",
  rust: "fn let mut const struct enum impl trait pub use mod crate self Self super match if else loop while for in return async await move ref where type dyn unsafe",
  cpp: "auto bool break case char class const continue default delete do double else enum explicit extern false float for friend if inline int long namespace new nullptr operator private protected public return short signed sizeof static struct switch template this throw true try typedef typename union unsigned using virtual void volatile while",
  java: "class public private protected static final void int long double float boolean new return if else for while switch case break continue try catch finally throw import package extends implements interface true false null",
  sql: "select from where join left right inner outer on as insert into update delete create alter drop table values set group by order having limit distinct union all null and or not",
  shell: "if then else fi for in do done case esac function local export readonly return echo printf cd test true false",
  powershell: "function param return if else elseif foreach for while switch try catch finally throw begin process end import-module set-variable get-variable",
  json: "true false null",
  yaml: "true false null yes no on off",
  css: "color background display position margin padding border font grid flex transform transition animation important inherit initial unset",
};
const DECLARERS = new Set(["const", "let", "var", "function", "class", "def", "fn", "struct", "enum", "interface", "type"]);
const normalizeLang = (lang) => LANG_ALIAS[String(lang || "").toLowerCase()] || String(lang || "").toLowerCase();
const spanToken = (type, text) => `<span class="tok-${type}">${esc(text)}</span>`;

export function highlightCode(source, language = "") {
  const src = String(source ?? "");
  const lang = normalizeLang(language);
  const keywords = new Set((KEYWORDS[lang] || "").split(" ").filter(Boolean));
  const lineComment = lang === "python" || lang === "shell" || lang === "powershell" || lang === "yaml" ? "#" : "//";
  let out = "", i = 0, expectsName = false;
  const nextNonSpace = (start) => { let n = start; while (/\s/.test(src[n] || "")) n++; return src[n] || ""; };

  while (i < src.length) {
    const rest = src.slice(i);
    if ((lang === "html" || lang === "xml") && rest.startsWith("<!--")) {
      const end = src.indexOf("-->", i + 4); const part = src.slice(i, end < 0 ? src.length : end + 3);
      out += spanToken("comment", part); i += part.length; continue;
    }
    if (rest.startsWith("/*")) {
      const end = src.indexOf("*/", i + 2); const part = src.slice(i, end < 0 ? src.length : end + 2);
      out += spanToken("comment", part); i += part.length; continue;
    }
    if (lineComment && rest.startsWith(lineComment)) {
      const end = src.indexOf("\n", i); const part = src.slice(i, end < 0 ? src.length : end);
      out += spanToken("comment", part); i += part.length; continue;
    }
    const ch = src[i];
    if (ch === '"' || ch === "'" || ch === "`") {
      let j = i + 1;
      while (j < src.length) { if (src[j] === "\\") { j += 2; continue; } if (src[j] === ch) { j++; break; } j++; }
      out += spanToken("string", src.slice(i, j)); i = j; expectsName = false; continue;
    }
    const num = rest.match(/^(?:0x[\da-f]+|\d+(?:\.\d+)?(?:e[+-]?\d+)?)/i);
    if (num) { out += spanToken("number", num[0]); i += num[0].length; continue; }
    const id = rest.match(/^[A-Za-z_$][\w$-]*/);
    if (id) {
      const word = id[0], lower = word.toLowerCase();
      if (keywords.has(word) || keywords.has(lower)) { out += spanToken("keyword", word); expectsName = DECLARERS.has(lower); }
      else if (expectsName) { out += spanToken("variable", word); expectsName = false; }
      else if (lang === "json" && nextNonSpace(i + word.length) === ":") out += spanToken("property", word);
      else if (nextNonSpace(i + word.length) === "(") out += spanToken("function", word);
      else out += esc(word);
      i += word.length; continue;
    }
    if (!/\s/.test(ch) && /[{}[\]();,:.=+\-*/<>!?&|]/.test(ch)) out += spanToken("operator", ch);
    else out += esc(ch);
    if (!/\s/.test(ch) && !"*:".includes(ch)) expectsName = false;
    i++;
  }
  return out;
}

// 이스케이프된 텍스트에 인라인 서식 적용.
function inlineMd(s) {
  return s
    .replace(/`([^`]+)`/g, (_, c) => `<code>${c}</code>`)
    .replace(/\*\*\*([^*]+)\*\*\*/g, "<strong><em>$1</em></strong>")
    .replace(/\*\*([^*]+)\*\*/g, "<strong>$1</strong>")
    .replace(/__([^_]+)__/g, "<strong>$1</strong>")
    .replace(/(^|[^*\w])\*([^*\s](?:[^*]*[^*\s])?)\*(?!\w)/g, "$1<em>$2</em>")
    .replace(/(^|[^_\w])_([^_\s](?:[^_]*[^_\s])?)_(?!\w)/g, "$1<em>$2</em>")
    .replace(/~~([^~]+)~~/g, "<del>$1</del>")
    .replace(/\[([^\]]+)\]\((https?:\/\/[^\s)]+)\)/g, '<a href="$2" target="_blank" rel="noopener noreferrer">$1</a>')
    .replace(/(^|[\s(])(https?:\/\/[^\s<)]+)/g, '$1<a href="$2" target="_blank" rel="noopener noreferrer">$2</a>');
}

const ROW = /^(\s*)([-*+]|\d+[.)])\s+(.*)$/;
const isBlockStart = (l) =>
  !l.trim() ||
  /^\s{0,3}(>|#{1,6}\s|([-*+]|\d+[.)])\s)/.test(l) ||
  /^\s{0,3}([-*_])(\s*\1){2,}\s*$/.test(l) ||
  /^\x01CB\d+\x01$/.test(l.trim()) ||
  (l.includes("|") && /^\s*\|?[\s:|-]*-[\s:|-]*\|?\s*$/.test(l));

// 들여쓰기 기반 리스트 파서 (중첩·이어지는 줄·task list 지원)
function parseList(lines, start, fmt) {
  const first = lines[start].match(ROW);
  const base = first[1].length;
  const ordered = /\d/.test(first[2]);
  const items = [];
  let i = start;
  while (i < lines.length) {
    const m = lines[i].match(ROW);
    if (!m) {
      if (lines[i].trim() && items.length && /^\s+\S/.test(lines[i])) {
        items[items.length - 1].cont.push(lines[i].trim());
        i++; continue;
      }
      break;
    }
    const indent = m[1].length;
    if (indent < base) break;
    if (indent >= base + 2 && items.length) {
      const [sub, next] = parseList(lines, i, fmt);
      items[items.length - 1].sub += sub;
      i = next; continue;
    }
    items.push({ text: m[3], cont: [], sub: "" });
    i++;
  }
  const tag = ordered ? "ol" : "ul";
  const lis = items.map((it) => {
    let inner = it.text;
    const t = inner.match(/^\[([ xX])\]\s+(.*)$/);
    let box = "";
    if (t) { box = `<input type="checkbox" disabled${/x/i.test(t[1]) ? " checked" : ""}> `; inner = t[2]; }
    let body = box + fmt(inner);
    if (it.cont.length) body += " " + fmt(it.cont.join(" "));
    return `<li>${body}${it.sub}</li>`;
  }).join("");
  return [`<${tag}>${lis}</${tag}>`, i];
}

// LLM 채팅 출력에 흔한 마크다운을 안전한 HTML 로. 텍스트는 emit 시점에 이스케이프한다.
export function renderMarkdown(src) {
  if (!src) return "";
  const code = [];
  let text = src.replace(/\r\n?/g, "\n").replace(/```([\w+-]*)[ \t]*\n?([\s\S]*?)```/g, (_, rawLang, body) => {
    // 언어는 제한된 문자 집합만 통과시키고, 이후 UI가 data 속성으로 표시한다.
    const lang = String(rawLang || "").toLowerCase();
    const attr = lang ? ` data-code-lang="${lang}"` : "";
    const cls = lang ? ` class="language-${lang}"` : "";
    code.push(`<pre${attr}><code${cls}>${highlightCode(body.replace(/\n$/, ""), lang)}</code></pre>`);
    return `\x01CB${code.length - 1}\x01`;
  });
  // 수식은 마크다운 파서가 건드리기 전에 뽑아내 렌더 후 자리표시자로 치환한다.
  const math = [];
  const stashMath = (tex, display) => (math.push(renderTeX(tex, display)), `\x01MJ${math.length - 1}\x01`);
  text = text
    .replace(/\$\$([\s\S]+?)\$\$/g, (_, m) => stashMath(m, true))
    .replace(/\\\[([\s\S]+?)\\\]/g, (_, m) => stashMath(m, true))
    .replace(/\\\(([\s\S]+?)\\\)/g, (_, m) => stashMath(m, false));
  const lines = text.split("\n");
  const fmt = (s) => inlineMd(esc(s));
  const out = [];
  let i = 0;

  while (i < lines.length) {
    const line = lines[i];

    if (!line.trim()) { i++; continue; }

    const cb = line.trim().match(/^\x01CB(\d+)\x01$/);
    if (cb) { out.push(code[+cb[1]] || ""); i++; continue; }

    if (/^\s{0,3}([-*_])(\s*\1){2,}\s*$/.test(line)) { out.push("<hr>"); i++; continue; }

    const h = line.match(/^\s{0,3}(#{1,6})\s+(.*?)\s*#*\s*$/);
    if (h) { const lvl = h[1].length <= 2 ? 3 : 4; out.push(`<h${lvl}>${fmt(h[2])}</h${lvl}>`); i++; continue; }

    // GFM 표: 헤더 줄 + 구분 줄
    if (line.includes("|") && i + 1 < lines.length &&
        /^\s*\|?[\s:|-]*-[\s:|-]*\|?\s*$/.test(lines[i + 1])) {
      const cells = (r) => r.trim().replace(/^\||\|$/g, "").split("|").map((c) => c.trim());
      const head = cells(line);
      const al = cells(lines[i + 1]).map((s) =>
        /^:.*:$/.test(s) ? "center" : /:$/.test(s) ? "right" : /^:/.test(s) ? "left" : "");
      i += 2;
      const body = [];
      while (i < lines.length && lines[i].includes("|") && lines[i].trim()) { body.push(cells(lines[i])); i++; }
      const sty = (k) => (al[k] ? ` style="text-align:${al[k]}"` : "");
      const thead = head.map((c, k) => `<th${sty(k)}>${fmt(c)}</th>`).join("");
      const tbody = body.map((r) => `<tr>${head.map((_, k) => `<td${sty(k)}>${fmt(r[k] || "")}</td>`).join("")}</tr>`).join("");
      out.push(`<table><thead><tr>${thead}</tr></thead><tbody>${tbody}</tbody></table>`);
      continue;
    }

    if (/^\s{0,3}>/.test(line)) {
      const buf = [];
      while (i < lines.length && /^\s{0,3}>/.test(lines[i])) { buf.push(lines[i].replace(/^\s{0,3}>\s?/, "")); i++; }
      out.push(`<blockquote>${renderMarkdown(buf.join("\n"))}</blockquote>`);
      continue;
    }

    if (ROW.test(line)) {
      const [html, next] = parseList(lines, i, fmt);
      out.push(html); i = next; continue;
    }

    const buf = [];
    while (i < lines.length && !isBlockStart(lines[i])) { buf.push(lines[i]); i++; }
    out.push(`<p>${fmt(buf.join("\n")).replace(/\n/g, "<br>")}</p>`);
  }
  return out.join("").replace(/\x01MJ(\d+)\x01/g, (_, n) => math[+n] || "");
}

// ---------- 첨부 제한 ----------
export const ATT_LIMITS = {
  perImageBytes: 15 * 1024 * 1024,   // 이미지 1개
  perTextBytes: 1024 * 1024,         // 텍스트 파일 1개 (원본)
  totalBytes: 25 * 1024 * 1024,      // 전체 첨부 payload
  totalTextChars: 60000,             // 프롬프트에 삽입되는 텍스트 총 글자수
};

// pending 배열({kind, b64?, text?})의 총량을 재고 위반 목록을 돌려준다.
export function checkAttachments(list, limits = ATT_LIMITS) {
  let bytes = 0, chars = 0;
  for (const a of list || []) {
    if (a.kind === "image") bytes += Math.ceil((a.b64 ? a.b64.length : 0) * 0.75);
    else { const n = (a.text || "").length; chars += n; bytes += n; }
  }
  const errors = [];
  if (bytes > limits.totalBytes) errors.push(`총 첨부 용량 ${humanBytes(bytes)} — 한도 ${humanBytes(limits.totalBytes)} 초과`);
  if (chars > limits.totalTextChars) errors.push(`첨부 텍스트 ${chars.toLocaleString()}자 — 한도 ${limits.totalTextChars.toLocaleString()}자 초과`);
  return { bytes, chars, errors, ok: errors.length === 0 };
}

// ---------- diff (LOCODE 파일 변경 미리보기) ----------
const DIFF_CELL_CAP = 4_000_000; // n*m 이 이보다 크면 통짜 교체로 폴백

// 두 텍스트의 라인 단위 diff. 반환: [{type:"ctx"|"add"|"del", text}]
export function lineDiff(before, after) {
  // null/undefined = 파일 없음(0줄). "" = 빈 파일(1줄).
  const a = before == null ? [] : String(before).split("\n");
  const b = after == null ? [] : String(after).split("\n");
  const n = a.length, m = b.length;
  if (n * m > DIFF_CELL_CAP) {
    return [
      ...a.map((t) => ({ type: "del", text: t })),
      ...b.map((t) => ({ type: "add", text: t })),
    ];
  }
  // LCS 길이 테이블 (뒤에서 앞으로)
  const dp = Array.from({ length: n + 1 }, () => new Uint32Array(m + 1));
  for (let i = n - 1; i >= 0; i--) {
    for (let j = m - 1; j >= 0; j--) {
      dp[i][j] = a[i] === b[j] ? dp[i + 1][j + 1] + 1 : Math.max(dp[i + 1][j], dp[i][j + 1]);
    }
  }
  const out = [];
  let i = 0, j = 0;
  while (i < n && j < m) {
    if (a[i] === b[j]) { out.push({ type: "ctx", text: a[i] }); i++; j++; }
    else if (dp[i + 1][j] >= dp[i][j + 1]) { out.push({ type: "del", text: a[i] }); i++; }
    else { out.push({ type: "add", text: b[j] }); j++; }
  }
  while (i < n) out.push({ type: "del", text: a[i++] });
  while (j < m) out.push({ type: "add", text: b[j++] });
  return out;
}

// 바뀌지 않은(ctx) 라인이 pad*2 개를 넘게 연속되면 가운데를 접는다.
// 반환 배열에는 { type:"gap", count } 마커가 들어갈 수 있다.
export function collapseDiff(diff, pad = 3) {
  const list = diff || [];
  const out = [];
  let run = [];
  const flush = () => {
    if (run.length > pad * 2 + 1) {
      out.push(...run.slice(0, pad));
      out.push({ type: "gap", count: run.length - pad * 2 });
      out.push(...run.slice(-pad));
    } else {
      out.push(...run);
    }
    run = [];
  };
  for (const d of list) {
    if (d.type === "ctx") run.push(d);
    else { flush(); out.push(d); }
  }
  flush();
  return out;
}

// diff 의 추가/삭제 라인 수
export function diffStat(diff) {
  let add = 0, del = 0;
  for (const d of diff || []) {
    if (d.type === "add") add++;
    else if (d.type === "del") del++;
  }
  return { add, del };
}

// 요약(컨텍스트 압축)을 돌릴지 여부. messages 는 summarizedUpTo 이후의 라이브 메시지들.
export function shouldCompress(messages, opts) {
  const { enabled, threshold } = opts || {};
  if (!enabled) return false;
  const count = messages.filter((m) => m.role === "user" || m.role === "assistant").length;
  return count > threshold;
}
