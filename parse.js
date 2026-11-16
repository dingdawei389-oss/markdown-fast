// parse.js — a fast CommonMark 0.31.2 + GFM renderer whose parse(markdown)
// returns byte-identical HTML to marked 18.1.3 with its default options
// (gfm on, breaks off). Dependency-free, deterministic, no network.
// Built from the CommonMark and GFM specs, checked against marked's output.

// ---------------------------------------------------------------------------
// Character classification
// ---------------------------------------------------------------------------

// ASCII punctuation set (Unicode general category P, ASCII range).
const ASCII_PUNCT = new Uint8Array(128);
for (const ch of '!"#$%&\'()*+,-./:;<=>?@[\\]^_`{|}~') ASCII_PUNCT[ch.charCodeAt(0)] = 1;

// Cached results for non-ASCII punctuation checks (rare in practice).
const punctCache = new Map();
const PUNCT_RE = /[\p{P}\p{S}]/u;
function isPunctCode(code) {
  if (code < 128) return ASCII_PUNCT[code] === 1;
  let hit = punctCache.get(code);
  if (hit === undefined) {
    hit = PUNCT_RE.test(String.fromCodePoint(code)) ? 1 : 0;
    punctCache.set(code, hit);
  }
  return hit === 1;
}

// Backslash escapes only apply to ASCII punctuation per the spec;
// a character like « cannot be escaped.
function isAsciiPunct(code) {
  return code < 128 && ASCII_PUNCT[code] === 1;
}

// Unicode whitespace (the set JS \s matches).
function isSpaceCode(code) {
  return code === 32 || (code >= 9 && code <= 13) || code === 0x85 || code === 0xa0 ||
    code === 0x1680 || (code >= 0x2000 && code <= 0x200a) || code === 0x2028 ||
    code === 0x2029 || code === 0x202f || code === 0x205f || code === 0x3000 ||
    code === 0xfeff;
}

// ---------------------------------------------------------------------------
// Entities. marked passes named entities through verbatim (no validation
// against the HTML5 list), decodes numeric entities to their character
// (0, surrogates, and values above U+10FFFF become U+FFFD), and escapes a
// bare & that begins no entity. Numeric entities take at most 7 decimal
// or 6 hex digits; longer runs are not entities.
// ---------------------------------------------------------------------------

// Length of the entity starting at s[i] (s[i] === '&'), or 0 if none.
function entityLen(s, i) {
  const n = s.length;
  let j = i + 1;
  if (j >= n) return 0;
  const c = s.charCodeAt(j);
  if (c === 35) { // '#'
    j++;
    if (j >= n) return 0;
    const h = s.charCodeAt(j);
    if (h === 120 || h === 88) { // 'x' or 'X'
      j++;
      const start = j;
      while (j < n && j - start < 6) {
        const d = s.charCodeAt(j);
        if ((d >= 48 && d <= 57) || (d >= 97 && d <= 102) || (d >= 65 && d <= 70)) j++;
        else break;
      }
      if (j === start) return 0;
      // A 7th hex digit disqualifies the entity entirely.
      if (j < n && s.charCodeAt(j) === 59 && j - start <= 6) return j + 1 - i;
      return 0;
    }
    const start = j;
    while (j < n && j - start < 7) {
      const d = s.charCodeAt(j);
      if (d >= 48 && d <= 57) j++;
      else break;
    }
    if (j === start) return 0;
    if (j < n && s.charCodeAt(j) === 59 && j - start <= 7) return j + 1 - i;
    return 0;
  }
  // Named entity: &[A-Za-z0-9_]+;
  const start = j;
  while (j < n) {
    const d = s.charCodeAt(j);
    if ((d >= 48 && d <= 57) || (d >= 65 && d <= 90) || (d >= 97 && d <= 122) || d === 95) j++;
    else break;
  }
  if (j === start) return 0;
  if (j < n && s.charCodeAt(j) === 59) return j + 1 - i;
  return 0;
}

// Decode a numeric entity's digits to its output character (U+FFFD for 0,
// surrogates, and out-of-range values). `body` excludes the '&#'/'x' prefix.
function numericChar(body, hex) {
  let v = 0;
  if (hex) {
    for (let k = 0; k < body.length; k++) {
      const d = body.charCodeAt(k);
      v = v * 16 + (d <= 57 ? d - 48 : (d <= 70 ? d - 55 : d - 87));
    }
  } else {
    for (let k = 0; k < body.length; k++) v = v * 10 + (body.charCodeAt(k) - 48);
  }
  if (v === 0 || (v >= 0xd800 && v <= 0xdfff) || v > 0x10ffff) return '\uFFFD';
  return String.fromCodePoint(v);
}

// ---------------------------------------------------------------------------
// Escaping
// ---------------------------------------------------------------------------

