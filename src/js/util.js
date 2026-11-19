/* Budget.util: money, date and text helpers shared by all modules. Pure: no DOM, no storage. */
(function () {
  'use strict';

  const Budget = (globalThis.Budget = globalThis.Budget || {});

  const MINUS = '−';
  const WORD_JOINER = '⁠'; // invisible; after a sign, so "−€" never wraps apart
  const MONTHS = ['January', 'February', 'March', 'April', 'May', 'June', 'July', 'August', 'September',
    'October', 'November', 'December'];
  const MONTHS_SHORT = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];
  const WEEKDAYS = ['Sunday', 'Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday', 'Saturday'];
  const DESCRIPTION_MAX = 80;

  // ---- money -------------------------------------------------------------------------------------

  // Cents -> "€1,234.56". Negative amounts get U+2212 before the euro sign ("−€12.50").
  // {sign:true} adds "+" to positive amounts; {whole:true} rounds to whole euros ("€345").
  // A sign is followed by an invisible word joiner (U+2060), so an amount never wraps over two lines.
  // Exact: '−⁠€12.50', '€0.00'.
  function formatEuro(cents, { sign = false, whole = false } = {}) {
    const value = Math.round(Number(cents));
    const n = Number.isFinite(value) ? value : 0;
    const abs = Math.abs(n);
    const euros = whole ? Math.round(abs / 100) : Math.floor(abs / 100);
    const shown = whole ? euros : abs;
    const intPart = String(euros).replace(/\B(?=(\d{3})+(?!\d))/g, ',');
    const body = whole ? intPart : `${intPart}.${String(abs % 100).padStart(2, '0')}`;
    let prefix = '';
    if (n < 0 && shown > 0) prefix = MINUS;
    else if (n > 0 && shown > 0 && sign) prefix = '+';
    return `${prefix}${prefix ? WORD_JOINER : ''}€${body}`;
  }

  // Splits "1.234.567" on sep into groups of three; returns the digits or null when grouping is wrong.
  function joinGroups(text, sep) {
    const groups = text.split(sep);
    const ok = /^\d{1,3}$/.test(groups[0]) && groups.slice(1).every((g) => /^\d{3}$/.test(g));
    return ok ? groups.join('') : null;
  }

  // "12,50" / "12.50" / "1.234,56" / "1,234.56" / "-12,50" / "€ 12" / "12,-" -> cents; anything else -> null.
  // A single separator followed by exactly three digits is a thousands separator ("1.234" = €1,234).
  function parseEuro(input) {
    if (input === null || input === undefined) return null;
    let s = String(input).replace(/[\s\u00a0\u202f\u2007\u2060\u200b]+/g, '').replace(/€|euro?/gi, '');
    let sign = 1;
    if (/^[-−–+]/.test(s)) {
      if (s[0] !== '+') sign = -1;
      s = s.slice(1);
    }
    s = s.replace(/[.,]-{1,2}$/, '');
    if (!/^[\d.,]*\d[\d.,]*$/.test(s)) return null;

    const lastDot = s.lastIndexOf('.');
    const lastComma = s.lastIndexOf(',');
    let intDigits;
    let decimals = '';
    if (lastDot >= 0 && lastComma >= 0) {
      const decimalSep = lastDot > lastComma ? '.' : ',';
      const groupSep = decimalSep === '.' ? ',' : '.';
      const at = s.lastIndexOf(decimalSep);
      if (s.indexOf(decimalSep) !== at) return null;
      decimals = s.slice(at + 1);
      if (!/^\d{1,2}$/.test(decimals)) return null;
      intDigits = joinGroups(s.slice(0, at), groupSep);
    } else if (lastDot >= 0 || lastComma >= 0) {
      const sep = lastDot >= 0 ? '.' : ',';
      const parts = s.split(sep);
      if (parts.length === 2 && /^\d{1,2}$/.test(parts[1])) {
        intDigits = parts[0] === '' ? '0' : parts[0];
        decimals = parts[1];
      } else {
        intDigits = joinGroups(s, sep);
      }
    } else {
      intDigits = s;
    }
    if (intDigits === null || !/^\d+$/.test(intDigits)) return null;
    const cents = Number(intDigits) * 100 + Number(decimals.padEnd(2, '0'));
    if (!Number.isSafeInteger(cents)) return null;
    return sign * cents || 0;
  }

  // ---- dates and months --------------------------------------------------------------------------

  function daysInMonth(year, month) {
    return new Date(Date.UTC(year, month, 0)).getUTCDate();
  }

  function isValidDate(date) {
    if (typeof date !== 'string' || !/^\d{4}-\d{2}-\d{2}$/.test(date)) return false;
    const [y, m, d] = date.split('-').map(Number);
    return m >= 1 && m <= 12 && d >= 1 && d <= daysInMonth(y, m);
  }

  function isValidMonth(month) {
    return typeof month === 'string' && /^\d{4}-(0[1-9]|1[0-2])$/.test(month);
  }

  // '2026-09-29' -> '2026-09'
  function monthOf(date) {
    return String(date ?? '').slice(0, 7);
  }

  // '2026-09' -> 'September 2026' (anything invalid is returned unchanged)
  function monthLabel(month) {
    if (!isValidMonth(month)) return String(month ?? '');
    return `${MONTHS[Number(month.slice(5, 7)) - 1]} ${month.slice(0, 4)}`;
  }

  // '2026-09' -> 'Sep' ('' when invalid)
  function shortMonthName(month) {
    return isValidMonth(month) ? MONTHS_SHORT[Number(month.slice(5, 7)) - 1] : '';
  }

  // '2026-09-29' -> '29 Sep' (anything invalid is returned unchanged)
  function shortDate(date) {
    if (!isValidDate(date)) return String(date ?? '');
    return `${Number(date.slice(8, 10))} ${MONTHS_SHORT[Number(date.slice(5, 7)) - 1]}`;
  }

  // '2026-10-01' -> 'Thursday 1 October 2026'. Computed in UTC, so the day never shifts with the time zone.
  // Anything invalid is returned unchanged.
  function longDate(date) {
    if (!isValidDate(date)) return String(date ?? '');
    const [y, m, d] = date.split('-').map(Number);
    return `${WEEKDAYS[new Date(Date.UTC(y, m - 1, d)).getUTCDay()]} ${d} ${MONTHS[m - 1]} ${y}`;
  }

  function pad2(n) {
    return String(n).padStart(2, '0');
  }

  // Today's date in the PC's own time zone as 'YYYY-MM-DD'. now: for tests.
  function todayIso(now = new Date()) {
    return `${now.getFullYear()}-${pad2(now.getMonth() + 1)}-${pad2(now.getDate())}`;
  }

  // A date typed day-month-year -> 'YYYY-MM-DD', or null. Accepts 1-10-2026, 01-10-2026, 1/10/2026, 1.10.2026
  // (the same separator twice) and 2026-10-01; rejects impossible dates such as 31-9-2026.
  function parseDateNl(input) {
    const s = String(input ?? '').trim();
    let m = /^(\d{4})-(\d{1,2})-(\d{1,2})$/.exec(s);
    let iso = m ? `${m[1]}-${pad2(m[2])}-${pad2(m[3])}` : null;
    if (!iso) {
      m = /^(\d{1,2})([-/.])(\d{1,2})\2(\d{4})$/.exec(s);
      iso = m ? `${m[4]}-${pad2(m[3])}-${pad2(m[1])}` : null;
    }
    return iso && isValidDate(iso) ? iso : null;
  }

  // addMonths('2026-12', 1) -> '2027-01'; n may be negative.
  function addMonths(month, n) {
    if (!isValidMonth(month) || !Number.isInteger(n)) throw new TypeError(`addMonths: invalid input ${month}, ${n}`);
    const total = Number(month.slice(0, 4)) * 12 + Number(month.slice(5, 7)) - 1 + n;
    const year = Math.floor(total / 12);
    return `${String(year).padStart(4, '0')}-${String(total - year * 12 + 1).padStart(2, '0')}`;
  }

  // ---- ids and hashing ---------------------------------------------------------------------------

  function toHex(bytes) {
    return Array.from(bytes, (b) => b.toString(16).padStart(2, '0')).join('');
  }

  // uid('t') -> 't_<time><random>'
  function uid(prefix = 'id') {
    const bytes = new Uint8Array(6);
    const cryptoApi = globalThis.crypto;
    if (cryptoApi && typeof cryptoApi.getRandomValues === 'function') cryptoApi.getRandomValues(bytes);
    else for (let i = 0; i < bytes.length; i++) bytes[i] = Math.floor(Math.random() * 256);
    return `${prefix}_${Date.now().toString(36)}${toHex(bytes)}`;
  }

  const FNV_OFFSET = 0xcbf29ce484222325n;
  const FNV_PRIME = 0x100000001b3n;
  const MASK_64 = 0xffffffffffffffffn;

  // FNV-1a 64-bit over the UTF-8 bytes of str, as 16 hex digits.
  function fnv1a64(str) {
    let h = FNV_OFFSET;
    for (const byte of new TextEncoder().encode(String(str))) {
      h = ((h ^ BigInt(byte)) * FNV_PRIME) & MASK_64;
    }
    return h.toString(16).padStart(16, '0');
  }

  // Payee identity: 'p_' + FNV-1a 64 of the lowercased, trimmed bank name. At import that is
  // the RAW bank name (before hidden words, holder data or a rename rule are applied); for hand-made payments the
  // typed name.
  function payeeId(name) {
    return `p_${fnv1a64(String(name ?? '').trim().toLowerCase())}`;
  }

  // SHA-256 of the UTF-8 bytes of str as 64 hex digits, synchronously in plain JS (the privacy hashes must work
  // inside store.update). Same result as crypto.subtle.digest('SHA-256').
  const SHA_K = new Uint32Array([
    0x428a2f98, 0x71374491, 0xb5c0fbcf, 0xe9b5dba5, 0x3956c25b, 0x59f111f1, 0x923f82a4, 0xab1c5ed5,
    0xd807aa98, 0x12835b01, 0x243185be, 0x550c7dc3, 0x72be5d74, 0x80deb1fe, 0x9bdc06a7, 0xc19bf174,
    0xe49b69c1, 0xefbe4786, 0x0fc19dc6, 0x240ca1cc, 0x2de92c6f, 0x4a7484aa, 0x5cb0a9dc, 0x76f988da,
    0x983e5152, 0xa831c66d, 0xb00327c8, 0xbf597fc7, 0xc6e00bf3, 0xd5a79147, 0x06ca6351, 0x14292967,
    0x27b70a85, 0x2e1b2138, 0x4d2c6dfc, 0x53380d13, 0x650a7354, 0x766a0abb, 0x81c2c92e, 0x92722c85,
    0xa2bfe8a1, 0xa81a664b, 0xc24b8b70, 0xc76c51a3, 0xd192e819, 0xd6990624, 0xf40e3585, 0x106aa070,
    0x19a4c116, 0x1e376c08, 0x2748774c, 0x34b0bcb5, 0x391c0cb3, 0x4ed8aa4a, 0x5b9cca4f, 0x682e6ff3,
    0x748f82ee, 0x78a5636f, 0x84c87814, 0x8cc70208, 0x90befffa, 0xa4506ceb, 0xbef9a3f7, 0xc67178f2,
  ]);

  function sha256Hex(str) {
    const data = new TextEncoder().encode(String(str));
    const blocks = Math.ceil((data.length + 9) / 64);
    const bytes = new Uint8Array(blocks * 64);
    bytes.set(data);
    bytes[data.length] = 0x80;
    const view = new DataView(bytes.buffer);
    const bits = data.length * 8;
    view.setUint32(bytes.length - 8, Math.floor(bits / 0x100000000));
    view.setUint32(bytes.length - 4, bits >>> 0);
    const h = new Uint32Array([0x6a09e667, 0xbb67ae85, 0x3c6ef372, 0xa54ff53a, 0x510e527f, 0x9b05688c, 0x1f83d9ab, 0x5be0cd19]);
    const w = new Uint32Array(64);
    const rotr = (x, n) => (x >>> n) | (x << (32 - n));
    for (let block = 0; block < blocks; block++) {
      for (let i = 0; i < 16; i++) w[i] = view.getUint32(block * 64 + i * 4);
      for (let i = 16; i < 64; i++) {
        const s0 = rotr(w[i - 15], 7) ^ rotr(w[i - 15], 18) ^ (w[i - 15] >>> 3);
        const s1 = rotr(w[i - 2], 17) ^ rotr(w[i - 2], 19) ^ (w[i - 2] >>> 10);
        w[i] = (w[i - 16] + s0 + w[i - 7] + s1) >>> 0;
      }
      let [a, b, c, d, e, f, g, k] = h;
      for (let i = 0; i < 64; i++) {
        const t1 = (k + (rotr(e, 6) ^ rotr(e, 11) ^ rotr(e, 25)) + ((e & f) ^ (~e & g)) + SHA_K[i] + w[i]) >>> 0;
        const t2 = ((rotr(a, 2) ^ rotr(a, 13) ^ rotr(a, 22)) + ((a & b) ^ (a & c) ^ (b & c))) >>> 0;
        k = g;
        g = f;
        f = e;
        e = (d + t1) >>> 0;
        d = c;
        c = b;
        b = a;
        a = (t1 + t2) >>> 0;
      }
      h[0] += a;
      h[1] += b;
      h[2] += c;
      h[3] += d;
      h[4] += e;
      h[5] += f;
      h[6] += g;
      h[7] += k;
    }
    return Array.from(h, (x) => x.toString(16).padStart(8, '0')).join('');
  }

  // n random bytes as hex (crypto when available), e.g. for settings.privacySalt.
  function randomHex(n = 16) {
    const bytes = new Uint8Array(n);
    const cryptoApi = globalThis.crypto;
    if (cryptoApi && typeof cryptoApi.getRandomValues === 'function') cryptoApi.getRandomValues(bytes);
    else for (let i = 0; i < bytes.length; i++) bytes[i] = Math.floor(Math.random() * 256);
    return toHex(bytes);
  }

  // SHA-256 hex via crypto.subtle; FNV-1a 64 hex when subtle is missing or fails (some file:// contexts).
  async function hash(str) {
    const subtle = globalThis.crypto && globalThis.crypto.subtle;
    if (subtle) {
      try {
        const digest = await subtle.digest('SHA-256', new TextEncoder().encode(String(str)));
        return toHex(new Uint8Array(digest));
      } catch {
        // fall through to FNV-1a
      }
    }
    return fnv1a64(str);
  }

  // ---- bank text ---------------------------------------------------------------------------------

  // Labels found in ING descriptions. Group 1/2: label and its value are removed (group 2 needs a colon
  // because the word is common). Group 3: only the label is removed, the text after it is kept.
  // Group 4: a fixed phrase that is removed.
  const LABEL_RE = new RegExp([
    '\\b(IBAN|BIC|Kenmerk|Machtiging\\s+ID|Incassant\\s+ID|Relatienummer|Pasvolgnr|Valutadatum)\\b\\s*:?',
    '\\b(Naam|Transactie|Term|Datum\\s*\\/\\s*Tijd|Datum|Tijd)\\s*:',
    '\\b(Omschrijving|Mededelingen|Mededeling)\\s*:',
    '\\b(Doorlopende\\s+incasso)\\b',
  ].join('|'), 'gi');
  const IBAN_RE = /\b[A-Z]{2}\d{2}(?: ?[A-Z0-9]{4}){2,7}(?: ?[A-Z0-9]{1,3})?\b/g;
  const EDGE_JUNK_RE = /^[\s,;:|/\-–—.]+|[\s,;:|/\-–—]+$/g;
  // A random reference code: one "word" of 8 or more letters and digits that has a letter and at least 3 digits
  // (e.g. XQZ743QK0RLRHFYX0). Dates, amounts and ordinary words never match.
  const REFERENCE_RE = /(?<![\p{L}\p{N}])[\p{L}\p{N}]{8,}(?![\p{L}\p{N}])/gu;

  function maskReference(word) {
    return /\p{L}/u.test(word) && (word.match(/\p{N}/gu) || []).length >= 3 ? '…' : word;
  }

  // A labelled value runs until the next label or the end of the line.
  function stripLabels(line) {
    let out = '';
    let from = 0;
    let keep = true;
    for (const m of line.matchAll(LABEL_RE)) {
      if (keep) out += line.slice(from, m.index);
      out += ' ';
      keep = !(m[1] || m[2]);
      from = m.index + m[0].length;
    }
    return keep ? out + line.slice(from) : out;
  }

  function truncate(text, max) {
    if (text.length <= max) return text;
    let cut = text.slice(0, max - 1);
    const space = cut.lastIndexOf(' ');
    if (space >= max * 0.6) cut = cut.slice(0, space);
    return `${cut.replace(EDGE_JUNK_RE, '')}…`;
  }

  // Short, privacy-safe description: no IBANs, ids, card/terminal data or value dates; runs of six or more
  // digits and reference codes (see REFERENCE_RE) become "…"; whitespace collapsed; at most 80 characters.
  // {references: false}: leave reference codes alone (used for payee names, see cleanName).
  function cleanDescription(str, { references = true } = {}) {
    let text = String(str ?? '')
      .split(/\r?\n/)
      .map(stripLabels)
      .join(' ')
      .replace(IBAN_RE, ' ')
      .replace(/\d{6,}/g, '…');
    if (references) text = text.replace(REFERENCE_RE, maskReference);
    text = text.replace(/\s+/g, ' ').replace(EDGE_JUNK_RE, '');
    return truncate(text, DESCRIPTION_MAX);
  }

  // A payee name, cleaned like a description but WITHOUT the reference-code mask: shop names such as
  // "SumUp *Bakkerij123" or "KRUIDVAT5678" and names the user typed ("Kerstpakket2026") stay as they are. Runs of
  // six or more digits (account numbers: "Naar Oranje spaarrekening C…") are still masked.
  function cleanName(str) {
    return cleanDescription(str, { references: false });
  }

  // 'NL00 INGB 0000 0000 00' -> 'INGB'; '' when the IBAN has no four-letter bank code.
  function bankCodeFromIban(iban) {
    const m = /^[A-Z]{2}\d{2}([A-Z]{4})[A-Z0-9]{4,26}$/.exec(String(iban ?? '').replace(/\s+/g, '').toUpperCase());
    return m ? m[1] : '';
  }

  Budget.util = {
    formatEuro,
    parseEuro,
    isValidDate,
    isValidMonth,
    monthOf,
    monthLabel,
    shortDate,
    shortMonthName,
    longDate,
    todayIso,
    parseDateNl,
    addMonths,
    uid,
    hash,
    fnv1a64,
    sha256Hex,
    randomHex,
    payeeId,
    cleanDescription,
    cleanName,
    bankCodeFromIban,
  };
})();
