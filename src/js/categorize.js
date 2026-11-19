/* Budget.categorize: picks the category, kind and display name of a bank payment.
   Order: the user's rules (newest first), then the built-in generic rules, else 'onbekend'.
   Also cleans the payee name and description: hidden words and the account holder's name/address removed,
   no IBANs, ids, reference codes or long digit runs.
   Pure: no DOM, no storage. */
(function () {
  'use strict';

  const Budget = (globalThis.Budget = globalThis.Budget || {});
  const { util, store } = Budget;

  const UNKNOWN = 'onbekend';
  const FALLBACK_NAME = 'Payment';
  const LETTER_OR_DIGIT = '[\\p{L}\\p{N}]';
  // Conditions that say WHICH payment a rule is about; a rule with only a sign never matches.
  const IDENTIFYING = new Set(['nameContains', 'descriptionContains', 'typeContains', 'bankCode', 'nameWords', 'typeWords', 'payeeId']);
  const PAYEE_ID_RE = /^p_[0-9a-f]{16}$/;

  function deepFreeze(value) {
    if (value && typeof value === 'object' && !Object.isFrozen(value)) {
      Object.freeze(value);
      for (const key of Object.keys(value)) deepFreeze(value[key]);
    }
    return value;
  }

  function escapeRegExp(text) {
    return text.replace(/[\\^$.*+?()[\]{}|/]/g, '\\$&');
  }

  // A whole word or phrase (any whitespace between its words), case-insensitive, also for letters like é.
  function phrasePattern(phrase) {
    return escapeRegExp(phrase.trim()).replace(/\s+/g, '\\s+');
  }

  function squash(text) {
    return String(text ?? '').replace(/\s+/g, ' ').trim();
  }

  // ---- built-in rules ----------------------------------------------------------------------------

  // Generic brand names and words only, never personal data. nameWords/typeWords match whole words or
  // phrases; a leading '^' means "at the start of the name" (for words that also occur in other names); a
  // trailing '*' means the word may also be glued to the next one, as card terminals write it
  // ("ApotheekDeLinde NLD"); only for unambiguous shop words.
  const GOVERNMENT_PAYERS = ['belastingdienst', 'uwv', 'svb', 'sociale verzekeringsbank'];
  const SUPERMARKETS = ['albert heijn', 'ah to go', 'jumbo', 'lidl', 'aldi', '^plus', '^dirk', '^coop', '^spar',
    'dekamarkt*', 'vomar', 'hoogvliet*', 'ekoplaza*', 'picnic', 'supermarkt*'];
  const DRUGSTORES = ['apotheek*', 'drogist*', 'drogisterij', 'kruidvat*', 'etos'];
  const HEALTH_INSURERS = ['zilveren kruis', 'cz', 'vgz', 'menzis', 'dsw', 'ditzo', 'ohra', 'univé', 'unive', 'fbto',
    'interpolis', 'zorgverzekeraar', 'zorgverzekering'];
  const TELECOM = ['ziggo', 'kpn', 'odido', 't-mobile', 'vodafone', 'tele2', 'simyo', 'lebara', 'youfone', 'ben nederland'];
  const UTILITIES = ['eneco', 'vattenfall', 'essent', 'greenchoice', 'budget energie', 'evides', 'vitens', 'dunea',
    'brabant water', 'oasen'];

  function builtin(id, match, set) {
    return { id: `builtin:${id}`, match, set };
  }

  // Money out gets the category's default kind; money in from the same payee is a refund: eenmalig.
  function costAndRefund(id, words, categoryId) {
    return [
      builtin(id, { nameWords: words, sign: 'out' }, { categoryId }),
      builtin(`${id}-terug`, { nameWords: words, sign: 'in' }, { categoryId, kind: 'eenmalig' }),
    ];
  }

  const BUILTIN_RULES = deepFreeze([
    builtin('spaarrekening', { nameContains: 'spaarrekening' }, { categoryId: 'sparen', kind: 'telt-niet-mee' }),
    builtin('bankkosten', { nameWords: ['kosten ing'] }, { categoryId: 'vast' }),
    builtin('uitkering-toeslag', { nameWords: GOVERNMENT_PAYERS, sign: 'in' }, { categoryId: 'inkomen' }),
    builtin('geldautomaat', { nameWords: ['geldautomaat'] }, { categoryId: 'dagelijks' }),
    builtin('geldautomaat-type', { typeWords: ['geldautomaat'] }, { categoryId: 'dagelijks' }),
    builtin('paypal', { nameWords: ['paypal'] }, { categoryId: 'eenmalig', kind: 'wisselend' }),
    builtin('supermarkt', { nameWords: SUPERMARKETS, sign: 'out' }, { categoryId: 'dagelijks' }),
    builtin('drogist', { nameWords: DRUGSTORES, sign: 'out' }, { categoryId: 'dagelijks' }),
    ...costAndRefund('zorgverzekeraar', HEALTH_INSURERS, 'zorg'),
    ...costAndRefund('telecom', TELECOM, 'vast'),
    ...costAndRefund('energie-water', UTILITIES, 'vast'),
  ]);

  const wordRegExps = new Map(); // words array -> RegExp

  function wordsRegExp(words) {
    let re = wordRegExps.get(words);
    if (!re) {
      const alternatives = words.map((w) => {
        let word = w;
        const start = word.startsWith('^') ? '^' : '';
        if (start) word = word.slice(1);
        const glued = word.endsWith('*');
        if (glued) word = word.slice(0, -1);
        return `${start}${phrasePattern(word)}${glued ? '' : `(?!${LETTER_OR_DIGIT})`}`;
      });
      re = new RegExp(`(?<!${LETTER_OR_DIGIT})(?:${alternatives.join('|')})`, 'iu');
      wordRegExps.set(words, re);
    }
    return re;
  }

  // ---- matching ----------------------------------------------------------------------------------

  function isAbsent(value) {
    if (value === undefined || value === null) return true;
    if (Array.isArray(value)) return value.length === 0;
    return String(value).trim() === '';
  }

  function contains(haystack, needle) {
    return haystack.toLowerCase().includes(String(needle).trim().toLowerCase());
  }

  function conditionMet(key, value, subject) {
    switch (key) {
      case 'nameContains':
        return contains(subject.name, value);
      case 'descriptionContains':
        return contains(subject.description, value);
      case 'typeContains':
        return contains(subject.type, value);
      case 'bankCode':
        return subject.bankCode.toUpperCase() === String(value).trim().toUpperCase();
      case 'sign':
        if (value === 'in') return subject.amount > 0;
        if (value === 'out') return subject.amount < 0;
        return false;
      case 'nameWords':
        return Array.isArray(value) && wordsRegExp(value).test(subject.name);
      case 'typeWords':
        return Array.isArray(value) && wordsRegExp(value).test(subject.type);
      case 'payeeId': // who the payment is with (made from the bank's own name); for rules whose name text is gone
        return (subject.payeeIds || []).includes(String(value).trim().toLowerCase());
      default:
        return false; // a condition this version does not know can't be checked
    }
  }

  // A rule matches when every condition it gives holds (case-insensitive) and at least one of them
  // identifies the payment.
  function matches(match, subject) {
    let identified = false;
    for (const [key, value] of Object.entries(match || {})) {
      if (isAbsent(value)) continue;
      if (!conditionMet(key, value, subject)) return false;
      if (IDENTIFYING.has(key)) identified = true;
    }
    return identified;
  }

  // User rules newest first (createdAt, then position: later in the list = newer), then the built-in ones.
  function orderedRules(state) {
    const user = ((state && state.rules) || [])
      .map((rule, index) => ({ rule, index }))
      .filter(({ rule }) => rule && typeof rule.match === 'object' && rule.set && typeof rule.set === 'object')
      .sort((a, b) => String(b.rule.createdAt || '').localeCompare(String(a.rule.createdAt || '')) || b.index - a.index)
      .map(({ rule }) => rule);
    return [...user, ...BUILTIN_RULES];
  }

  // ---- hidden words ------------------------------------------------------------------------------

  // Removes each word or phrase (whole words, case-insensitive) from text.
  function stripWords(text, words) {
    let out = String(text ?? '');
    for (const word of words || []) {
      if (typeof word !== 'string' || !word.trim()) continue;
      out = out.replace(new RegExp(`(?<!${LETTER_OR_DIGIT})${phrasePattern(word)}(?!${LETTER_OR_DIGIT})`, 'giu'), ' ');
    }
    return out;
  }

  // What is left around removed words: empty brackets, a space before punctuation, doubled punctuation and
  // spaces. Line breaks are kept (descriptions are cleaned line by line later).
  function tidy(text) {
    return text
      .replace(/\(\s*[.,;:]*\s*\)|\[\s*[.,;:]*\s*\]/g, ' ')
      .replace(/[ \t]+([,;:.!?)\]])/g, '$1')
      .replace(/([([])[ \t]+/g, '$1')
      .replace(/([,;:])(?:[ \t]*[,;:])+/g, '$1')
      .replace(/[ \t]{2,}/g, ' ')
      .replace(/^[ \t]+|[ \t]+$/gm, '');
  }

  function stripHidden(text, words) {
    const source = String(text ?? '');
    const out = stripWords(source, words);
    return out === source ? source : tidy(out);
  }

  // ---- the account holder's name and address ----------------------------------------------------
  // A PDF statement names its holder (importPdf.parse(...).privateTexts). That block is split into parts
  // (holderTokens); only salted SHA-256 hashes of the parts are kept (hashTokens -> settings.privateTokenHashes).
  // stripPrivate removes every word or phrase of a text whose salted hash is one of them, so it also works for
  // CSV files (no holder block) and for payments read earlier (recleanState).

  const TITLES = new Set(['hr', 'dhr', 'heer', 'mw', 'mevr', 'mevrouw', 'mej', 'mejuffrouw', 'mr', 'mrs', 'ms',
    'dr', 'drs', 'ing', 'ir', 'prof', 'fam', 'familie']);
  // Surname prefixes (tussenvoegsels): never removed on their own, only as part of the full surname.
  const PREFIXES = new Set(['van', 'de', 'der', 'den', 'het', 't', 'ter', 'ten', 'te', 'vd', 'von', 'la', 'le', 'du',
    'da', 'di', 'del', 'des', 'dos', 'das', 'do']);
  // Single words that are never treated as private, whatever the holder block says.
  const STOP_WORDS = new Set([...TITLES, ...PREFIXES, 'en', 'of', 'bv', 'nv', 'vof', 'cv', 'postbus', 'rekening',
    'betaalrekening', 'afschrift', 'bank', 'ing', 'nederland', 'netherlands', 'straat', 'weg', 'laan', 'plein']);
  // Words that show a payee name is an organisation, not a person.
  const ORGANISATION_WORDS = new Set(['bv', 'nv', 'vof', 'cv', 'stichting', 'vereniging', 'holding', 'groep',
    'gemeente', 'bank', 'belastingdienst', 'verzekeringen', 'verzekering', 'zorg', 'praktijk', 'winkel', 'webshop']);
  const KIND_CODE = { name: '1', place: '2', street: '3' };
  const CODE_KIND = { 1: 'name', 2: 'place', 3: 'street' };
  const MAX_PHRASE_WORDS = 5;
  const WORD_RE = /[\p{L}\p{N}]+(?:['’-][\p{L}\p{N}]+)*/gu;
  const HOUSE_NUMBER_RE = /^\d{1,5}(?:-\d{1,4})?[a-z]{0,2}$/i;
  const POSTCODE_LINE_RE = /^(\d{4})\s?([A-Za-z]{2})(?:\s+(.+))?$/;
  const STREET_LINE_RE = /^(.*?\p{L}.*?)\s+(\d{1,5})(?:\s?[-/]?\s?[A-Za-z0-9]{1,4})?$/u;

  // Comparable form: no accents, lowercase, no apostrophes, single spaces; a postcode without its space.
  function canon(text) {
    const s = String(text ?? '').normalize('NFD').replace(/\p{M}/gu, '').toLowerCase()
      .replace(/['’`]/g, '').replace(/\s+/g, ' ').trim();
    const postcode = /^(\d{4}) ?([a-z]{2})$/.exec(s);
    return postcode ? `${postcode[1]}${postcode[2]}` : s;
  }

  function letterCount(text) {
    return (String(text).match(/\p{L}/gu) || []).length;
  }

  function isPostcode(c) {
    return /^\d{4}[a-z]{2}$/.test(c);
  }

  // A part of the holder block worth removing: postcodes, phrases with 3+ letters, single words with 3+ letters
  // that are not common words.
  function usableToken(c) {
    if (!c) return false;
    const words = c.split(' ');
    if (words.length > MAX_PHRASE_WORDS) return false;
    if (words.length === 1) return isPostcode(c) || (letterCount(c) >= 3 && !STOP_WORDS.has(c) && !/^\d+$/.test(c));
    return letterCount(c) >= 3;
  }

  function nameParts(line, add) {
    // A joint account names both people ("T. Tester en/of M. Proef"), also when the "en/of" ends or starts a line.
    const persons = line.split(/(?:^|\s+)(?:en\/of|e\/o|en|&|of|\+)(?:\s+|$)|\s*[,;/&+]\s*/i);
    for (const person of persons) {
      let words = person.split(/\s+/).map((w) => w.replace(/^[.'’]+|[.,;:]+$/g, '')).filter(Boolean);
      while (words.length && (TITLES.has(canon(words[0])) || (canon(words[0]) === 'de' && TITLES.has(canon(words[1] || ''))))) {
        words = words.slice(1);
      }
      const isInitials = (w) => /^(?:\p{L}\.?){1,3}$/u.test(w) && (w.includes('.') || w.length <= 2);
      const firstPrefix = words.findIndex((w, i) => i > 0 && PREFIXES.has(canon(w)));
      for (const word of words) {
        if (isInitials(word) || PREFIXES.has(canon(word))) continue;
        add('name', word);
        if (word.includes('-')) for (const part of word.split('-')) add('name', part);
      }
      if (firstPrefix > 0) {
        const surname = words.slice(firstPrefix);
        if (surname.some((w) => !PREFIXES.has(canon(w)))) add('name', surname.join(' '));
      }
    }
  }

  // One holder block: name line(s), then the street line, then the postcode + town line (postcodeAt, or -1).
  function blockTokens(list, postcodeAt, add) {
    let streetAt = -1;
    list.forEach((l, i) => {
      if ((postcodeAt < 0 || i < postcodeAt) && i > 0 && STREET_LINE_RE.test(l)) streetAt = i;
    });
    if (postcodeAt >= 0) {
      const m = POSTCODE_LINE_RE.exec(list[postcodeAt]);
      add('place', `${m[1]}${m[2]}`);
      if (m[3]) add('place', m[3]);
    }
    if (streetAt >= 0) add('street', STREET_LINE_RE.exec(list[streetAt])[1]);
    const nameEnd = streetAt >= 0 ? streetAt : postcodeAt >= 0 ? postcodeAt : list.length;
    for (const line of list.slice(0, nameEnd)) nameParts(line, add);
  }

  /**
   * The holder block of a statement (lines, e.g. ['T. Tester', 'Teststraat 1', '1234 AB Voorbeeldstad']) -> the
   * parts to remove: [{kind: 'name'|'place'|'street', canon}] — surname (with its prefixes only as the whole
   * surname), other name words (not initials), street name (its house number is removed with it), postcode
   * (with or without space) and town. Nothing here is ever stored as text.
   * Several blocks in one list (e.g. the blocks of two statements put together: a personal and a joint account,
   * or the old and the new address) are read block by block: each block ends at its postcode line. Lines after
   * the last postcode line are not part of any block.
   */
  function holderTokens(lines) {
    const list = (lines || []).map(squash).filter(Boolean);
    const tokens = new Map();
    const add = (kind, text) => {
      const c = canon(text);
      if (usableToken(c)) tokens.set(`${kind}|${c}`, { kind, canon: c });
    };
    let start = 0;
    list.forEach((line, i) => {
      if (!POSTCODE_LINE_RE.test(line)) return;
      blockTokens(list.slice(start, i + 1), i - start, add);
      start = i + 1;
    });
    if (start === 0) blockTokens(list, -1, add); // no postcode at all: one block of names (and maybe a street)
    return [...tokens.values()];
  }

  const digestCache = new Map();

  function digest(salt, c) {
    const key = `${salt}\u0000${c}`;
    let value = digestCache.get(key);
    if (value === undefined) {
      if (digestCache.size > 20000) digestCache.clear();
      value = util.sha256Hex(`budget-nl:${salt}:${c}`).slice(0, 32);
      digestCache.set(key, value);
    }
    return value;
  }

  /** [{kind, canon}] + salt -> the hashes to keep in settings.privateTokenHashes ('1'|'2'|'3' + 32 hex). */
  function hashTokens(tokens, salt) {
    if (!salt) return [];
    return [...new Set((tokens || []).filter((t) => KIND_CODE[t.kind]).map((t) => `${KIND_CODE[t.kind]}${digest(salt, t.canon)}`))];
  }

  // salt + hashes -> test(canon) giving 'name' | 'place' | 'street' | null; null when there is nothing to test.
  function privacyTest(salt, hashes) {
    const list = Array.isArray(hashes) ? hashes : [...(hashes || [])];
    if (!salt || !list.length) return null;
    const known = new Map();
    for (const h of list) if (typeof h === 'string' && CODE_KIND[h[0]]) known.set(h.slice(1), CODE_KIND[h[0]]);
    return (c) => known.get(digest(salt, c)) || null;
  }

  const isInitial = (w) => /^\p{L}$/u.test(w);

  /**
   * Removes the holder's parts from text (whole words, case- and accent-insensitive). test: from privacyTest.
   * After a name part, initials, titles and surname prefixes right next to it go too ("HR T TESTER",
   * "Tester T."); after a street name its house number ("Teststraat 1A"). isName: for a payee name, when a name
   * part was found and only one or two plain words remain (a first name, "Tom Tester"), those go as well.
   */
  function stripPrivate(text, test, isName = false) {
    const source = String(text ?? '');
    if (!source || !test) return source;
    const words = [...source.matchAll(WORD_RE)].map((m) => ({ text: m[0], start: m.index, end: m.index + m[0].length }));
    if (!words.length) return source;
    const gap = (i) => source.slice(words[i].end, words[i + 1].start); // between word i and i + 1
    const canonWords = words.map((w) => canon(w.text));
    const cut = new Array(words.length).fill(false);
    let nameFound = false;
    for (let i = 0; i < words.length; i++) {
      for (let n = Math.min(MAX_PHRASE_WORDS, words.length - i); n >= 1; n--) {
        let plain = true;
        for (let j = i; j < i + n - 1 && plain; j++) plain = /^\s+$/.test(gap(j));
        if (!plain) continue;
        let c = canonWords.slice(i, i + n).join(' '); // = canon() of the phrase
        if (n === 2 && /^\d{4} [a-z]{2}$/.test(c)) c = c.replace(' ', '');
        else if (n > 1 && canonWords.slice(i, i + n).some((w) => /^\d+$/.test(w))) continue; // holder parts have no numbers
        if (n === 1 && !isPostcode(c) && letterCount(c) < 3) continue;
        const kind = test(c);
        if (!kind) continue;
        let last = i + n - 1;
        for (let j = i; j <= last; j++) cut[j] = true;
        if (kind === 'street' && last + 1 < words.length && /^\s+$/.test(gap(last)) && HOUSE_NUMBER_RE.test(words[last + 1].text)) {
          cut[++last] = true;
          if (last + 1 < words.length && /^[\s-]+$/.test(gap(last)) && isInitial(words[last + 1].text)) cut[++last] = true;
        }
        if (kind === 'name') {
          nameFound = true;
          // Left of it, in the order a Dutch name is written: title(s), initials, surname prefixes, name. So in
          // "Gift van M. Proef" the "van" (from) before the initial stays.
          let j = i - 1;
          const next = (test) => j >= 0 && /^[\s.]+$/.test(gap(j)) && test(canon(words[j].text), j);
          while (next((c, k) => PREFIXES.has(c) && !isInitial(words[k].text))) cut[j--] = true; // a lone "t" is an initial
          while (next((c, k) => isInitial(words[k].text))) cut[j--] = true;
          while (next((c, k) => TITLES.has(c) || (c === 'de' && TITLES.has(canon(words[k + 1].text))))) cut[j--] = true;
          while (last + 1 < words.length && /^[\s.,]+$/.test(gap(last)) && isInitial(words[last + 1].text)) cut[++last] = true;
        }
        i = last;
        break;
      }
    }
    if (isName && nameFound) {
      const rest = words.filter((w, i) => !cut[i]);
      const personLike = rest.length > 0 && rest.length <= 2
        && rest.every((w) => /^\p{L}[\p{L}'’-]*$/u.test(w.text) && !ORGANISATION_WORDS.has(canon(w.text)));
      if (personLike) words.forEach((w, i) => (cut[i] = true));
    }
    if (!cut.some(Boolean)) return source;
    // Each run of removed words (with the dots, commas and spaces between them) becomes one space; an initial
    // takes its dot along.
    const endOf = (i) => words[i].end + (isInitial(words[i].text) && source[words[i].end] === '.' ? 1 : 0);
    let out = '';
    let from = 0;
    for (let i = 0; i < words.length; i++) {
      if (!cut[i]) continue;
      const start = words[i].start;
      let end = endOf(i);
      while (i + 1 < words.length && cut[i + 1] && /^[\s.,]*$/.test(source.slice(end, words[i + 1].start))) end = endOf(++i);
      out += `${source.slice(from, start)} `;
      from = end;
    }
    out += source.slice(from);
    return tidy(out);
  }

  // ---- cleaning ----------------------------------------------------------------------------------

  function context(state, options) {
    const settings = (state && state.settings) || {};
    const privacy = (options && options.privacy) || { salt: settings.privacySalt, hashes: settings.privateTokenHashes };
    return { hiddenWords: settings.hiddenWords || [], test: privacyTest(privacy.salt, privacy.hashes) };
  }

  // Hidden words and holder parts removed. Names keep reference-like words ("SumUp *Bakkerij123", a typed
  // "Kerstpakket2026"): only descriptions get the reference-code mask; both get the 6-digit mask.
  function cleanText(text, ctx, isName) {
    const stripped = stripPrivate(stripHidden(text, ctx.hiddenWords), ctx.test, isName);
    return isName ? util.cleanName(stripped) : util.cleanDescription(stripped);
  }

  function validPayeeId(value) {
    return typeof value === 'string' && PAYEE_ID_RE.test(value) ? value : '';
  }

  // The payee ids a rule's payeeId condition is tested against. An import row: the id of its raw bank name
  // (util.payeeId, as the importer makes it) and, when the importer passes one, the id it will store. A payment:
  // its payeeId (else made from its name, like calc.payeeIdOf).
  function payeeIdsOf(raw, name) {
    const ids = [];
    if (raw.name === undefined && raw.rawName !== undefined) ids.push(util.payeeId(raw.rawName));
    const given = validPayeeId(raw.payeeId);
    if (given && !ids.includes(given)) ids.push(given);
    if (!ids.length) ids.push(util.payeeId(name));
    return ids;
  }

  // ---- rules never keep hidden words or the holder's name/address ----------------------------------

  const PLAIN_MATCH_KEYS = new Set(['nameContains', 'payeeId', 'bankCode', 'sign']); // handled apart / no free text
  const ACTIONS = ['categoryId', 'kind', 'rename'];

  function stripRuleText(text, ctx, isName) {
    return squash(stripPrivate(stripHidden(text, ctx.hiddenWords), ctx.test, isName));
  }

  // Does text hold a hidden word or a holder part? (Only those are removed from rules: no digit or reference
  // masking, so a rule without them keeps exactly its meaning.)
  function loses(text, ctx, isName) {
    return typeof text === 'string' && stripRuleText(text, ctx, isName) !== squash(text);
  }

  function paymentSubject(tx) {
    const id = validPayeeId(tx.payeeId) || util.payeeId(tx.name);
    return {
      name: String(tx.name ?? ''),
      description: String(tx.description ?? ''),
      type: String(tx.type ?? ''),
      bankCode: String(tx.bankCode ?? ''),
      amount: Number(tx.amount) || 0,
      payeeIds: [id],
    };
  }

  // The payees (payeeIds) of the payments a rule's match applies to: by the payments' current names, plus the
  // payee whose bank name is exactly the rule's name text (its payments may since have been renamed).
  function payeesMatching(match, transactions) {
    const ids = [];
    const named = typeof match.nameContains === 'string' && match.nameContains.trim() ? util.payeeId(match.nameContains) : null;
    for (const tx of transactions || []) {
      if (!tx || typeof tx !== 'object') continue;
      const subject = paymentSubject(tx);
      const id = subject.payeeIds[0];
      if (ids.includes(id)) continue;
      if (matches(match, subject) || (id === named && matches(match, { ...subject, name: match.nameContains }))) ids.push(id);
    }
    return ids;
  }

  /**
   * One user rule without hidden words and holder parts -> the rules that replace it: [rule] (nothing to do),
   * [] (it can't be kept exactly: deleted; its payments keep their category) or the cleaned rule(s).
   * - set.rename: the words are removed; a rename that ends up empty goes; a rule left without any action goes.
   * - match.nameContains: the text would match more than before, so the rule becomes a payee rule
   *   (match.payeeId) for each payee it applied to (payeesOf(match) -> ids); none known -> deleted.
   * - any other text condition (descriptionContains, ...): can't be made exact -> deleted.
   */
  function cleanRule(rule, ctx, payeesOf) {
    if (!rule || !rule.match || typeof rule.match !== 'object' || !rule.set || typeof rule.set !== 'object') return [rule];
    const { match, set } = rule;
    for (const [key, value] of Object.entries(match)) {
      if (PLAIN_MATCH_KEYS.has(key)) continue;
      if ((Array.isArray(value) ? value : [value]).some((v) => loses(v, ctx, false))) return [];
    }
    const nextSet = { ...set };
    if (loses(set.rename, ctx, true)) {
      const rename = stripRuleText(set.rename, ctx, true);
      if (rename) nextSet.rename = rename;
      else delete nextSet.rename;
      if (!ACTIONS.some((k) => !isAbsent(nextSet[k]))) return [];
    }
    const setChanged = nextSet.rename !== set.rename;
    if (!loses(match.nameContains, ctx, true)) return setChanged ? [{ ...rule, set: nextSet }] : [rule];
    const { nameContains, ...rest } = match;
    if (validPayeeId(rest.payeeId)) return [{ ...rule, match: rest, set: nextSet }];
    return payeesOf(match).map((payeeId, i) => ({
      ...rule, id: i ? util.uid('r') : rule.id, match: { ...rest, payeeId }, set: { ...nextSet },
    }));
  }

  function cleanRulesWith(draft, ctx) {
    if (!draft || !Array.isArray(draft.rules) || !draft.rules.length) return 0;
    if (!ctx.test && !ctx.hiddenWords.some((w) => typeof w === 'string' && w.trim())) return 0;
    const payeesOf = (match) => payeesMatching(match, draft.transactions);
    let changed = 0;
    const next = [];
    for (const rule of draft.rules) {
      const kept = cleanRule(rule, ctx, payeesOf);
      if (kept.length !== 1 || kept[0] !== rule) changed++;
      next.push(...kept);
    }
    if (changed) draft.rules.splice(0, draft.rules.length, ...next);
    return changed;
  }

  // ---- public ------------------------------------------------------------------------------------

  /**
   * raw: an import row {rawName, rawDescription, amount, type, iban, payeeId?} or a payment {name, description,
   * amount, type, bankCode, payeeId}. Returns {categoryId, kind, name, description}: name and description cleaned
   * (hidden words, the holder's name/address, IBANs, ids and digit runs removed; reference codes only from the
   * description), name after a rename rule. Payee rules (match.payeeId) are tested against payeeIdsOf(raw).
   * Rules are matched on the cleaned name AND on the bank's own (raw) name, so a rule made before a word was
   * hidden keeps working; category and kind rules also on the new name of a rename rule.
   * options.privacy = {salt, hashes}: the holder hashes to use instead of state.settings' (the importer passes
   * the ones of the file being read too).
   */
  function categorize(raw, state, options) {
    const categories = (state && state.categories) || store.DEFAULT_CATEGORIES;
    const ctx = context(state, options);
    const known = new Set(categories.map((c) => c.id));
    const type = String(raw.type ?? '').trim();
    const rawName = squash(raw.name ?? raw.rawName);
    const subject = {
      name: cleanText(rawName, ctx, true) || type || FALLBACK_NAME,
      description: cleanText(raw.description ?? raw.rawDescription, ctx, false),
      type,
      bankCode: raw.bankCode !== undefined ? String(raw.bankCode) : util.bankCodeFromIban(raw.iban),
      amount: Number(raw.amount) || 0,
      payeeIds: payeeIdsOf(raw, rawName),
    };
    const base = rawName && rawName !== subject.name ? [subject, { ...subject, name: rawName }] : [subject];
    const rules = orderedRules(state);

    const renameRule = rules.find((r) => typeof r.set.rename === 'string' && r.set.rename.trim() && base.some((s) => matches(r.match, s)));
    const name = renameRule ? renameRule.set.rename.trim() : subject.name;
    const subjects = name === subject.name ? base : [...base, { ...subject, name }];
    const fits = (rule) => subjects.some((s) => matches(rule.match, s));

    const categoryRule = rules.find((r) => known.has(r.set.categoryId) && fits(r));
    const categoryId = categoryRule ? categoryRule.set.categoryId : UNKNOWN;
    const kindRule = [categoryRule, ...rules].find((r) => r && store.TX_KINDS.includes(r.set.kind)
      && (!r.set.categoryId || r.set.categoryId === categoryId) && fits(r));
    const kind = kindRule ? kindRule.set.kind : store.defaultKind(categoryId, categories);
    return { categoryId, kind, name, description: subject.description };
  }

  /**
   * Removes settings.hiddenWords and the holder parts (settings.privacySalt + privateTokenHashes) from every user
   * rule of a state draft (inside store.update), see cleanRule; the payments are not changed. Returns how many
   * rules changed (converted or deleted).
   */
  function cleanRules(draft) {
    return cleanRulesWith(draft, context(draft));
  }

  /**
   * Re-applies the cleaning to every payment of a state draft (inside store.update): settings.hiddenWords,
   * the holder hashes (settings.privacySalt + privateTokenHashes) and the masking (names: 6+ digit runs;
   * descriptions: also reference codes), on names and descriptions. A name that ends up empty becomes the bank
   * type, else 'Payment' (FALLBACK_NAME). The user rules are cleaned too (cleanRules, first, while the payments still show what
   * the rules matched). Returns how many payments changed. Text that was removed cannot come back (the bank's
   * original text is not kept).
   */
  function recleanState(draft) {
    const ctx = context(draft);
    cleanRulesWith(draft, ctx);
    let changed = 0;
    for (const tx of (draft && draft.transactions) || []) {
      const name = cleanText(tx.name, ctx, true) || String(tx.type ?? '').trim() || FALLBACK_NAME;
      const description = cleanText(tx.description, ctx, false);
      if (name !== tx.name || description !== tx.description) {
        tx.name = name;
        tx.description = description;
        changed++;
      }
    }
    return changed;
  }

  /**
   * A new user rule for payments like tx (by name, bank code if known, and for category/kind also direction).
   * what: 'category' (remember tx.categoryId + tx.kind) or {categoryId?, kind?, rename?}.
   * By name: match.nameContains = the shown name. But when the shown name is not the bank's own name (tx.payeeId
   * is not made from it: hidden words or the holder's name/address were removed, or it was renamed), that text
   * would match too much or nothing, so the rule is about this payee instead: match.payeeId = tx.payeeId.
   * state (optional): the rule is also cleaned of the state's hidden words and holder parts (cleanRule), e.g. a
   * name or rename the user typed; null when nothing would be left of it.
   */
  function ruleFromTx(tx, what, state) {
    const set = {};
    if (what === 'category') {
      set.categoryId = tx.categoryId;
      set.kind = tx.kind;
    } else if (what && typeof what === 'object') {
      for (const key of ACTIONS) if (!isAbsent(what[key])) set[key] = what[key];
    }
    if (!Object.keys(set).length) throw new TypeError("ruleFromTx: what must be 'category' or {categoryId, kind, rename}");
    const name = String(tx.name ?? '').trim();
    const payeeId = validPayeeId(tx.payeeId);
    const match = payeeId && util.payeeId(name) !== payeeId ? { payeeId } : { nameContains: name };
    if (tx.bankCode) match.bankCode = tx.bankCode;
    if (set.categoryId || set.kind) match.sign = tx.amount < 0 ? 'out' : 'in';
    const rule = { id: util.uid('r'), match, set, createdAt: new Date().toISOString() };
    if (!state) return rule;
    const own = payeeId || util.payeeId(name);
    return cleanRule(rule, context(state), () => [own])[0] || null;
  }

  Budget.categorize = {
    BUILTIN_RULES,
    categorize,
    ruleFromTx,
    matches,
    stripWords,
    recleanState,
    cleanRules,
    holderTokens,
    hashTokens,
    privacyTest,
    stripPrivate,
  };
})();