const ESCAPE_MAP = { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' };

// Plain escaping for code spans and code blocks: every & < > " ' is escaped,
// with no entity recognition.
function escapePlain(s) {
  if (!/[&<>"']/.test(s)) return s;
  return s.replace(/[&<>"']/g, (c) => ESCAPE_MAP[c]);
}

// Attribute escaping (link titles, fenced-code info strings): < > " ' are
// escaped; & is escaped unless it starts an entity pattern, which passes
// through raw (numeric entities are NOT decoded here).
function escapeAttr(s) {
  let out = '';
  let start = 0;
  for (let i = 0; i < s.length; i++) {
    const c = s.charCodeAt(i);
    if (c === 38) { // '&'
      const len = entityLen(s, i);
      if (len > 0) { i += len - 1; continue; }
      out += s.slice(start, i) + '&amp;';
      start = i + 1;
    } else if (c === 60) { out += s.slice(start, i) + '&lt;'; start = i + 1; }
    else if (c === 62) { out += s.slice(start, i) + '&gt;'; start = i + 1; }
    else if (c === 34) { out += s.slice(start, i) + '&quot;'; start = i + 1; }
    else if (c === 39) { out += s.slice(start, i) + '&#39;'; start = i + 1; }
  }
  return start === 0 ? s : out + s.slice(start);
}

// Link destination encoding: the caller has already processed backslash
// escapes. encodeURI percent-encodes everything marked does; then ' and a
// bare & are HTML-escaped (entities pass through raw).
function encodeHref(s) {
  let enc;
  try {
    enc = encodeURI(s);
  } catch {
    enc = encodeUriFallback(s);
  }
  // marked leaves % alone; encodeURI turns it into %25.
  return escapeAttr(enc.replace(/%25/g, '%'));
}

// encodeURI throws on lone surrogates; encode those as U+FFFD instead.
function encodeUriFallback(s) {
  let out = '';
  for (let i = 0; i < s.length; i++) {
    const code = s.charCodeAt(i);
    if (code >= 0xd800 && code <= 0xdbff) {
      const next = s.charCodeAt(i + 1);
      if (next >= 0xdc00 && next <= 0xdfff) {
        out += encodeURI(s[i] + s[i + 1]);
        i++;
      } else {
        out += '%EF%BF%BD';
      }
    } else if (code >= 0xdc00 && code <= 0xdfff) {
      out += '%EF%BF%BD';
    } else {
      out += encodeURI(s[i]);
    }
  }
  return out;
}

// ---------- inline helpers ----------

// Escape a plain-text run. Runs never contain '&' or '<' (those break runs),
// so only '>', '"' and "'" need escaping here.
function escapeTextRun(s) {
  if (!/[>"']/.test(s)) return s;
  let r = '';
  let last = 0;
  for (let i = 0; i < s.length; i++) {
    const c = s.charCodeAt(i);
    if (c === 62) { r += s.slice(last, i) + '&gt;'; last = i + 1; }
    else if (c === 34) { r += s.slice(last, i) + '&quot;'; last = i + 1; }
    else if (c === 39) { r += s.slice(last, i) + '&#39;'; last = i + 1; }
  }
  return last === 0 ? s : r + s.slice(last);
}

function isAlnum(c) {
  return (c >= 48 && c <= 57) || (c >= 65 && c <= 90) || (c >= 97 && c <= 122);
}

// Normalize a link label for reference lookup: collapse whitespace runs
// (space, tab, newline) to a single space, trim, lowercase, and fold
// the sharp s (Unicode case folding maps ß and ẞ to ss).
function normalizeLabel(s) {
  return s.replace(/[ \t\n]+/g, ' ').trim().toLowerCase().replace(/ß/g, 'ss');
}

// Parse an inline link destination plus optional title, starting at s[pos]
// (the char just after '('). Backslash escapes are processed. Returns
// {dest, title, end} (title is null when absent) or null when no valid
// inline link follows.
function parseDestTitle(s, pos) {
  const n = s.length;
  let p = pos;
  while (p < n) { const c = s.charCodeAt(p); if (c === 32 || c === 9 || c === 10) p++; else break; }
  if (p >= n) return null;
  let dest = '';
  if (s.charCodeAt(p) === 60) { // '<' angle-bracket destination
    p++;
    let closed = false;
    while (p < n) {
      const c = s.charCodeAt(p);
      if (c === 62) { closed = true; p++; break; }
      if (c === 10 || c === 60) return null;
      if (c === 92 && p + 1 < n && isAsciiPunct(s.charCodeAt(p + 1))) { dest += s[p + 1]; p += 2; }
      else { dest += s[p]; p++; }
    }
    if (!closed) return null;
  } else { // bare destination: balanced parens, no whitespace
    let depth = 0;
    while (p < n) {
      const c = s.charCodeAt(p);
      if (c === 32 || c === 9 || c === 10) break;
      if (c === 92 && p + 1 < n && isAsciiPunct(s.charCodeAt(p + 1))) { dest += s[p + 1]; p += 2; continue; }
      if (c === 40) { depth++; dest += '('; p++; continue; }
      if (c === 41) {
        if (depth === 0) break;
        depth--; dest += ')'; p++; continue;
      }
      dest += s[p]; p++;
    }
    if (depth !== 0) return null;
  }
  while (p < n) { const c = s.charCodeAt(p); if (c === 32 || c === 9 || c === 10) p++; else break; }
  if (p >= n) return null;
  let title = null;
  const tc = s.charCodeAt(p);
  if (tc === 34 || tc === 39 || tc === 40) { // '"', "'", '('
    const closer = tc === 40 ? 41 : tc;
    p++;
    let closed = false;
    let t = '';
    while (p < n) {
      const c = s.charCodeAt(p);
      if (c === closer) { closed = true; p++; break; }
      if (tc === 40 && c === 40) return null;
      if (c === 92 && p + 1 < n && isAsciiPunct(s.charCodeAt(p + 1))) { t += s[p + 1]; p += 2; }
      else { t += s[p]; p++; }
    }
    if (!closed) return null;
    title = t;
    while (p < n) { const c = s.charCodeAt(p); if (c === 32 || c === 9 || c === 10) p++; else break; }
    if (p >= n) return null;
  }
  if (s.charCodeAt(p) !== 41) return null;
  return { dest, title, end: p + 1 };
}

// Href encoding for autolinks: encodeURI, then escape EVERY '&' (autolinks
// do not pass entities through) and "'". Lone surrogates fall back to a
// manual percent-encoding pass.
function encodeAutoHref(s) {
  let e;
  try { e = encodeURI(s); }
  catch (err) {
    e = '';
    for (let i = 0; i < s.length; i++) {
      const c = s.charCodeAt(i);
      if (c >= 0xD800 && c <= 0xDFFF) e += '%EF%BF%BD';
      else e += encodeURI(s[i]);
    }
  }
  e = e.replace(/%25/g, '%');
  if (e.indexOf('&') < 0 && e.indexOf("'") < 0) return e;
  let r = '';
  let last = 0;
  for (let i = 0; i < e.length; i++) {
    const c = e.charCodeAt(i);
    if (c === 38) { r += e.slice(last, i) + '&amp;'; last = i + 1; }
    else if (c === 39) { r += e.slice(last, i) + '&#39;'; last = i + 1; }
  }
  return r + e.slice(last);
}

// Trim a URL autolink candidate src[start..end) per marked's backpedal:
// repeatedly keep the longest prefix that ends in non-punctuation (or a
// balanced paren group), stripping trailing punctuation (including `;`,
// quotes, unbalanced parens) and trailing entities. Returns the new end.
const AUTOLINK_BACKPEDAL = /^(?:[^?!.,:;*_'\"~()&]+|\([^)]*\)|&(?![a-zA-Z0-9]+;$)|[?!.,:;*_'\"~)]+(?!$))+/;
function trimUrl(src, start, end) {
  let url = src.slice(start, end);
  let prev;
  do {
    prev = url;
    const m = AUTOLINK_BACKPEDAL.exec(url);
    url = m ? m[0] : '';
  } while (url !== prev);
  return start + url.length;
}

// Parse a www/scheme autolink. `start` is the 'www.' or scheme start,
// `domainStart` is just after 'www.' or '://'. Returns {href, text, end}
// or null.
function parseUrlLink(src, start, domainStart, isWww) {
  const n = src.length;
  let p = domainStart;
  // First domain label: must start with alnum or '-', then alnum/'-'/'_'.
  if (p >= n) return null;
  let c = src.charCodeAt(p);
  if (!isAlnum(c) && c !== 45) return null;
  while (p < n) {
    c = src.charCodeAt(p);
    if (isAlnum(c) || c === 45 || c === 95) p++;
    else break;
  }
  // Further labels after '.'.
  while (p < n && src.charCodeAt(p) === 46) {
    if (p + 1 < n) {
      const nc = src.charCodeAt(p + 1);
      if (isAlnum(nc) || nc === 45) {
        p++;
        while (p < n) {
          c = src.charCodeAt(p);
          if (isAlnum(c) || c === 45 || c === 95) p++;
          else break;
        }
        continue;
      }
    }
    break;
  }
  // Path: everything up to whitespace, '<', or end of input.
  let urlEnd = p;
  while (urlEnd < n) {
    c = src.charCodeAt(urlEnd);
    if (c === 32 || c === 9 || c === 10 || c === 60) break;
    urlEnd++;
  }
  urlEnd = trimUrl(src, start, urlEnd);
  if (urlEnd <= domainStart) return null;
  const raw = src.slice(start, urlEnd);
  const href = encodeAutoHref(isWww ? 'http://' + raw : raw);
  return { href, text: escapePlain(raw), end: urlEnd, start };
}

// Parse an email autolink with '@' at position `at`. Handles the optional
// lowercase mailto:/xmpp: scheme prefix (xmpp allows one '/segment' path).
// Returns {href, text, end} or null.
function parseEmailLink(src, at, bound, inEmphasis, startBound) {
  const n = bound !== undefined ? bound : src.length;
  const lo = startBound !== undefined ? startBound : 0;
  let userStart = at;
  while (userStart > lo) {
    const c = src.charCodeAt(userStart - 1);
    if (isAlnum(c) || c === 46 || c === 95 || c === 43 || c === 45) userStart--;
    else break;
  }
  if (userStart === at) return null;
  let p = at + 1;
  let labels = 0;
  let domainEnd = p;
  while (true) {
    // Domain label: alnum, '-', '_' but must end with an alnum
    // (marked: [a-zA-Z0-9-_]*[a-zA-Z0-9]).
    let lastAlnum = -1;
    while (p < n) {
      const c = src.charCodeAt(p);
      if (isAlnum(c)) { lastAlnum = p; p++; }
      else if (c === 45 || c === 95) p++;
      else break;
    }
    if (lastAlnum < 0) break;
    p = lastAlnum + 1;
    labels++;
    domainEnd = p;
    if (p < n && src.charCodeAt(p) === 46 && p + 1 < n) {
      const nc = src.charCodeAt(p + 1);
      if (isAlnum(nc) || nc === 45 || nc === 95) { p++; continue; }
    }
    break;
  }
  if (labels < 2) return null;
  // (?![\w-]): the char after the email must not be a word char or '-'.
  // The `bound` boundary counts as end-of-content only when the email
  // is inside an emphasis span closed by the delimiter at `bound`
  // (inEmphasis); otherwise the char at `bound` is literal text and the
  // lookahead applies (matching marked's recursive tokenization).
  if (domainEnd < n) {
    const nc = src.charCodeAt(domainEnd);
    if (isAlnum(nc) || nc === 95 || nc === 45) return null;
  } else if (domainEnd === bound && !inEmphasis && bound < src.length) {
    const nc = src.charCodeAt(bound);
    if (isAlnum(nc) || nc === 95 || nc === 45) return null;
  }
  let start = userStart;
  let isXmpp = false;
  // Optional scheme prefix: must be lowercase mailto:/xmpp: and not glued
  // to a preceding letter or digit. Must also stay within the flush start.
  if (userStart - lo >= 7 && src.slice(userStart - 7, userStart) === 'mailto:') {
    if (userStart === 7 || !isAlnum(src.charCodeAt(userStart - 8))) start = userStart - 7;
  } else if (userStart - lo >= 5 && src.slice(userStart - 5, userStart) === 'xmpp:') {
    if (userStart === 5 || !isAlnum(src.charCodeAt(userStart - 6))) { start = userStart - 5; isXmpp = true; }
  }
  let end = domainEnd;
  if (isXmpp && end < n && src.charCodeAt(end) === 47) {
    let q = end + 1;
    while (q < n) {
      const c = src.charCodeAt(q);
      if (c === 32 || c === 9 || c === 10 || c === 60 || c === 47) break;
      q++;
    }
    if (q > end + 1) end = q;
  }
  const raw = src.slice(start, end);
  const href = start === userStart ? 'mailto:' + raw : raw;
  return { href: encodeAutoHref(href), text: escapePlain(raw), end, start };
}

// Find the next extended-autolink candidate at or after `pos` (searching
// only up to `end` for the marker). Returns the candidate index, or -1.
function findAutolinkStart(src, pos, end) {
  let best = -1;
  const w = src.indexOf('www.', pos);
  if (w >= 0 && w < end) best = w;
  const s = src.indexOf('://', pos);
  if (s >= 0 && s < end && (best < 0 || s < best)) best = s;
  const a = src.indexOf('@', pos);
  if (a >= 0 && a < end && (best < 0 || a < best)) best = a;
  return best;
}

// Try to form an extended autolink at candidate position `cand`.
// `end` is the flush boundary; `inEmphasis` is true when the text up to
// `end` is inside an emphasis span closed by the delimiter at `end`.
function tryAutolink(src, cand, end, inEmphasis, startBound) {
  const n = src.length;
  const c = src.charCodeAt(cand);
  if (c === 119) { // 'w' -> www.
    if (src.slice(cand, cand + 4) !== 'www.') return null;
    if (cand > 0) {
      const b = src.charCodeAt(cand - 1);
      if (!(b === 32 || b === 9 || b === 10 || b === 42 || b === 95 || b === 126 || b === 40 || b === 91)) return null;
    }
    return parseUrlLink(src, cand, cand + 4, true);
  }
  if (c === 58) { // ':' -> scheme://
    let schemeStart = cand;
    while (schemeStart > 0) {
      const sc = src.charCodeAt(schemeStart - 1);
      if (isAlnum(sc) || sc === 43 || sc === 45 || sc === 46) schemeStart--;
      else break;
    }
    const scheme = src.slice(schemeStart, cand).toLowerCase();
    if (scheme !== 'http' && scheme !== 'https' && scheme !== 'ftp') return null;
    if (cand + 3 > n) return null;
    return parseUrlLink(src, schemeStart, cand + 3, false);
  }
  if (c === 64) { // '@' -> email
    return parseEmailLink(src, cand, end, inEmphasis, startBound);
  }
  return null;
}

// ---------- HTML tags and bracket autolinks ----------

function isWS(c) { return c === 32 || c === 9 || c === 10; }

// Parse an HTML tag (open/close), comment, processing instruction,
// declaration, or CDATA section starting at src[i] === '<'.
// Returns the index just past the tag, or -1 when it is not a tag.
function parseHtmlTag(src, i) {
  const n = src.length;
  if (i + 1 >= n) return -1;
  const c1 = src.charCodeAt(i + 1);
  if (c1 === 33) { // '!' comment / declaration / CDATA
    if (src.startsWith('<!--', i)) {
      if (src.startsWith('<!-->', i)) return i + 5;
      if (src.startsWith('<!--->', i)) return i + 6;
      const e = src.indexOf('-->', i + 4);
      return e >= 0 ? e + 3 : -1;
    }
    if (src.startsWith('<![CDATA[', i)) {
      const e = src.indexOf(']]>', i + 9);
      return e >= 0 ? e + 3 : -1;
    }
    if (i + 2 < n) {
      const c2 = src.charCodeAt(i + 2);
      if ((c2 >= 65 && c2 <= 90) || (c2 >= 97 && c2 <= 122)) {
        const e = src.indexOf('>', i + 3);
        return e >= 0 ? e + 1 : -1;
      }
    }
    return -1;
  }
  if (c1 === 63) { // '?' processing instruction
    const e = src.indexOf('?>', i + 2);
    return e >= 0 ? e + 2 : -1;
  }
  if (c1 === 47) { // '/' closing tag
    let p = i + 2;
    if (p >= n) return -1;
    const c2 = src.charCodeAt(p);
    if (!((c2 >= 65 && c2 <= 90) || (c2 >= 97 && c2 <= 122))) return -1;
    p++;
    while (p < n) {
      const c = src.charCodeAt(p);
      if (isAlnum(c) || c === 45) p++;
      else break;
    }
    while (p < n && isWS(src.charCodeAt(p))) p++;
    if (p < n && src.charCodeAt(p) === 62) return p + 1;
    return -1;
  }
  if (!((c1 >= 65 && c1 <= 90) || (c1 >= 97 && c1 <= 122))) return -1;
  let p = i + 1;
  while (p < n) {
    const c = src.charCodeAt(p);
    if (isAlnum(c) || c === 45) p++;
    else break;
  }
  let sawWS = false;
  while (true) {
    let ws = 0;
    while (p < n && isWS(src.charCodeAt(p))) { p++; ws++; }
    if (ws > 0) sawWS = true;
    if (p >= n) return -1;
    const c = src.charCodeAt(p);
    if (c === 62) return p + 1;
    if (c === 47) {
      if (p + 1 < n && src.charCodeAt(p + 1) === 62) return p + 2;
      return -1;
    }
    if (!sawWS) return -1;
    sawWS = false;
    if (!((c >= 65 && c <= 90) || (c >= 97 && c <= 122) || c === 95 || c === 58)) return -1;
    p++;
    while (p < n) {
      const ac = src.charCodeAt(p);
      if (isAlnum(ac) || ac === 95 || ac === 58 || ac === 45 || ac === 46) p++;
      else break;
    }
    let q = p;
    while (q < n && isWS(src.charCodeAt(q))) q++;
    if (q < n && src.charCodeAt(q) === 61) {
      q++;
      while (q < n && isWS(src.charCodeAt(q))) q++;
      if (q >= n) return -1;
      const vc = src.charCodeAt(q);
      if (vc === 34) {
        const e = src.indexOf('"', q + 1);
        if (e < 0) return -1;
        p = e + 1;
      } else if (vc === 39) {
        const e = src.indexOf("'", q + 1);
        if (e < 0) return -1;
        p = e + 1;
      } else {
        let r = q;
        while (r < n) {
          const uc = src.charCodeAt(r);
          if (uc === 32 || uc === 9 || uc === 10 || uc === 34 || uc === 39 || uc === 61 || uc === 60 || uc === 62 || uc === 96) break;
          r++;
        }
        if (r === q) return -1;
        p = r;
      }
    } else {
      p = q;
      sawWS = true;
    }
  }
}

// Parse a bracket autolink <scheme:...> or <email> starting at src[i] === '<'.
// Returns {href, text, end} or null.
function parseBracketAutolink(src, i) {
  const n = src.length;
  let p = i + 1;
  if (p >= n) return null;
  const c0 = src.charCodeAt(p);
  if ((c0 >= 65 && c0 <= 90) || (c0 >= 97 && c0 <= 122)) {
    let q = p + 1;
    while (q < n && q - p < 32) {
      const c = src.charCodeAt(q);
      if (isAlnum(c) || c === 43 || c === 45 || c === 46) q++;
      else break;
    }
    if (q - p >= 2 && q < n && src.charCodeAt(q) === 58) {
      let r = q + 1;
      while (r < n) {
        const c = src.charCodeAt(r);
        if (c === 62) {
          if (r === q + 1) return null;
          const raw = src.slice(i + 1, r);
          return { href: encodeAutoHref(raw), text: escapePlain(raw), end: r + 1 };
        }
        if (c === 60 || c === 32 || c === 9 || c === 10 || c < 32) return null;
        r++;
      }
      return null;
    }
  }
  let at = -1;
  let gt = -1;
  for (let j = i + 1; j < n; j++) {
    const c = src.charCodeAt(j);
    if (c === 62) { gt = j; break; }
    if (c === 64 && at < 0) at = j;
    if (c === 60 || c === 32 || c === 9 || c === 10 || c < 32) return null;
  }
  if (at < 0 || gt < 0) return null;
  const link = parseEmailLink(src, at, gt);
  if (!link) return null;
  if (link.start !== i + 1 || link.end !== gt) return null;
  return { href: link.href, text: link.text, end: gt + 1 };
}

// ---------- pass 1: link/image span detection ----------

// Scan src for link and image spans. Returns {spans, dead}: spans maps a
// bracket start index to {end, dest, title, isImage, labelStart, labelEnd};
// dead lists [start, end) ranges that mask emphasis. `refs` maps
// normalized labels to {dest, title}. Code spans, escapes, and HTML tags
// are skipped so brackets inside them never open.
function findLinkSpans(src, refs) {
  const spans = new Map();
  // Dead spans: failed `[...](...)` inline-link attempts. Marked's
  // blockSkip masks these for emphasis, so delimiters inside them cannot
  // open or close emphasis. (Failed reflinks do NOT suppress emphasis.)
  const dead = [];
  const brackets = [];
  const n = src.length;
  let i = 0;
  // Links formed so far (images do not count: a link may contain an
  // image, but not another link). Each opener records this count when
  // pushed; if it grew by the time a `]` reaches the opener, a link
  // formed inside the opener's content, so the opener is dead.
  let linkCount = 0;
  while (i < n) {
    const c = src.charCodeAt(i);
    if (c === 92) { i += (i + 1 < n) ? 2 : 1; continue; }
    if (c === 96) {
      let L = 1;
      while (i + L < n && src.charCodeAt(i + L) === 96) L++;
      // Inside a link label, marked's label regex accepts a code span
      // with ANY closing run length, so use the loose rule (first later
      // backtick run closes it). Outside a label, use the strict rule
      // (matching lengths) like the inline parser.
      let inLabel = false;
      for (let k = brackets.length - 1; k >= 0; k--) {
        if (brackets[k].active) { inLabel = true; break; }
      }
      let j = i + L;
      let closed = false;
      // A code span inside a label cannot span past the `]` that ends
      // the label: stop the closing-run search at the next `]`. Outside
      // a label, code spans may contain `]`.
      const nextClose = inLabel ? src.indexOf(']', j) : -1;
      const searchEnd = nextClose < 0 ? n : nextClose;
      while (j < searchEnd) {
        const b = src.indexOf('`', j);
        if (b < 0 || b >= searchEnd) break;
        let M = 1;
        while (b + M < n && src.charCodeAt(b + M) === 96) M++;
        if (inLabel || M === L) {
          // Mismatched code span in a label (e.g. `` ``guide` ``, opener
          // len 2, closer len 1): marked's label regex accepts it, but
          // its emStrong masking is strict — the len-M closer is an
          // unmatched backtick run that pairs with the next len-M run
          // in the paragraph, masking emphasis between them (doc-09,
          // doc-16, doc-28). Only when NO same-length closer exists
          // before ']' (`` `` a ` b `` `` has a strict len-2 closer, so
          // nothing leaks, doc-33).
          if (inLabel && M !== L) {
            let hasStrict = false;
            let q2 = i + L;
            while (q2 < searchEnd) {
              const sb = src.indexOf('`', q2);
              if (sb < 0 || sb >= searchEnd) break;
              let SM = 1;
              while (sb + SM < n && src.charCodeAt(sb + SM) === 96) SM++;
              if (SM === L) { hasStrict = true; break; }
              q2 = sb + SM;
            }
            if (!hasStrict) {
              // The closer (len M) leaks: pairs with the next len-M run.
              let q = b + M;
              while (q < n) {
                const nb = src.indexOf('`', q);
                if (nb < 0) break;
                let NM = 1;
                while (nb + NM < n && src.charCodeAt(nb + NM) === 96) NM++;
                if (NM === M) { dead.push([b, nb + NM]); break; }
                q = nb + NM;
              }
              // The opener (len L) also leaks: pairs with the next
              // len-L run (doc-09: `` ``url` `` opener pairs with a
              // later `` `` `` run, masking _issue table_).
              let q3 = i + L;
              while (q3 < n) {
                const nb = src.indexOf('`', q3);
                if (nb < 0) break;
                let NM = 1;
                while (nb + NM < n && src.charCodeAt(nb + NM) === 96) NM++;
                if (NM === L) { dead.push([i, nb + NM]); break; }
                q3 = nb + NM;
              }
            }
          }
          i = b + M; closed = true; break;
        }
        j = b + M;
      }
      if (!closed) {
        // Unmatched backtick: marked's label regex cannot match it, so
        // any open bracket's label is invalid (poison it) — unless the
        // run is 2+ backticks immediately followed by ']' (the
        // ``+(?=]) alternative allows trailing backticks in a label;
        // a single backtick before ']' does NOT match it, cm-525/537).
        if (!(L >= 2 && i + L < n && src.charCodeAt(i + L) === 93)) {
          for (const br of brackets) br.poisoned = true;
        }
        // An unmatched opener inside a label also leaks for masking:
        // it pairs with the next same-length run in the paragraph,
        // masking emphasis between them (doc-09: `` ``url` `` opener
        // pairs with a later `` `` `` run). Only when it is not a
        // trailing run (those are literal backticks, not openers).
        if (inLabel && !(L >= 2 && i + L < n && src.charCodeAt(i + L) === 93)) {
          let q = i + L;
          while (q < n) {
            const nb = src.indexOf('`', q);
            if (nb < 0) break;
            let NM = 1;
            while (nb + NM < n && src.charCodeAt(nb + NM) === 96) NM++;
            if (NM === L) { dead.push([i, nb + NM]); break; }
            q = nb + NM;
          }
        }
        i += L;
      }
      continue;
    }
    if (c === 60) {
      const tagEnd = parseHtmlTag(src, i);
      if (tagEnd > 0) { i = tagEnd; continue; }
      const auto = parseBracketAutolink(src, i);
      if (auto) { i = auto.end; continue; }
      i++;
      continue;
    }
    if (c === 91) {
      brackets.push({ start: i, labelStart: i + 1, image: false, active: true, linkCountAtPush: linkCount });
      i++;
      continue;
    }
    if (c === 33 && i + 1 < n && src.charCodeAt(i + 1) === 91) {
      brackets.push({ start: i, labelStart: i + 2, image: true, active: true, linkCountAtPush: linkCount });
      i += 2;
      continue;
    }
    if (c === 93) {
      let bi = -1;
      for (let k = brackets.length - 1; k >= 0; k--) {
        if (brackets[k].active) { bi = k; break; }
      }
      if (bi < 0) { i++; continue; }
      const b = brackets[bi];
      const labelEnd = i;
      if (b.poisoned) {
        // The label contains an unmatched backtick: it cannot form a
        // link (marked's label regex rejects it). If this was an inline
        // link attempt `[...](...)`, the span is dead for emphasis.
        if (i + 1 < n && src.charCodeAt(i + 1) === 40) dead.push([b.start, i]);
        brackets.splice(bi, 1);
        i++;
        continue;
      }
      if (!b.image && linkCount > b.linkCountAtPush) {
        // A link formed inside this opener's content: the opener is
        // dead. Deactivate it and treat this `]` as literal text;
        // do not fall back to an earlier opener.
        b.active = false;
        i++;
        continue;
      }
      let link = null;
      if (i + 1 < n && src.charCodeAt(i + 1) === 40) {
        const dt = parseDestTitle(src, i + 2);
        if (dt) link = { dest: dt.dest, title: dt.title, end: dt.end };
      }
      if (!link && i + 1 < n && src.charCodeAt(i + 1) === 91) {
        let j = i + 2;
        let refEnd = -1;
        while (j < n) {
          const rc = src.charCodeAt(j);
          if (rc === 92 && j + 1 < n) { j += 2; continue; }
          if (rc === 93) { refEnd = j; break; }
          if (rc === 91) break;
          j++;
        }
        if (refEnd >= 0) {
          const refLabel = refEnd === i + 2
            ? src.slice(b.labelStart, labelEnd)
            : src.slice(i + 2, refEnd);
          if (refLabel.length <= 999) {
            const ref = refs.get(normalizeLabel(refLabel));
            if (ref) link = { dest: ref.dest, title: ref.title, end: refEnd + 1 };
          }
        }
      }
      if (!link && !(i + 1 < n && src.charCodeAt(i + 1) === 91)) {
        const labelText = src.slice(b.labelStart, labelEnd);
        if (labelText.length <= 999) {
          const ref = refs.get(normalizeLabel(labelText));
          if (ref) link = { dest: ref.dest, title: ref.title, end: i + 1 };
        }
      }
      if (link) {
        spans.set(b.start, {
          end: link.end, dest: link.dest, title: link.title,
          isImage: b.image, labelStart: b.labelStart, labelEnd,
        });
        brackets.length = bi;
        if (!b.image) linkCount++;
        i = link.end;
        continue;
      }
      // No link formed. If this was an inline link attempt `[...](...)`,
      // the span is dead for emphasis (marked's blockSkip masks it).
      if (i + 1 < n && src.charCodeAt(i + 1) === 40) dead.push([b.start, i]);
      brackets.splice(bi, 1);
      i++;
      continue;
    }
    i++;
  }
  return { spans, dead };
}

// Document-level "inside a link" state (marked's Lexer.state.inLink).
// An inline `<a ...>` tag sets it, `</a>` clears it, and it persists
// across paragraphs. While set, extended autolinks are suppressed
// (bracket autolinks are not). Reset at the start of each parse().
let inLinkState = false;

// ---------- pass 2: the inline parser ----------

// Parse inline content to HTML. `refs` maps normalized labels to
// {dest, title}. When `textOnly` is true, emits raw text content (for image
// alt text) with no tags and no escaping. When `noAutolink` is true,
// extended autolinks are suppressed (link labels).
function parseInline(src, refs, textOnly, noAutolink) {
  const n = src.length;
  const out = [];
  const delims = [];
  const linkInfo = src.indexOf('[') < 0 ? null : findLinkSpans(src, refs);
  const spans = linkInfo ? linkInfo.spans : null;
  const deadSpans = linkInfo ? linkInfo.dead : null;
  const re = /[\\`*_[\]!<>~&\n]/g;
  let textStart = 0;

  // Flush pending text [textStart, end), detecting extended autolinks.
  // Returns the resume position: normally `end`, but further along when an
  // autolink swallowed characters past `end`.
  function flushText(end) {
    if (end <= textStart) return end;
    if (textOnly || noAutolink || inLinkState) {
      out.push(textOnly ? src.slice(textStart, end) : escapeTextRun(src.slice(textStart, end)));
      textStart = end;
      return end;
    }
    let pos = textStart;
    let searchFrom = textStart;
    // Is the text up to `end` inside an emphasis span closed by the
    // delimiter at `end`? If so, an email ending at `end` still links.
    let inEmphasis = false;
    if (end < n) {
      const ec = src.charCodeAt(end);
      if (ec === 42 || ec === 95 || ec === 126) {
        for (let d = delims.length - 1; d >= 0; d--) {
          if (delims[d].ch === ec && delims[d].open) { inEmphasis = true; break; }
        }
      }
    }
    while (searchFrom < end) {
      const cand = findAutolinkStart(src, searchFrom, end);
      if (cand < 0) break;
      const link = tryAutolink(src, cand, end, inEmphasis, pos);
      if (!link || link.start < pos) { searchFrom = cand + 1; continue; }
      if (link.start > pos) out.push(escapeTextRun(src.slice(pos, link.start)));
      out.push('<a href="' + link.href + '">' + link.text + '</a>');
      pos = link.end;
      searchFrom = link.end;
      if (pos > end) { textStart = pos; return pos; }
    }
    if (pos < end) out.push(escapeTextRun(src.slice(pos, end)));
    textStart = end;
    return end;
  }

  // Splice an opening tag into a delimiter's output segment. The segment
  // layout is [closing tags][remaining delimiters][opening tags]; the used
  // delimiters come off the end of the remaining run.
  function applyOpenTag(d, tag, use) {
    const s = out[d.outIdx];
    const dEnd = d.closeLen + d.len;
    out[d.outIdx] = s.slice(0, dEnd - use) + tag + s.slice(dEnd);
    d.len -= use;
  }
  // Splice a closing tag into a delimiter's output segment. The used
  // delimiters come off the start of the remaining run.
  function applyCloseTag(d, tag, use) {
    const s = out[d.outIdx];
    out[d.outIdx] = s.slice(0, d.closeLen) + tag + s.slice(d.closeLen + use);
    d.closeLen += tag.length;
    d.len -= use;
  }

  // Handle a delimiter run of char `ch` starting at `i`. Returns the index
  // just past the run (or further when an autolink swallowed it).
  function handleDelim(i, ch) {
    let L = 1;
    while (i + L < n && src.charCodeAt(i + L) === ch) L++;
    const before = i > 0 ? src.charCodeAt(i - 1) : -1;
    const after = i + L < n ? src.charCodeAt(i + L) : -1;
    const beforeWS = before < 0 || isSpaceCode(before);
    const afterWS = after < 0 || isSpaceCode(after);
    const beforePunct = before >= 0 && isPunctCode(before);
    const afterPunct = after >= 0 && isPunctCode(after);
    const left = !afterWS && (!afterPunct || beforeWS || beforePunct);
    const right = !beforeWS && (!beforePunct || afterWS || afterPunct);
    let canOpen, canClose;
    if (ch === 95) { // '_': intraword rule
      canOpen = left && (!right || beforePunct);
      canClose = right && (!left || afterPunct);
    } else {
      canOpen = left;
      canClose = right;
    }
    if (ch === 126 && L >= 3) { canOpen = false; canClose = false; }
    if (!canOpen && !canClose) return i + L;
    // Delimiters inside a failed `[...](...)` cannot open or close
    // emphasis (marked's blockSkip masks the span).
    if (deadSpans) {
      for (let d = 0; d < deadSpans.length; d++) {
        if (i > deadSpans[d][0] && i < deadSpans[d][1]) return i + L;
      }
    }
    const resume = flushText(i);
    if (resume > i) return resume;
    out.push(String.fromCharCode(ch).repeat(L));
    const d = { ch, len: L, orig: L, open: canOpen, close: canClose, outIdx: out.length - 1, closeLen: 0, pos: i };
    if (canClose) {
      if (ch === 126) {
        // '~': only equal-length runs of 1 or 2 match, both fully consumed.
        for (let k = delims.length - 1; k >= 0; k--) {
          const o = delims[k];
          if (o.ch !== 126 || o.len !== d.len) continue;
          applyOpenTag(o, textOnly ? '' : '<del>', o.len);
          applyCloseTag(d, textOnly ? '' : '</del>', d.len);
          delims.splice(k, 1);
          d.len = 0;
          break;
        }
      } else {
        let k = delims.length - 1;
        while (d.len > 0 && k >= 0) {
          const o = delims[k];
          if (o.ch !== ch) { k--; continue; }
          if (((o.open && o.close) || (d.open && d.close)) && (o.orig + d.orig) % 3 === 0 && (o.orig % 3 !== 0 || d.orig % 3 !== 0)) { k--; continue; }
          // A single-delimiter closer does not steal from a two-
          // delimiter opener when a multi-delimiter closer follows
          // later: marked's opener-driven emStrong lets the opener
          // match the later closer (forming strong) and leaves the
          // single closer literal (doc-01, doc-26). Openers of length
          // 3+ can spare one delimiter and still form strong (cm-430).
          if (d.len === 1 && o.len === 2 && ch === 42) {
            let hasLaterStrong = false;
            for (let s = i + 1; s + 1 < n; s++) {
              if (src.charCodeAt(s) === 42 && src.charCodeAt(s + 1) === 42) { hasLaterStrong = true; break; }
              if (src.charCodeAt(s) === 10) break;
            }
            if (hasLaterStrong) { k--; continue; }
          }
          const use = (o.len >= 2 && d.len >= 2) ? 2 : 1;
          const tag = use === 2 ? 'strong' : 'em';
          applyOpenTag(o, textOnly ? '' : '<' + tag + '>', use);
          applyCloseTag(d, textOnly ? '' : '</' + tag + '>', use);
          // A *** closer matching a ** opener leaves one * over. Marked's
          // opener-driven emStrong uses all three delimiters (leaving the
          // extra * INSIDE the strong) when an intermediate * delimiter
          // can both open and close (it adds to the opener count m); with
          // no such intermediate delimiter, only two are used and the
          // extra * stays outside (doc-11, doc-30 vs **a *b* c***).
          if (use === 2 && d.len === 1 && o.orig === 2 && ch === 42 && !textOnly) {
            let hasBoth = false;
            for (let s = o.pos + o.orig; s < d.pos; s++) {
              if (src.charCodeAt(s) !== 42) continue;
              let RL = 1;
              while (s + RL < d.pos && src.charCodeAt(s + RL) === 42) RL++;
              const bB = s > 0 ? src.charCodeAt(s - 1) : -1;
              const aA = s + RL < n ? src.charCodeAt(s + RL) : -1;
              const bWS = bB < 0 || isSpaceCode(bB);
              const aWS = aA < 0 || isSpaceCode(aA);
              const bP = bB >= 0 && isPunctCode(bB);
              const aP = aA >= 0 && isPunctCode(aA);
              const lft = !aWS && (!aP || bWS || bP);
              const rgt = !bWS && (!bP || aWS || aP);
              if (lft && rgt) { hasBoth = true; break; }
              s += RL - 1;
            }
            if (hasBoth) {
              // Move the leftover * from after </strong> to before it.
              const seg = out[d.outIdx];
              const tagStart = d.closeLen - 9; // '</strong>' is 9 chars
              out[d.outIdx] = seg.slice(0, tagStart) + '*' + seg.slice(tagStart, d.closeLen) + seg.slice(d.closeLen + 1);
              d.len = 0;
            }
          }
          // Openers between the matched pair are now inside the span and
          // can no longer match anything outside it.
          delims.splice(k + 1);
          if (use === 2 && ch === 42 && d.open && d.close && !(o.open && o.close) && d.len === 0) {
            // A ** closer that can also open swallows any open single-*
            // runs: marked never forms * emphasis across such a strong
            // span. ** openers (len 2) survive: they can still form
            // strong outside it (doc-02).
            for (let m = delims.length - 1; m >= 0; m--) {
              if (delims[m].ch === 42 && delims[m].len < 2) delims.splice(m, 1);
            }
            break;
          }
          if (o.len === 0) { delims.splice(k, 1); k--; }
        }
      }
    }
    if (d.len > 0 && canOpen) delims.push(d);
    textStart = i + L;
    return i + L;
  }

  // Handle a link/image span starting at `i`. The text before `i` is already
  // flushed. Returns the index just past the span.
  function handleSpan(i, span) {
    const labelSrc = src.slice(span.labelStart, span.labelEnd);
    if (textOnly) {
      out.push(parseInline(labelSrc, refs, true, true));
      return span.end;
    }
    if (span.isImage) {
      const alt = escapeAttr(parseInline(labelSrc, refs, true, true));
      let tag = '<img src="' + encodeHref(span.dest) + '" alt="' + alt + '"';
      if (span.title != null && span.title !== '') tag += ' title="' + escapeAttr(span.title) + '"';
      tag += '>';
      out.push(tag);
    } else {
      const labelHtml = parseInline(labelSrc, refs, false, true);
      let tag = '<a href="' + encodeHref(span.dest) + '"';
      if (span.title != null && span.title !== '') tag += ' title="' + escapeAttr(span.title) + '"';
      tag += '>' + labelHtml + '</a>';
      out.push(tag);
    }
    return span.end;
  }

  let m;
  re.lastIndex = 0;
  while ((m = re.exec(src)) !== null) {
    const i = m.index;
    const c = src.charCodeAt(i);
    if (c === 92) { // backslash
      if (i + 1 < n) {
        const nc = src.charCodeAt(i + 1);
        if (nc === 10) { // hard break
          const resume = flushText(i);
          if (resume > i) { re.lastIndex = resume; textStart = resume; continue; }
          out.push(textOnly ? '\n' : '<br>');
          let k = i + 2;
          while (k < n && (src.charCodeAt(k) === 32 || src.charCodeAt(k) === 9)) k++;
          re.lastIndex = k; textStart = k;
          continue;
        }
        if (isAsciiPunct(nc)) {
          const resume = flushText(i);
          if (resume > i) { re.lastIndex = resume; textStart = resume; continue; }
          out.push(textOnly ? src[i + 1] : escapePlain(src[i + 1]));
          re.lastIndex = i + 2; textStart = i + 2;
          continue;
        }
      }
      continue; // literal backslash stays in the text run
    }
    if (c === 96) { // backtick: code span
      let L = 1;
      while (i + L < n && src.charCodeAt(i + L) === 96) L++;
      let j = i + L;
      let closeAt = -1;
      while (j < n) {
        const b = src.indexOf('`', j);
        if (b < 0) break;
        let M = 1;
        while (b + M < n && src.charCodeAt(b + M) === 96) M++;
        if (M === L) { closeAt = b; break; }
        j = b + M;
      }
      if (closeAt < 0) { re.lastIndex = i + L; continue; } // literal backticks
      const resume = flushText(i);
      if (resume > i) { re.lastIndex = resume; textStart = resume; continue; }
      let content = src.slice(i + L, closeAt).replace(/\n/g, ' ');
      if (content.length >= 2 && content.charCodeAt(0) === 32 && content.charCodeAt(content.length - 1) === 32 && /[^ ]/.test(content)) {
        content = content.slice(1, -1);
      }
      out.push(textOnly ? content : '<code>' + escapePlain(content) + '</code>');
      re.lastIndex = closeAt + L; textStart = closeAt + L;
      continue;
    }
    if (c === 42 || c === 95 || c === 126) { // '*', '_', '~'
      re.lastIndex = handleDelim(i, c);
      continue;
    }
    if (c === 91) { // '['
      const span = spans ? spans.get(i) : undefined;
      if (span !== undefined) {
        const resume = flushText(i);
        if (resume > i) { re.lastIndex = resume; textStart = resume; continue; }
        const ni = handleSpan(i, span);
        re.lastIndex = ni; textStart = ni;
        continue;
      }
      continue; // literal '[' stays in the text run
    }
    if (c === 93) { // ']' always literal here (links resolve via spans)
      continue;
    }
    if (c === 33) { // '!'
      if (i + 1 < n && src.charCodeAt(i + 1) === 91) {
        const span = spans ? spans.get(i) : undefined;
        if (span !== undefined) {
          const resume = flushText(i);
          if (resume > i) { re.lastIndex = resume; textStart = resume; continue; }
          const ni = handleSpan(i, span);
          re.lastIndex = ni; textStart = ni;
          continue;
        }
        re.lastIndex = i + 2;
        continue;
      }
      continue; // literal '!' stays in the text run
    }
    if (c === 60) { // '<' autolink, HTML tag, or literal
      const auto = parseBracketAutolink(src, i);
      if (auto) {
        const resume = flushText(i);
        if (resume > i) { re.lastIndex = resume; textStart = resume; continue; }
        out.push(textOnly ? auto.text : '<a href="' + auto.href + '">' + auto.text + '</a>');
        re.lastIndex = auto.end; textStart = auto.end;
        continue;
      }
      const tagEnd = parseHtmlTag(src, i);
      if (tagEnd > 0) {
        const resume = flushText(i);
        if (resume > i) { re.lastIndex = resume; textStart = resume; continue; }
        // Track <a ...> / </a> for the document-level inLink state
        // (marked's startATag /^<a /i" needs the space; endATag "</a>").
        const tagText = src.slice(i, Math.min(tagEnd, i + 4)).toLowerCase();
        if (tagText.startsWith('<a ')) inLinkState = true;
        else if (tagText === '</a>') inLinkState = false;
        out.push(src.slice(i, tagEnd));
        re.lastIndex = tagEnd; textStart = tagEnd;
        continue;
      }
      const resume = flushText(i);
      if (resume > i) { re.lastIndex = resume; textStart = resume; continue; }
      out.push(textOnly ? '<' : '&lt;');
      re.lastIndex = i + 1; textStart = i + 1;
      continue;
    }
    if (c === 38) { // '&' entity or literal
      const elen = entityLen(src, i);
      if (elen > 0) {
        const resume = flushText(i);
        if (resume > i) { re.lastIndex = resume; textStart = resume; continue; }
        if (src.charCodeAt(i + 1) === 35) {
          const hex = src.charCodeAt(i + 2) === 120 || src.charCodeAt(i + 2) === 88;
          const body = src.slice(hex ? i + 3 : i + 2, i + elen - 1);
          const decoded = numericChar(body, hex);
          out.push(textOnly ? decoded : escapePlain(decoded));
        } else {
          out.push(src.slice(i, i + elen));
        }
        re.lastIndex = i + elen; textStart = i + elen;
        continue;
      }
      const resume = flushText(i);
      if (resume > i) { re.lastIndex = resume; textStart = resume; continue; }
      out.push(textOnly ? '&' : '&amp;');
      re.lastIndex = i + 1; textStart = i + 1;
      continue;
    }
    if (c === 10) { // newline: hard break with 2+ trailing spaces, else soft
      let spaces = 0;
      let j = i - 1;
      while (j >= textStart && src.charCodeAt(j) === 32) { spaces++; j--; }
      if (spaces >= 2) {
        const resume = flushText(i - spaces);
        if (resume > i - spaces) { re.lastIndex = resume; textStart = resume; continue; }
        out.push(textOnly ? '\n' : '<br>');
        let k = i + 1;
        while (k < n && (src.charCodeAt(k) === 32 || src.charCodeAt(k) === 9)) k++;
        re.lastIndex = k; textStart = k;
        continue;
      }
      continue; // soft break: the newline stays in the text run
    }
  }
  flushText(n);
  return out.join('');
}

// ---------- block parser: line state ----------

// A line state tracks a position within one source line: `line` is the raw
// line, `pos` the char index, `col` the column (tabs expand to the next
// multiple of 4), and `virt` the number of virtual spaces pending from a
// partially consumed tab. The effective content is ' '.repeat(virt) +
// line.slice(pos).
function stChar(st) {
  if (st.virt > 0) return 32;
  if (st.pos < st.line.length) return st.line.charCodeAt(st.pos);
  return -1;
}
function stAdvance(st) {
  if (st.virt > 0) { st.virt--; st.col++; }
  else { st.pos++; st.col++; }
}
function stContent(st) {
  return (st.virt > 0 ? ' '.repeat(st.virt) : '') + st.line.slice(st.pos);
}

// Like stContent, but with tabs expanded to spaces (for code blocks,
// where a tab advances to the next multiple of 4).
function stContentExpanded(st) {
  const raw = stContent(st);
  if (raw.indexOf('\t') < 0) return raw;
  let out = '';
  let col = st.col;
  for (let i = 0; i < raw.length; i++) {
    const c = raw.charCodeAt(i);
    if (c === 9) {
      const spaces = 4 - (col % 4);
      out += ' '.repeat(spaces);
      col += spaces;
    } else {
      out += raw[i];
      col++;
    }
  }
  return out;
}

// Expand only the leading tabs of a fenced code content line (tabs after
// the first non-whitespace character stay literal).
function expandLeadingTabs(st) {
  const raw = stContent(st);
  let col = st.col;
  let i = 0;
  let out = '';
  while (i < raw.length) {
    const c = raw.charCodeAt(i);
    if (c === 9) {
      const spaces = 4 - (col % 4);
      out += ' '.repeat(spaces);
      col += spaces;
      i++;
    } else if (c === 32) {
      out += ' ';
      col++;
      i++;
    } else {
      break;
    }
  }
  return i === 0 ? raw : out + raw.slice(i);
}
// Columns of indentation (spaces/tabs) at the current position, without moving.
function stIndent(st) {
  let col = st.col;
  let i = st.pos;
  let virt = st.virt;
  while (virt > 0) { virt--; col++; }
  while (i < st.line.length) {
    const c = st.line.charCodeAt(i);
    if (c === 32) { i++; col++; }
    else if (c === 9) { i++; col += 4 - (col % 4); }
    else break;
  }
  return col - st.col;
}
// Consume up to `n` columns of indentation (spaces/tabs). A tab that would
// pass the limit is partially consumed, leaving virtual spaces. Returns the
// columns actually consumed.
function stConsumeIndent(st, n) {
  let done = 0;
  while (done < n) {
    if (st.virt > 0) { const take = Math.min(st.virt, n - done); st.virt -= take; st.col += take; done += take; continue; }
    if (st.pos >= st.line.length) break;
    const c = st.line.charCodeAt(st.pos);
    if (c === 32) { st.pos++; st.col++; done++; }
    else if (c === 9) {
      const w = 4 - (st.col % 4);
      if (done + w <= n) { st.pos++; st.col += w; done += w; }
      else { st.virt = done + w - n; st.pos++; st.col += n - done; done = n; }
    } else break;
  }
  return done;
}
// Expand leading tabs at the current position into virtual spaces (to
// the next tab stop). Used after container indent stripping: a tab that
// starts at or after the indent boundary counts as spaces to the next
// multiple of 4 (marked's list/quote tokenizers expand leading tabs
// before slicing). Tabs after the first non-whitespace char are untouched.
function expandLeadingTabsState(st) {
  while (st.pos < st.line.length && st.line.charCodeAt(st.pos) === 9) {
    const w = 4 - ((st.col + st.virt) % 4);
    st.pos++;
    st.virt += w;
  }
}
// Is the rest of the line blank (only spaces/tabs)?
function stIsBlank(st) {
  if (st.virt > 0) return false; // virtual spaces are content, not blank
  for (let i = st.pos; i < st.line.length; i++) {
    const c = st.line.charCodeAt(i);
    if (c !== 32 && c !== 9) return false;
  }
  return true;
}

// ---------- block parser: matchers ----------

// ATX heading: up to 3 spaces, 1-6 '#', then space/tab/end (or end of line).
// Returns {level, text} (text with trailing #'s and spaces stripped) or null.
function matchAtx(st) {
  const savePos = st.pos, saveCol = st.col, saveVirt = st.virt;
  stConsumeIndent(st, 3);
  let level = 0;
  while (stChar(st) === 35 && level < 7) { stAdvance(st); level++; }
  if (level === 0 || level > 6) { st.pos = savePos; st.col = saveCol; st.virt = saveVirt; return null; }
  const c = stChar(st);
  if (c !== -1 && c !== 32 && c !== 9) { st.pos = savePos; st.col = saveCol; st.virt = saveVirt; return null; }
  let text = stContent(st).replace(/^[ \t]+/, '').replace(/[ \t]+$/, '');
  // A closing sequence of #'s preceded by spaces is stripped; a heading
  // whose text is only #'s is empty.
  const closer = text.match(/^(.*?)[ \t]+#+$/);
  if (closer) text = closer[1].replace(/[ \t]+$/, '');
  else if (/^#+$/.test(text)) text = '';
  return { level, text };
}

// Fenced code start: up to 3 spaces, then 3+ backticks or tildes.
// Returns {char, len, info} or null. Backtick fences may not have ` in info.
function matchFence(st) {
  const savePos = st.pos, saveCol = st.col, saveVirt = st.virt;
  stConsumeIndent(st, 3);
  const c = stChar(st);
  if (c !== 96 && c !== 126) { st.pos = savePos; st.col = saveCol; st.virt = saveVirt; return null; }
  let len = 0;
  while (stChar(st) === c) { stAdvance(st); len++; }
  if (len < 3) { st.pos = savePos; st.col = saveCol; st.virt = saveVirt; return null; }
  const info = stContent(st).replace(/^[ \t]+/, '').replace(/[ \t]+$/, '');
  if (c === 96 && info.indexOf('`') >= 0) { st.pos = savePos; st.col = saveCol; st.virt = saveVirt; return null; }
  return { char: c, len, info };
}

// Thematic break: up to 3 spaces, then 3+ of -, _, * (same char), with only
// spaces/tabs between. Returns true/false.
function matchHr(st) {
  const savePos = st.pos, saveCol = st.col, saveVirt = st.virt;
  stConsumeIndent(st, 3);
  const c = stChar(st);
  if (c !== 45 && c !== 95 && c !== 42) { st.pos = savePos; st.col = saveCol; st.virt = saveVirt; return false; }
  let count = 0;
  while (true) {
    const ch = stChar(st);
    if (ch === c) { count++; stAdvance(st); }
    else if (ch === 32 || ch === 9) stAdvance(st);
    else break;
  }
  const ok = count >= 3 && stChar(st) === -1;
  if (!ok) { st.pos = savePos; st.col = saveCol; st.virt = saveVirt; }
  return ok;
}

// Does a line (in item-text coordinates) start a fence, ATX heading, hr,
// or HTML block? Used for the fenced-code lazy-continuation rejection
// (marked's list loop rejects a lazy line when the previous line starts
// one of these).
function lineStartsBlock(content) {
  const fresh = () => ({ line: content, pos: 0, col: 0, virt: 0 });
  return !!matchFence(fresh()) || !!matchAtx(fresh()) || matchHr(fresh()) || matchHtmlBlock(fresh()) >= 1;
}

// Setext heading underline: up to 3 spaces, then 1+ '=' (level 1) or '-'
// (level 2), then only spaces/tabs. Returns the level or 0.
function matchSetext(st) {
  const savePos = st.pos, saveCol = st.col, saveVirt = st.virt;
  stConsumeIndent(st, 3);
  const c = stChar(st);
  if (c !== 61 && c !== 45) { st.pos = savePos; st.col = saveCol; st.virt = saveVirt; return 0; }
  let count = 0;
  while (stChar(st) === c) { stAdvance(st); count++; }
  while (stChar(st) === 32 || stChar(st) === 9) stAdvance(st);
  if (count >= 1 && stChar(st) === -1) return c === 61 ? 1 : 2;
  st.pos = savePos; st.col = saveCol; st.virt = saveVirt;
  return 0;
}

// List marker: up to 3 spaces, then a bullet (-, +, *) or an ordered marker
// (1-9 digits + '.' or ')'), followed by 1+ spaces/tabs (or end of line for
// an empty item). Returns {ordered, start, delim, markerLen, contentIndent,
// empty} or null. A tab right after the marker counts as a single column.
function matchListMarker(st) {
  const savePos = st.pos, saveCol = st.col, saveVirt = st.virt;
  const baseCol = st.col;
  stConsumeIndent(st, 3);
  const indent = st.col - baseCol;
  const c = stChar(st);
  let ordered = false, start = 0, delim = 0, markerLen = 0;
  if (c === 45 || c === 43 || c === 42) {
    delim = c;
    stAdvance(st);
    markerLen = 1;
  } else if (c >= 48 && c <= 57) {
    let num = 0, digits = 0;
    while (true) {
      const d = stChar(st);
      if (d >= 48 && d <= 57 && digits < 9) { num = num * 10 + (d - 48); digits++; stAdvance(st); }
      else break;
    }
    if (digits === 0) { st.pos = savePos; st.col = saveCol; st.virt = saveVirt; return null; }
    const d = stChar(st);
    if (d !== 46 && d !== 41) { st.pos = savePos; st.col = saveCol; st.virt = saveVirt; return null; }
    delim = d;
    stAdvance(st);
    ordered = true;
    start = num;
    markerLen = digits + 1;
  } else {
    st.pos = savePos; st.col = saveCol; st.virt = saveVirt;
    return null;
  }
  // Whitespace after the marker. A tab counts as one column and ends the run.
  let spaces = 0;
  let hitTab = false;
  while (true) {
    const ch = stChar(st);
    if (ch === 32) { stAdvance(st); spaces++; if (spaces >= 5) break; }
    else if (ch === 9) {
      // consume a single column of the tab
      st.virt = 0;
      const w = 4 - (st.col % 4);
      st.pos++;
      st.col++;
      if (w > 1) st.virt = w - 1;
      spaces++;
      hitTab = true;
      break;
    } else break;
  }
  const afterWS = stChar(st);
  if (spaces === 0) {
    // No space after the marker: only an empty item (end of line) counts.
    if (afterWS !== -1) { st.pos = savePos; st.col = saveCol; st.virt = saveVirt; return null; }
    return { ordered, start, delim, markerLen, contentIndent: indent + markerLen + 1, empty: true };
  }
  if (afterWS === -1) {
    // Empty item: the content indent is marker + 1.
    return { ordered, start, delim, markerLen, contentIndent: indent + markerLen + 1, empty: true };
  }
  let contentIndent;
  if (spaces >= 5 || hitTab) contentIndent = indent + markerLen + 1;
  else contentIndent = indent + markerLen + spaces;
  // When spaces >= 5 the extra spaces belong to the content; back up so the
  // content starts after marker+1 columns. (Our consume already advanced
  // past all 5; rewind by spaces-1 columns via virtual spaces.)
  if (spaces >= 5 && !hitTab) {
    // The extra spaces belong to the content; rewind the column so the
    // virtual spaces start at the content indent.
    st.virt = spaces - 1;
    st.col -= spaces - 1;
  }
  return { ordered, start, delim, markerLen, contentIndent, empty: false };
}

// Blockquote marker: up to 3 spaces, then '>'. The whitespace after '>'
// is tab-expanded starting at the marker length (marked's
// blockquoteMarkerWhitespace + J), then one space is dropped (the quote
// separator); the remainder is virtual indent. The column resets to the
// content-relative column (marked strips the quote and lexes the content
// fresh). Returns true/false.
function matchQuote(st) {
  const savePos = st.pos, saveCol = st.col, saveVirt = st.virt;
  const startCol = st.col + st.virt;
  stConsumeIndent(st, 3);
  if (stChar(st) !== 62) { st.pos = savePos; st.col = saveCol; st.virt = saveVirt; return false; }
  const markerLen = (st.col + st.virt) - startCol + 1;
  stAdvance(st);
  let col = markerLen;
  let expanded = 0;
  while (st.pos < st.line.length) {
    const c = st.line.charCodeAt(st.pos);
    if (c === 32) { expanded++; col++; st.pos++; }
    else if (c === 9) { const w = 4 - (col % 4); expanded += w; col += w; st.pos++; }
    else break;
  }
  const leftover = expanded > 0 ? expanded - 1 : 0;
  st.virt = leftover;
  st.col = leftover;
  return true;
}

// HTML block start types 1-6 (can interrupt a paragraph) and 7 (cannot).
// Returns the type (1-7) or 0. `st` is positioned at the line content.
function matchHtmlBlock(st) {
  const savePos = st.pos, saveCol = st.col, saveVirt = st.virt;
  stConsumeIndent(st, 3);
  if (stChar(st) !== 60) { st.pos = savePos; st.col = saveCol; st.virt = saveVirt; return 0; }
  const rest = stContent(st);
  // Type 1: <script, <pre, <style, <textarea (case-insensitive)
  if (/^<(?:script|pre|style|textarea)(?:[ \t\n\/>]|$)/i.test(rest)) return 1;
  // Type 2: <!--
  if (rest.startsWith('<!--')) return 2;
  // Type 3: <?
  if (rest.startsWith('<?')) return 3;
  // Type 4: <! + letter
  if (/^<![A-Za-z]/.test(rest)) return 4;
  // Type 5: <![CDATA[
  if (rest.startsWith('<![CDATA[')) return 5;
  // Type 6: block tag open/close (list from the spec)
  const m6 = rest.match(/^<\/?([A-Za-z][A-Za-z0-9-]*)(?:[ \t\n\/>]|$)/);
  if (m6) {
    const tag = m6[1].toLowerCase();
    if (BLOCK_TAGS.has(tag)) return 6;
  }
  // Type 7: any other complete open/close tag on the line by itself.
  // Closing tags take no attributes.
  if (rest.startsWith('</')) {
    if (/^<\/[A-Za-z][A-Za-z0-9-]*[ \t]*>[ \t]*$/.test(rest)) return 7;
  } else {
    const m7 = rest.match(/^<[A-Za-z][A-Za-z0-9-]*(?:[ \t]+[A-Za-z_:][A-Za-z0-9_.:-]*(?:[ \t]*=[ \t]*(?:"[^"]*"|'[^']*'|[^ \t\n"'=<>`]+))?)*[ \t]*\/?>[ \t]*$/);
    if (m7) return 7;
  }
  st.pos = savePos; st.col = saveCol; st.virt = saveVirt;
  return 0;
}

const BLOCK_TAGS = new Set(('address article aside base basefont blockquote body caption center col colgroup dd details dialog dir div dl dt fieldset figcaption figure footer form frame frameset h1 h2 h3 h4 h5 h6 head header hr html iframe legend li link main menu menuitem nav noframes ol optgroup option p param search section summary table tbody td tfoot th thead title tr track ul').split(' '));

// End conditions for HTML block types 1-6 (checked per line).
function htmlBlockEnds(type, line) {
  if (type === 1) return /<\/(?:script|pre|style|textarea)>/i.test(line);
  if (type === 2) return line.indexOf('-->') >= 0;
  if (type === 3) return line.indexOf('?>') >= 0;
  if (type === 4) return line.indexOf('>') >= 0;
  if (type === 5) return line.indexOf(']]>') >= 0;
  return false; // type 6 ends at a blank line
}

// ---------- block parser: link reference definitions ----------

// Try to parse one link reference definition at text[start]. Returns
// {label, dest, title, end} (end is just past the definition's last line)
// or null.
function parseRefDef(text, start) {
  const n = text.length;
  let p = start;
  let spaces = 0;
  while (p < n && spaces < 3) {
    const c = text.charCodeAt(p);
    if (c === 32) { p++; spaces++; }
    else if (c === 9) { p++; spaces += 4; }
    else break;
  }
  if (spaces > 3) return null;
  if (p >= n || text.charCodeAt(p) !== 91) return null; // '['
  p++;
  const labelStart = p;
  let labelLen = 0;
  while (p < n) {
    const c = text.charCodeAt(p);
    if (c === 93) break; // ']'
    if (c === 91) return null; // '[' inside a label
    if (c === 92 && p + 1 < n && isAsciiPunct(text.charCodeAt(p + 1))) { p += 2; labelLen += 2; }
    else { p++; labelLen++; }
    if (labelLen > 999) return null;
  }
  if (p >= n || labelLen === 0) return null;
  const label = text.slice(labelStart, p);
  if (normalizeLabel(label) === '') return null;
  p++; // ']'
  if (p >= n || text.charCodeAt(p) !== 58) return null; // ':'
  p++;
  // Skip whitespace (spaces, tabs, newlines), but not across a blank line.
  let newlines = 0;
  while (p < n) {
    const c = text.charCodeAt(p);
    if (c === 32 || c === 9) p++;
    else if (c === 10) { newlines++; if (newlines > 1) return null; p++; }
    else break;
  }
  if (p >= n) return null;
  let dest = '';
  if (text.charCodeAt(p) === 60) { // '<' destination
    p++;
    let closed = false;
    while (p < n) {
      const c = text.charCodeAt(p);
      if (c === 62) { closed = true; p++; break; }
      if (c === 10 || c === 60) return null;
      if (c === 92 && p + 1 < n && isAsciiPunct(text.charCodeAt(p + 1))) { dest += text[p + 1]; p += 2; }
      else { dest += text[p]; p++; }
    }
    if (!closed) return null;
  } else { // bare destination: one line, balanced parens, no spaces
    let depth = 0;
    const destStart = p;
    while (p < n) {
      const c = text.charCodeAt(p);
      if (c === 32 || c === 9 || c === 10) break;
      if (c === 92 && p + 1 < n && isAsciiPunct(text.charCodeAt(p + 1))) { p += 2; continue; }
      if (c === 40) depth++;
      if (c === 41) { depth--; if (depth < 0) break; }
      p++;
    }
    if (depth !== 0) return null;
    if (p === destStart) return null; // empty destination
    // Unescape backslash escapes in the destination.
    let raw = text.slice(destStart, p);
    if (raw.indexOf('\\') >= 0) {
      let d = '';
      for (let k = 0; k < raw.length; k++) {
        if (raw.charCodeAt(k) === 92 && k + 1 < raw.length && isAsciiPunct(raw.charCodeAt(k + 1))) { d += raw[k + 1]; k++; }
        else d += raw[k];
      }
      raw = d;
    }
    dest = raw;
  }
  // Optional title: whitespace (at most one newline, no blank line), then
  // a quoted title, then only whitespace to end of line. A title on the
  // same line as the destination needs whitespace before it.
  let title = null;
  let q = p;
  let nl = 0;
  let nlPos = -1;
  while (q < n) {
    const c = text.charCodeAt(q);
    if (c === 32 || c === 9) q++;
    else if (c === 10) { nl++; if (nl > 1) break; if (nlPos < 0) nlPos = q; q++; }
    else break;
  }
  if (q < n && nl <= 1) {
    const tc = text.charCodeAt(q);
    if ((tc === 34 || tc === 39 || tc === 40) && (nl === 1 || q > p)) {
      const closer = tc === 40 ? 41 : tc;
      let r = q + 1;
      let t = '';
      let closed = false;
      while (r < n) {
        const c = text.charCodeAt(r);
        if (c === closer) { closed = true; r++; break; }
        if (tc === 40 && c === 40) break;
        if (c === 92 && r + 1 < n && isAsciiPunct(text.charCodeAt(r + 1))) { t += text[r + 1]; r += 2; }
        else { t += text[r]; r++; }
      }
      if (closed) { title = t; q = r; }
    }
  }
  // Only whitespace may follow on the line.
  while (q < n) {
    const c = text.charCodeAt(q);
    if (c === 32 || c === 9) q++;
    else break;
  }
  if (q >= n) return { label, dest, title, end: n };
  if (text.charCodeAt(q) === 10) return { label, dest, title, end: q + 1 };
  // Content after the title/destination. If we crossed a newline looking
  // for a title, the definition still stands without one.
  if (nl === 1 && nlPos >= 0) return { label, dest, title: null, end: nlPos + 1 };
  return null;
}

// Extract leading link reference definitions from a paragraph's text.
// Adds them to `refs` (first definition wins). Returns the remaining text
// ('' when the paragraph was only definitions).
function extractRefDefs(text, refs) {
  let p = 0;
  const n = text.length;
  while (p < n) {
    // A definition must start the paragraph or follow another definition
    // directly (possibly after its own trailing newline, which
    // parseRefDef's end accounts for). No blank lines between.
    const def = parseRefDef(text, p);
    if (!def) break;
    const key = normalizeLabel(def.label);
    if (!refs.has(key)) refs.set(key, { dest: def.dest, title: def.title });
    p = def.end;
  }
  return text.slice(p);
}

// ---------- block parser: main loop ----------

function parseBlocks(input) {
  const text = input.replace(/\r\n?/g, '\n');
  const lines = text.split('\n');
  const endsWithNL = text.endsWith('\n');
  if (endsWithNL) lines.pop();
  const doc = { t: 'doc', children: [] };
  const refs = new Map();
  const stack = [doc];
  let lastWasBlank = false;
  let lastBlankEmpty = false;
  let blankDepth = 0;
  let blankInQuote = false;

  function top() { return stack[stack.length - 1]; }
  function currentLeaf() {
    const ch = top().children;
    if (ch.length === 0) return null;
    const last = ch[ch.length - 1];
    if ((last.t === 'para' || last.t === 'code' || last.t === 'html' || last.t === 'table') && !last.closed) return last;
    return null;
  }
  function finalizeLeaf(node) {
    if (!node || node.closed) return;
    node.closed = true;
    if (node.t === 'para') {
      const rest = extractRefDefs(node.text, refs);
      if (rest === '') {
        // The paragraph was only reference definitions: remove it. If it
        // followed a blank line, the blank carries forward to the next block.
        if (node.blankBefore) lastWasBlank = true;
        const ch = node.parent.children;
        const idx = ch.indexOf(node);
        if (idx >= 0) ch.splice(idx, 1);
      } else {
        node.text = rest;
      }
    } else if (node.t === 'code') {
      if (node.fenced) {
        // A fenced block keeps its content; only a trailing empty line
        // loses its newline.
        if (node.text === '\n' || node.text.endsWith('\n\n')) node.text = node.text.slice(0, -1);
      } else {
        // Strip trailing blank lines from indented code content.
        node.text = node.text.replace(/(?:\n[ \t]*)+$/, '\n');
      }
      if (node.text === '') node.text = '';
      else if (!node.text.endsWith('\n')) node.text += '\n';
      if (/^[ \t]*$/.test(node.text)) node.text = '';
    }
  }
  function finalizeContainer(node) {
    if (node.t === 'list') {
      // Tight unless an item (after the first) or a non-first child block
      // within an item was preceded by a blank line.
      let loose = false;
      for (let i = 0; i < node.children.length; i++) {
        const item = node.children[i];
        if (i > 0 && item.blankBefore) { loose = true; break; }
        for (let j = 1; j < item.children.length; j++) {
          if (item.children[j].blankBefore) { loose = true; break; }
        }
        if (loose) break;
      }
      node.tight = !loose;
    }
  }
  function closeTo(depth) {
    while (stack.length > depth) {
      const node = stack.pop();
      const ch = node.children;
      if (ch.length > 0) {
        const last = ch[ch.length - 1];
        if ((last.t === 'para' || last.t === 'code' || last.t === 'html' || last.t === 'table') && !last.closed) {
          finalizeLeaf(last);
        }
      }
      finalizeContainer(node);
    }
  }
  function addBlock(node) {
    node.parent = top();
    if (lastWasBlank) node.blankBefore = true;
    if (lastWasBlank && lastBlankEmpty) node.blankBeforeEmpty = true;
    top().children.push(node);
    return node;
  }
  // Append a normal (container-matching) continuation line to an open
  // paragraph. In a list item, a line whose content is indented 4+ is an
  // indented-code line in the item text: 4 columns are stripped (and a
  // following non-code line gains a blank line before it, because the
  // code text carries a trailing newline). In a quote or at top level
  // the indent is preserved by the paragraph match.
  function appendParaLine(para, st, content) {
    const parent = para.parent;
    const prevCode = !!para.lastCodePath;
    if (parent.t === 'item') {
      const indent = stIndent(st);
      if (indent >= 4) {
        stConsumeIndent(st, 4);
        para.text += '\n' + stContent(st);
        para.lastCodePath = true;
      } else {
        para.text += (prevCode ? '\n\n' : '\n') + content;
        para.lastCodePath = false;
      }
      para.lastLineIndent = indent;
    } else {
      para.text += '\n' + content;
      para.lastCodePath = false;
      para.lastLineIndent = stIndent(st);
    }
    para.lastLazy = false;
  }
  // Append a lazy continuation line (one that failed to match one or
  // more open containers) to an open paragraph. `st` is positioned
  // after the last matched container. Transformations follow marked:
  // - quote: a setext line after another lazy line gets 4 spaces
  //   prepended; a first-in-chunk line indented 4+ is code-stripped.
  // - list item: the line is stripped by the item indent when it
  //   reaches it, then by 4 more columns when the remainder is
  //   indented 4+ (code line in the item text). No setext prepend.
  // A line following a code line gains a blank line before it, unless
  // it is itself a code line (same code block).
  function appendLazy(para, st) {
    const parent = para.parent;
    const prevLazy = !!para.lastLazy;
    const prevCode = !!para.lastCodePath;
    const content = stContent(st);
    const indent = stIndent(st);
    let text;
    let codePath = false;
    if (parent.t === 'quote') {
      if (/^ {0,3}(=+|-+)[ \t]*$/.test(content) && prevLazy) {
        text = '    ' + content.replace(/^ {0,3}/, '');
      } else if (!prevLazy && indent >= 4) {
        stConsumeIndent(st, 4);
        text = stContent(st);
        codePath = true;
      } else {
        text = content;
      }
      para.lastLineIndent = indent;
    } else if (parent.t === 'item') {
      const R = parent.contentIndent;
      let itemIndent = indent;
      const reachedR = indent >= R;
      if (reachedR) {
        stConsumeIndent(st, R);
        itemIndent = stIndent(st);
      }
      if (itemIndent >= 4) {
        stConsumeIndent(st, 4);
        text = stContent(st);
        codePath = true;
      } else {
        text = stContent(st);
      }
      // lastLineIndent is the indent in item-text coordinates: when the
      // line did not reach the item indent it is negative (under-
      // indented), so it never triggers the lazy-line rejection.
      para.lastLineIndent = reachedR ? itemIndent : itemIndent - R;
    } else {
      text = content;
      para.lastLineIndent = indent;
    }
    para.text += (prevCode && !codePath ? '\n\n' : '\n') + text;
    para.lastLazy = true;
    para.lastCodePath = codePath;
  }

  for (let ln = 0; ln < lines.length; ln++) {
    const rawLine = lines[ln];
    const st = { line: rawLine, pos: 0, col: 0, virt: 0 };
    const isBlankLine = /^[ \t]*$/.test(rawLine);
    // The last line of an input without a trailing newline has no newline.
    const nl = (ln === lines.length - 1 && !endsWithNL) ? '' : '\n';

    // Phase 1: match open containers.
    let matched = 1;
    for (let si = 1; si < stack.length; si++) {
      const node = stack[si];
      if (node.t === 'quote') {
        if (!matchQuote(st)) break;
        matched = si + 1;
      } else if (node.t === 'list') {
        matched = si + 1;
      } else if (node.t === 'item') {
        if (isBlankLine) {
          // Blank lines belong to the item regardless of indent, but
          // still consume the item indent so stContent reflects the
          // post-match content (a line of just the item indent is
          // empty in the item's text, which matters for lastBlankEmpty
          // and the HTML trailing-newline strip).
          stConsumeIndent(st, node.contentIndent);
          matched = si + 1;
          continue;
        }
        // An empty item cannot take content after a blank line.
        if (node.children.length === 0 && lastWasBlank) break;
        const indent = stIndent(st);
        if (indent >= node.contentIndent) {
          stConsumeIndent(st, node.contentIndent);
          expandLeadingTabsState(st);
          matched = si + 1;
        } else break;
      }
    }
    if (matched < stack.length) {
      // Lazy continuation: the line failed to match one or more open
      // containers. If the open leaf is a paragraph and the line is
      // non-blank text that starts no interrupt-capable block, it is a
      // lazy continuation of the paragraph: no container closes.
      const lLeaf = currentLeaf();
      let handled = false;
      if (lLeaf && lLeaf.t === 'para' && !isBlankLine) {
        const parent = lLeaf.parent;
        // In a list item, a lazy line is rejected when the previous line
        // was indented 4+ in item-text coordinates (the item is over).
        const listRejected = parent.t === 'item' && (lLeaf.lastLineIndent || 0) >= 4;
        if (!listRejected) {
          const rest = stContent(st);
          if (/^[ \t]*$/.test(rest)) {
            if (matched > 1) {
              // Blank line inside the matched containers (e.g. `>>`):
              // end the paragraph, mark blank. Containers stay open
              // unless the failing container is a QUOTE: a blank line
              // that fails to match a quote closes it (doc-14).
              const failNode = stack[matched];
              finalizeLeaf(lLeaf);
              lastWasBlank = true;
              lastBlankEmpty = stContent(st) === '';
              blankDepth = stack.length;
              blankInQuote = top().t === 'quote';
              if (!failNode || failNode.t !== 'quote') handled = true;
            }
          } else {
            const fresh = () => ({ line: st.line, pos: st.pos, col: st.col, virt: st.virt });
            const ht = matchHtmlBlock(fresh());
            // Any list marker interrupts a lazy continuation (any bullet
            // or ordered marker, empty or not, any start number): it
            // ends the current item or closes the quote. The "empty
            // cannot interrupt / ordered must start at 1" rules only
            // govern starting a NEW list in phase 2.
            const interrupts = !!matchAtx(fresh()) || !!matchFence(fresh()) || matchHr(fresh()) ||
              matchQuote(fresh()) || (ht >= 1 && ht <= 6) || !!matchListMarker(fresh());
            if (!interrupts) {
              appendLazy(lLeaf, st);
              lastWasBlank = false;
              handled = true;
            }
          }
        }
      }
      if (handled) continue;
      // Fenced code in a list item: an under-indented line that starts
      // no interrupt-capable block is code content (marked's list loop
      // treats it as a lazy continuation). Only when the failing
      // container is a list item (quotes close on mismatch). Rejected
      // when the previous code line was blank or indented 4+ in
      // item-text coordinates.
      if (!handled && lLeaf && lLeaf.t === 'code' && lLeaf.fenced && !isBlankLine) {
        const failNode = stack[matched];
        if (failNode && failNode.t === 'item' && !lLeaf.lastBlank && (lLeaf.lastLineIndent || 0) < 4 && !lLeaf.lastStartsBlock) {
          const fresh = () => ({ line: st.line, pos: st.pos, col: st.col, virt: st.virt });
          const ht = matchHtmlBlock(fresh());
          const interrupts = !!matchAtx(fresh()) || !!matchFence(fresh()) || matchHr(fresh()) ||
            matchQuote(fresh()) || (ht >= 1 && ht <= 6) || !!matchListMarker(fresh());
          if (!interrupts) {
            let content = stContent(st);
            const startsBlock = lineStartsBlock(content);
            if (lLeaf.fenceChar === 96 && lLeaf.fenceIndent > 0) {
              let strip = 0;
              while (strip < lLeaf.fenceIndent && strip < content.length) {
                const cc = content.charCodeAt(strip);
                if (cc === 32 || cc === 9) strip++;
                else break;
              }
              content = content.slice(strip);
            }
            lLeaf.text += content + '\n';
            lLeaf.lastBlank = false;
            lLeaf.lastLineIndent = stIndent(st);
            lLeaf.lastStartsBlock = startsBlock;
            lastWasBlank = false;
            handled = true;
          }
        }
      }
      if (handled) continue;
      // Blank content inside a fenced code block (e.g. `>` in a quote):
      // it is a blank code line, not the end of the block — but only when
      // the failing container is an item. A blank line that fails to
      // match a QUOTE closes the quote (and the code) instead.
      if (lLeaf && lLeaf.t === 'code' && lLeaf.fenced && matched > 1 && /^[ \t]*$/.test(stContent(st))) {
        const failNode = stack[matched];
        if (failNode && failNode.t === 'item') {
          lLeaf.text += '\n';
          lLeaf.lastBlank = true;
          lLeaf.lastLineIndent = 0;
          lLeaf.lastStartsBlock = false;
          lastWasBlank = false;
          continue;
        }
      }
      // A line with blank content after matching some containers (e.g.
      // `>` inside a quote) does not close an ITEM when there is no open
      // leaf: the item stays open for the next content line (doc-12).
      // Leaves still close via finalizeLeaf above; quotes/lists close
      // normally via closeTo.
      if (!currentLeaf() && matched > 1 && /^[ \t]*$/.test(stContent(st))) {
        const failNode = stack[matched];
        if (failNode && failNode.t === 'item') {
          lastWasBlank = true;
          lastBlankEmpty = stContent(st) === '';
          blankDepth = stack.length;
          blankInQuote = top().t === 'quote';
          continue;
        }
      }
      closeTo(matched);
    }
    // A list only continues if the line starts a new item of that list;
    // otherwise the list ends here (a paragraph must never hang off a list).
    // A line with blank content after container matching (e.g. `>`) does
    // not close the list: the list continues on the next item line.
    if (top().t === 'list' && !isBlankLine && !/^[ \t]*$/.test(stContent(st))) {
      const probe = { line: st.line, pos: st.pos, col: st.col, virt: st.virt };
      const m = matchListMarker(probe);
      if (!m || m.ordered !== top().ordered || m.delim !== top().delim) {
        closeTo(stack.length - 1);
      }
    }

    // Phase 2: handle the current leaf and start new blocks.
    const leaf = currentLeaf();
    if (leaf && leaf.t === 'code' && leaf.fenced) {
      // Closing fence? Up to 3 spaces, 3+ of the same char, only spaces after.
      const sPos = st.pos, sCol = st.col, sVirt = st.virt;
      stConsumeIndent(st, 3);
      const c = stChar(st);
      let isClose = false;
      if (c === leaf.fenceChar) {
        let len = 0;
        while (stChar(st) === c) { stAdvance(st); len++; }
        let onlySpaces = true;
        while (stChar(st) !== -1) {
          const ch = stChar(st);
          if (ch !== 32 && ch !== 9) { onlySpaces = false; break; }
          stAdvance(st);
        }
        if (len >= leaf.fenceLen && onlySpaces) isClose = true;
      }
      if (isClose) {
        finalizeLeaf(leaf);
        lastWasBlank = false;
        continue;
      }
      st.pos = sPos; st.col = sCol; st.virt = sVirt;
      // Content line: for backtick fences, strip up to the opening
      // fence's indentation in *characters* (marked strips leading
      // whitespace characters, so a leading tab counts as one
      // character, not four columns). Tilde fences strip nothing.
      let content = stContent(st);
      const startsBlock = lineStartsBlock(content);
      if (leaf.fenceChar === 96 && leaf.fenceIndent > 0) {
        let strip = 0;
        while (strip < leaf.fenceIndent && strip < content.length) {
          const cc = content.charCodeAt(strip);
          if (cc === 32 || cc === 9) strip++;
          else break;
        }
        content = content.slice(strip);
      }
      leaf.text += content + '\n';
      leaf.lastBlank = isBlankLine;
      leaf.lastLineIndent = stIndent(st);
      leaf.lastStartsBlock = startsBlock;
      lastWasBlank = false;
      continue;
    }
    if (leaf && leaf.t === 'html') {
      if (isBlankLine) {
        if (leaf.htmlType === 6 || leaf.htmlType === 7) {
          finalizeLeaf(leaf);
          lastWasBlank = true;
          lastBlankEmpty = stContent(st) === '';
          blankDepth = stack.length;
          continue;
        }
        // Types 1-5 continue across blank lines until their end condition.
        leaf.text += stContent(st) + nl;
        lastWasBlank = false;
        continue;
      }
      const content = stContent(st);
      leaf.text += content + nl;
      if (leaf.htmlType !== 7 && htmlBlockEnds(leaf.htmlType, content)) {
        finalizeLeaf(leaf);
      }
      lastWasBlank = false;
      continue;
    }
    if (leaf && leaf.t === 'code' && !leaf.fenced) {
      // Indented code: blank lines are kept (stripped at close); a line
      // indented 4+ continues it; anything else closes it.
      if (isBlankLine || stIsBlank(st)) {
        stConsumeIndent(st, 4);
        leaf.text += stContent(st) + '\n';
        lastWasBlank = false;
        continue;
      }
      const indent = stIndent(st);
      if (indent >= 4) {
        stConsumeIndent(st, 4);
        leaf.text += stContent(st) + '\n';
        lastWasBlank = false;
        continue;
      }
      finalizeLeaf(leaf);
      // Fall through to start new blocks with this line.
    }
    if (leaf && leaf.t === 'table') {
      // A table ends on an empty or spaces-only line, but a line
      // containing a tab is a (blank) row: marked's table body regex
      // excludes only ` *\n` lines, and tableRowBlankLine strips just
      // the trailing newline.
      if (isBlankLine && !/\t/.test(rawLine)) {
        finalizeLeaf(leaf);
        lastWasBlank = true;
        lastBlankEmpty = stContent(st) === '';
        blankDepth = stack.length;
        continue;
      }
      // A table row line. If it starts a block that interrupts (heading,
      // fence, quote, list, hr, html 1-6), the table closes first.
      const fresh = () => ({ line: st.line, pos: st.pos, col: st.col, virt: st.virt });
      const ht = matchHtmlBlock(fresh());
      const interrupts = !!matchAtx(fresh()) || !!matchFence(fresh()) || matchHr(fresh()) || matchQuote(fresh()) || !!matchListMarker(fresh()) || (ht >= 1 && ht <= 6);
      if (interrupts) {
        finalizeLeaf(leaf);
      } else {
        leaf.rows.push(splitTableRow(stContent(st)));
        lastWasBlank = false;
        continue;
      }
    }
    if (isBlankLine || stContent(st) === '') {
      if (leaf && leaf.t === 'para') finalizeLeaf(leaf);
      lastWasBlank = true;
      lastBlankEmpty = stContent(st) === '';
      blankDepth = stack.length;
      blankInQuote = top().t === 'quote';
      continue;
    }
    {
      // Whitespace-only content after container matching (e.g. `>  `).
      // If the open paragraph is directly in a quote and this is the
      // last line of the quote's chunk (the next line does not match
      // the quote), the whitespace is appended to the paragraph;
      // otherwise it is a blank line.
      const c0 = stContent(st);
      if (/^[ \t]+$/.test(c0)) {
        const para = (leaf && leaf.t === 'para') ? leaf : null;
        let appended = false;
        if (para && para.parent.t === 'quote') {
          const qNode = para.parent;
          const qIdx = stack.indexOf(qNode);
          const nextLine = lines[ln + 1];
          let nextMatches = false;
          if (nextLine !== undefined && !/^[ \t]*$/.test(nextLine)) {
            const st2 = { line: nextLine, pos: 0, col: 0, virt: 0 };
            let ok = true;
            for (let si = 1; si <= qIdx; si++) {
              const node = stack[si];
              if (node.t === 'quote') {
                if (!matchQuote(st2)) { ok = false; break; }
              } else if (node.t === 'item') {
                const ind = stIndent(st2);
                if (ind >= node.contentIndent) stConsumeIndent(st2, node.contentIndent);
                else { ok = false; break; }
              }
            }
            nextMatches = ok;
          }
          if (!nextMatches) {
            para.text += '\n' + c0;
            finalizeLeaf(para);
            lastWasBlank = false;
            appended = true;
          }
        }
        if (!appended) {
          if (para) finalizeLeaf(para);
          lastWasBlank = true;
          lastBlankEmpty = stContent(st) === '';
          blankDepth = stack.length;
          blankInQuote = top().t === 'quote';
        }
        continue;
      }
    }
    // Phase 2: start new blocks. This loops because opening a container
    // (blockquote, list item) exposes more content on the same line that
    // may itself start another block (e.g. '> # foo', '- > foo').
    while (true) {
      const cur = currentLeaf();
      const paraOpen = cur && cur.t === 'para';
      // Blockquote.
      {
        const probe = { line: st.line, pos: st.pos, col: st.col, virt: st.virt };
        if (matchQuote(probe)) {
          if (paraOpen) finalizeLeaf(cur);
          closeListIfTop();
          const q = addBlock({ t: 'quote', children: [] });
          stack.push(q);
          st.pos = probe.pos; st.col = probe.col; st.virt = probe.virt;
          continue;
        }
      }
      // ATX heading.
      {
        const probe = { line: st.line, pos: st.pos, col: st.col, virt: st.virt };
        const atx = matchAtx(probe);
        if (atx) {
          if (paraOpen) finalizeLeaf(cur);
          closeListIfTop();
          addBlock({ t: 'head', level: atx.level, text: atx.text, closed: true });
          lastWasBlank = false;
          break;
        }
      }
      // Fenced code.
      {
        const probe = { line: st.line, pos: st.pos, col: st.col, virt: st.virt };
        const fence = matchFence(probe);
        if (fence) {
          if (paraOpen) finalizeLeaf(cur);
          closeListIfTop();
          let lang = null;
          if (fence.info !== '') {
            // The language is the first word, with backslash escapes resolved.
            const word = fence.info.split(/[ \t]+/)[0];
            let un = '';
            for (let k = 0; k < word.length; k++) {
              const c = word.charCodeAt(k);
              if (c === 92 && k + 1 < word.length && isAsciiPunct(word.charCodeAt(k + 1))) { un += word[k + 1]; k++; }
              else un += word[k];
            }
            lang = un;
          }
          const fenceIndent = Math.min(3, stIndent(st));
          addBlock({ t: 'code', text: '', lang, fenced: true, fenceChar: fence.char, fenceLen: fence.len, fenceIndent, lastStartsBlock: true });
          lastWasBlank = false;
          break;
        }
      }
      // HTML block (types 1-6 can interrupt a paragraph; type 7 cannot).
      {
        const probe = { line: st.line, pos: st.pos, col: st.col, virt: st.virt };
        const htype = matchHtmlBlock(probe);
        if (htype >= 1 && htype <= 6) {
          if (paraOpen) finalizeLeaf(cur);
          closeListIfTop();
          const content = stContent(st);
          const node = addBlock({ t: 'html', text: content + nl, htmlType: htype });
          if (htmlBlockEnds(htype, content)) finalizeLeaf(node);
          lastWasBlank = false;
          break;
        }
        if (htype === 7 && !paraOpen) {
          closeListIfTop();
          addBlock({ t: 'html', text: stContent(st) + nl, htmlType: 7 });
          lastWasBlank = false;
          break;
        }
      }
      // Setext heading (only when a paragraph is open).
      if (paraOpen) {
        const probe = { line: st.line, pos: st.pos, col: st.col, virt: st.virt };
        const slevel = matchSetext(probe);
        if (slevel > 0) {
          const rest = extractRefDefs(cur.text, refs);
          const paraChildren = cur.parent.children;
          const idx = paraChildren.indexOf(cur);
          cur.closed = true;
          paraChildren.splice(idx, 1);
          if (rest === '') {
            // The paragraph was only definitions: no heading. Re-examine
            // the line (it may be a thematic break, etc.).
            continue;
          }
          const headText = rest.replace(/^[ \t]+/, '').replace(/[ \t]+$/, '');
          addBlock({ t: 'head', level: slevel, text: headText, closed: true });
          lastWasBlank = false;
          break;
        }
      }
      // Thematic break.
      {
        const probe = { line: st.line, pos: st.pos, col: st.col, virt: st.virt };
        if (matchHr(probe)) {
          if (paraOpen) finalizeLeaf(cur);
          closeListIfTop();
          addBlock({ t: 'hr', closed: true });
          lastWasBlank = false;
          break;
        }
      }
      // List item.
      {
        const probe = { line: st.line, pos: st.pos, col: st.col, virt: st.virt };
        const marker = matchListMarker(probe);
        if (marker) {
          // An empty list item cannot interrupt a paragraph; an ordered
          // list can only interrupt when it starts at 1 — except inside
          // a list item, where marked lexes item text with state.top
          // false (single-line text tokens), so ANY ordered marker
          // interrupts the paragraph and starts a nested list.
          const inItemPara = paraOpen && cur.parent && cur.parent.t === 'item';
          const canInterrupt = !paraOpen || (marker.ordered ? (inItemPara || (!marker.empty && marker.start === 1)) : !marker.empty);
          if (canInterrupt) {
            if (paraOpen) finalizeLeaf(cur);
            let list = null;
            const tp = top();
            if (tp.t === 'list' && tp.ordered === marker.ordered && tp.delim === marker.delim) {
              list = tp;
            } else {
              closeListIfTop();
              list = addBlock({ t: 'list', ordered: marker.ordered, start: marker.start, delim: marker.delim, tight: true, children: [] });
              stack.push(list);
            }
            const item = { t: 'item', children: [], contentIndent: marker.contentIndent, task: null };
            item.parent = list;
            if (lastWasBlank && !blankInQuote) item.blankBefore = true;
            list.children.push(item);
            stack.push(item);
            st.pos = probe.pos; st.col = probe.col; st.virt = probe.virt;
            // Task list checkbox: [ ] or [x] at the start of the content.
            const content = stContent(st);
            const taskM = content.match(/^\[([ xX])\][ \t]+/);
            if (taskM) {
              item.task = taskM[1] === ' ' ? 'unchecked' : 'checked';
              const skip = taskM[0].length;
              let adv = 0;
              while (adv < skip) { stAdvance(st); adv++; }
            }
            if (marker.empty && stIsBlank(st)) {
              lastWasBlank = false;
              break;
            }
            continue;
          }
        }
      }
      // Table delimiter row (GFM): the open paragraph must be one line,
      // and the delimiter row must be indented less than 4 spaces.
      if (paraOpen && cur.text.indexOf('\n') < 0 && stIndent(st) < 4) {
        const delim = parseTableDelim(stContent(st));
        if (delim) {
          const rest = extractRefDefs(cur.text, refs);
          if (rest === '') {
            // The paragraph was only definitions: no table. Remove it and
            // re-examine the line.
            const paraChildren = cur.parent.children;
            const idx = paraChildren.indexOf(cur);
            cur.closed = true;
            paraChildren.splice(idx, 1);
            continue;
          }
          // The delimiter row must have as many cells as the header row.
          if (splitTableRow(rest).length !== delim.length) {
            // Not a table: fall through and add the line as paragraph text.
          } else {
            const headerCells = splitTableRow(rest);
            const paraChildren = cur.parent.children;
            const idx = paraChildren.indexOf(cur);
            const wasBlankBefore = cur.blankBefore;
            const wasBlankBeforeEmpty = cur.blankBeforeEmpty;
            cur.closed = true;
            paraChildren.splice(idx, 1);
            const table = addBlock({ t: 'table', align: delim, head: headerCells, rows: [] });
            if (wasBlankBefore) table.blankBefore = true;
            if (wasBlankBeforeEmpty) table.blankBeforeEmpty = true;
            lastWasBlank = false;
            break;
          }
        }
      }
      // Indented code (cannot interrupt a paragraph).
      if (!paraOpen) {
        const indent = stIndent(st);
        if (indent >= 4) {
          closeListIfTop();
          stConsumeIndent(st, 4);
          addBlock({ t: 'code', text: stContent(st) + '\n', lang: null, fenced: false });
          lastWasBlank = false;
          break;
        }
      }
      // Otherwise: paragraph text.
      {
        const content = stContent(st);
        if (paraOpen) {
          appendParaLine(cur, st, content);
        } else if (/^[ \t]*$/.test(content)) {
          // Nothing but whitespace left after opening containers
          // (e.g. a lone `>` line): no paragraph is created.
          lastWasBlank = false;
          break;
        } else {
          const p = addBlock({ t: 'para', text: content });
          p.lastLazy = false;
          p.lastCodePath = false;
          p.lastLineIndent = stIndent(st);
        }
        lastWasBlank = false;
        break;
      }
    }
  }

  closeTo(0);
  return { doc, refs };

  function closeListIfTop() {
    if (top().t === 'list') closeTo(stack.length - 1);
  }
}

// Split a table row line into cells. Leading/trailing pipes are optional;
// escaped pipes (\|) are literal and unescaped.
function splitTableRow(line) {
  let s = line.trim();
  if (s.charCodeAt(0) === 124) s = s.slice(1);
  if (s.length > 0 && s.charCodeAt(s.length - 1) === 124) s = s.slice(0, -1);
  const cells = [];
  let cur = '';
  for (let i = 0; i < s.length; i++) {
    const c = s.charCodeAt(i);
    if (c === 92 && i + 1 < s.length && s.charCodeAt(i + 1) === 124) { cur += '|'; i++; }
    else if (c === 124) { cells.push(cur.trim()); cur = ''; }
    else cur += s[i];
  }
  cells.push(cur.trim());
  return cells;
}

// Parse a table delimiter row. Returns the alignment array ('left', 'right',
// 'center', null) or null. Cells are :-*, -*:, :-*:, or --- (1+ dashes).
function parseTableDelim(line) {
  const cells = splitTableRow(line);
  if (cells.length === 0) return null;
  const align = [];
  for (const cell of cells) {
    const m = cell.match(/^(:?)-+(:?)$/);
    if (!m) return null;
    if (m[1] === ':' && m[2] === ':') align.push('center');
    else if (m[2] === ':') align.push('right');
    else if (m[1] === ':') align.push('left');
    else align.push(null);
  }
  return align;
}

// ---------- renderer ----------

function renderPara(node, refs, tight, prefix) {
  const inner = (prefix || '') + parseInline(node.text, refs, false, false);
  if (tight) return inner;
  return '<p>' + inner + '</p>\n';
}

function renderItem(item, refs, tight) {
  const checkbox = item.task === null ? '' : (item.task === 'checked'
    ? '<input checked="" disabled="" type="checkbox"> '
    : '<input disabled="" type="checkbox"> ');
  let html = '<li>';
  const children = item.children;
  if (children.length === 0) {
    html += checkbox;
  } else if (item.task !== null && children[0].t === 'para') {
    html += renderPara(children[0], refs, tight, checkbox);
    for (let i = 1; i < children.length; i++) html += renderNode(children[i], refs, tight);
  } else {
    if (item.task !== null) html += checkbox;
    for (const c of children) html += renderNode(c, refs, tight);
  }
  html += '</li>\n';
  return html;
}

function renderTable(node, refs) {
  const ncols = node.head.length;
  let html = '<table>\n<thead>\n<tr>\n';
  for (let i = 0; i < ncols; i++) {
    const a = node.align[i];
    html += a ? '<th align="' + a + '">' : '<th>';
    html += parseInline(node.head[i], refs, false, false) + '</th>\n';
  }
  html += '</tr>\n</thead>\n';
  if (node.rows.length === 0) return html + '</table>\n';
  html += '<tbody>';
  for (const row of node.rows) {
    html += '<tr>\n';
    for (let i = 0; i < ncols; i++) {
      const a = node.align[i];
      const cell = i < row.length ? row[i] : '';
      html += a ? '<td align="' + a + '">' : '<td>';
      html += parseInline(cell, refs, false, false) + '</td>\n';
    }
    html += '</tr>\n';
  }
  html += '</tbody></table>\n';
  return html;
}

function renderNode(node, refs, tight) {
  switch (node.t) {
    case 'doc':
      return node.children.map((c) => renderNode(c, refs, false)).join('');
    case 'quote':
      return '<blockquote>\n' + node.children.map((c) => renderNode(c, refs, false)).join('') + '</blockquote>\n';
    case 'list': {
      const tag = node.ordered ? 'ol' : 'ul';
      const start = node.ordered && node.start !== 1 ? ' start="' + node.start + '"' : '';
      let html = '<' + tag + start + '>\n';
      for (const item of node.children) html += renderItem(item, refs, node.tight);
      return html + '</' + tag + '>\n';
    }
    case 'para':
      return renderPara(node, refs, tight, '');
    case 'head':
      return '<h' + node.level + '>' + parseInline(node.text, refs, false, false) + '</h' + node.level + '>\n';
    case 'code': {
      const cls = node.lang === null ? '' : ' class="language-' + escapeAttr(node.lang) + '"';
      return '<pre><code' + cls + '>' + escapePlain(node.text) + '</code></pre>\n';
    }
    case 'html': {
      let text = node.text;
      if (node.htmlType >= 1 && node.htmlType <= 5) {
        // Types 1-5 keep the newline, unless the next block was
        // preceded by a truly EMPTY blank line (marked's ge() strips
        // trailing blank lines only when the HTML regex consumed them,
        // and it consumes empty lines, not tab/space-only lines).
        const sibs = node.parent ? node.parent.children : null;
        if (sibs) {
          const idx = sibs.indexOf(node);
          const next = sibs[idx + 1];
          if (next && next.blankBeforeEmpty && text.endsWith('\n')) text = text.slice(0, -1);
          // Inside a container (quote/list item), a trailing HTML block
          // loses its newline: marked lexes container content without
          // the trailing newline. At top level it is kept.
          else if (!next && node.parent.t !== 'doc' && text.endsWith('\n')) text = text.slice(0, -1);
        }
      } else if (node.htmlType === 6 || node.htmlType === 7) {
        // Types 6-7 lose their trailing newline unless they are the
        // very last block in the document.
        let n = node;
        let isLast = true;
        while (n.parent) {
          const sibs = n.parent.children;
          if (sibs[sibs.length - 1] !== n) { isLast = false; break; }
          n = n.parent;
        }
        if (!isLast && text.endsWith('\n')) text = text.slice(0, -1);
      }
      return text;
    }
    case 'hr':
      return '<hr>\n';
    case 'table':
      return renderTable(node, refs);
    default:
      return '';
  }
}

// ---------- entry point ----------

export function parse(markdown) {
  inLinkState = false;
  const { doc, refs } = parseBlocks(markdown);
  return renderNode(doc, refs, false);
}
