// Covidence Swipe Screener content script.
// S open · ← No · → Yes · ↑ / ↓ Maybe · P protocol · Esc close.
// Each Covidence review keeps its own protocol (framework, terms, criteria).
(() => {
  const LABELS = {no: /^(no|exclude)$/i, maybe: /^maybe$/i, yes: /^(yes|include)$/i};

  // Same list as Covidence's "Question framework" menu.
  const FRAMEWORKS = {
    PICOS: ['Population', 'Intervention', 'Comparison', 'Outcome', 'Study Design'],
    PECOS: ['Population', 'Exposure', 'Comparison', 'Outcome', 'Study Design'],
    SPIDER: ['Sample', 'Phenomenon of Interest', 'Design', 'Evaluation', 'Research Type'],
    PICo: ['Population', 'Phenomenon of Interest', 'Context'],
    PCC: ['Population', 'Concept', 'Context'],
    SPICE: ['Setting', 'Perspective', 'Intervention', 'Comparison', 'Evaluation'],
    Other: ['Criteria']
  };
  const COLOURS = ['#f9c74f', '#90e0ef', '#b8f2a0', '#cdb4db', '#ffd6a5'];
  const KEYWORD_COLOUR = '#f4a6c6';
  const STOP = new Set(('a an the of in on for to with and or by at from as is are be not no any all other '
    + 'study studies include included includes inclusion exclude excluded excludes exclusion criteria '
    + 'e.g eg i.e ie etc such that which who whose their there this these those were was using use used '
    + 'including includes any explicitly relevant only must should may will within without between among both either').split(' '));

  // Whole protocol text → framework fields, general include / exclude, search terms.
  // Ignores background, methods etc. Only reads eligibility lines and Boolean search lines.
  function parseProtocol(raw, framework) {
    const fields = FRAMEWORKS[framework];
    const out = {general: {include: '', exclude: ''}, search: ''};
    fields.forEach(f => { out[f] = {include: '', exclude: ''}; });
    const fieldRe = f => new RegExp('^[^a-z]*' + f.split(' ').join('[^a-z]+') + '(?![a-z])[^a-z(]*', 'i');
    const HEADING = /^(\d+(\.\d+)*\.?\s+\S|#+\s)/;
    let target = null, mode = 'include';
    raw.split(/\r?\n/).forEach(line => {
      let rest = line.trim();
      if (!rest) return;
      if (/\b(AND|OR)\b/.test(rest) && /\(.*\bOR\b.*\)/.test(rest)) {
        out.search += rest + '\n';
        return;
      }
      if (HEADING.test(rest)) {
        target = /eligib|inclusion|criteria|pcc|pico|spider|spice/i.test(rest) ? out.general : null;
        mode = 'include';
        return;
      }
      const hit = fields.find(f => fieldRe(f).test(rest));
      if (hit) {
        target = out[hit];
        mode = 'include';
        rest = rest.replace(fieldRe(hit), '');
      }
      const m = rest.match(/^[\W\d]*(include[sd]?|inclusion( criteria)?|exclude[sd]?|exclusion( criteria)?)\s*[:\-–.]?/i);
      if (m) {
        if (!target || (!hit && !rest.slice(m[0].length).trim())) target = out.general;
        mode = /^[\W\d]*inc/i.test(m[0]) ? 'include' : 'exclude';
        rest = rest.slice(m[0].length);
      }
      if (target && rest.trim()) target[mode] += rest.trim() + '\n';
    });
    return out;
  }

  // .docx → plain text (paragraphs on lines, table cells joined with tabs).
  async function docxToText(file) {
    const buf = new Uint8Array(await file.arrayBuffer());
    const dv = new DataView(buf.buffer);
    let eocd = buf.length - 22;
    while (eocd > 0 && dv.getUint32(eocd, true) !== 0x06054b50) eocd--;
    let ptr = dv.getUint32(eocd + 16, true);
    const count = dv.getUint16(eocd + 10, true);
    for (let i = 0; i < count; i++) {
      const method = dv.getUint16(ptr + 10, true), size = dv.getUint32(ptr + 20, true);
      const nameLen = dv.getUint16(ptr + 28, true), extra = dv.getUint16(ptr + 30, true);
      const comment = dv.getUint16(ptr + 32, true), local = dv.getUint32(ptr + 42, true);
      const name = new TextDecoder().decode(buf.slice(ptr + 46, ptr + 46 + nameLen));
      if (name === 'word/document.xml') {
        const start = local + 30 + dv.getUint16(local + 26, true) + dv.getUint16(local + 28, true);
        let data = buf.slice(start, start + size);
        if (method === 8) {
          data = new Uint8Array(await new Response(
            new Blob([data]).stream().pipeThrough(new DecompressionStream('deflate-raw'))).arrayBuffer());
        }
        const xml = new DOMParser().parseFromString(new TextDecoder().decode(data), 'application/xml');
        const W = 'http://schemas.openxmlformats.org/wordprocessingml/2006/main';
        const pText = p => [...p.getElementsByTagNameNS(W, '*')]
          .map(n => (n.localName === 't' ? n.textContent : n.localName === 'tab' ? '\t' : '')).join('');
        const body = xml.getElementsByTagNameNS(W, 'body')[0];
        const lines = [];
        [...body.children].forEach(el => {
          if (el.localName === 'p') lines.push(pText(el));
          if (el.localName === 'tbl') {
            [...el.getElementsByTagNameNS(W, 'tr')].forEach(tr => lines.push(
              [...tr.getElementsByTagNameNS(W, 'tc')].map(tc =>
                [...tc.getElementsByTagNameNS(W, 'p')].map(pText).join(' ')).join('\t')));
          }
        });
        return lines.join('\n');
      }
      ptr += 46 + nameLen + extra + comment;
    }
    throw new Error('word/document.xml not found');
  }

  // Long protocol phrase → short terms that actually appear in abstracts.
  // "clinical teams who receive" → "clinical team*"; "Clinicians" → "clinician*".
  const FILLER = new Set(('who whom receive interpret act mapped domains explicitly discuss shape '
    + 'various different related relevant particular general specific based').split(' '));
  function shortenTerms(list) {
    const seen = new Set();
    return list.split(',').map(t => t.trim()).filter(Boolean).map(t => {
      const words = t.split(/ +/).filter(w => !STOP.has(w.toLowerCase()) && !FILLER.has(w.toLowerCase()));
      return words.slice(0, 2).map((w, i, a) =>
        (i === a.length - 1 && /[a-z]{4,}s$/i.test(w) && !/ss$/i.test(w)) ? w.slice(0, -1) + '*' : w).join(' ');
    }).filter(t => t.replace('*', '').length >= 3)
      .filter(t => !seen.has(t.toLowerCase()) && seen.add(t.toLowerCase()))
      .join(', ');
  }

  // Free text → short keyword phrases worth highlighting.
  function extractTerms(text) {
    const seen = new Set();
    return (text || '')
      .split(/[,;\n•·\/()]|\s+(?:or|and|vs\.?|versus)\s+/i)
      .map(t => t.replace(/^[\s\-*\d.)]+|[\s.:]+$/g, '').trim())
      .map(t => t.split(/\s+/).filter((w, i, a) =>
        !(STOP.has(w.toLowerCase()) && (i === 0 || i === a.length - 1))).join(' '))
      .filter(t => t.length >= 3 && t.split(' ').length <= 4 && !STOP.has(t.toLowerCase()))
      .filter(t => !seen.has(t.toLowerCase()) && seen.add(t.toLowerCase()))
      .join(', ');
  }
  const EXCLUDE_COLOUR = '#ff6b6b';

  const reviewId = () => (location.pathname.match(/reviews\/(\d+)/) || [])[1] || 'default';
  const storageKey = () => `review_${reviewId()}`;
  let protocol = null;

  // Notes: one per paper, kept in this browser, keyed by review + title.
  const notesKey = () => `notes_${reviewId()}`;
  let notes = {};
  const noteId = title => title.toLowerCase().replace(/[^a-z0-9]+/g, ' ').trim().slice(0, 160);
  function loadNotes(cb) {
    chrome.storage.local.get(notesKey(), s => { notes = s[notesKey()] || {}; cb(); });
  }
  let unexported = 0;  // notes written since the last export
  // Covidence ID (#21) is what you search for in Covidence; DOI finds the paper anywhere.
  function paperInfo(box, title) {
    const text = box.innerText;
    return {
      title,
      covidenceId: (text.match(/#\s?(\d+)/) || [])[1] || '',
      doi: ((text.match(/\b10\.\d{4,9}\/[^\s"<>]+/) || [])[0] || '').replace(/[.,;)]+$/, ''),
      firstAuthorYear: (text.match(/#\s?\d+\s*-\s*([^\n·]+?\d{4})/) || [])[1] || ''
    };
  }
  function saveNote(info, text, vote) {
    if (!info?.title) return;
    const id = noteId(info.title);
    const clean = text.trim();
    if (!clean && !notes[id]) return;
    if (clean !== (notes[id]?.note || '')) unexported++;
    notes[id] = {...info, note: clean, vote: vote || notes[id]?.vote || '',
      date: new Date().toISOString().slice(0, 10)};
    chrome.storage.local.set({[notesKey()]: notes});
  }
  function exportNotes() {
    const rows = [['Covidence ID', 'First author and year', 'Title', 'DOI', 'Vote', 'Note', 'Date']].concat(
      Object.values(notes).map(n => [n.covidenceId ? '#' + n.covidenceId : '', n.firstAuthorYear || '',
        n.title, n.doi ? 'https://doi.org/' + n.doi : '', n.vote, n.note, n.date]));
    const csv = rows.map(r => r.map(c => '"' + String(c).replace(/"/g, '""') + '"').join(',')).join(String.fromCharCode(13, 10));
    const a = document.createElement('a');
    a.href = URL.createObjectURL(new Blob([String.fromCharCode(0xfeff) + csv], {type: 'text/csv'}));
    a.download = `covidence-notes-review-${reviewId()}.csv`;
    a.click();
    unexported = 0;
  }

  // Leaving Covidence with notes not yet exported: the browser asks first.
  window.addEventListener('beforeunload', e => {
    if (unexported > 0) { exportNotes(); e.preventDefault(); e.returnValue = ''; }
  });

  function loadProtocol(cb) {
    chrome.storage.local.get(storageKey(), s => {
      protocol = s[storageKey()] || null;
      cb();
    });
  }

  // ---------- find studies on the page ----------
  const btnText = b => (b.innerText || b.value || '').trim();
  function findStudies() {
    const yesButtons = [...document.querySelectorAll('button, a, input[type=button]')]
      .filter(b => LABELS.yes.test(btnText(b)) && b.offsetParent !== null);
    return yesButtons.map(yes => {
      let box = yes.parentElement;
      while (box && !(box.innerText.length > 200
        && [...box.querySelectorAll('button, a')].some(b => LABELS.no.test(btnText(b))))) {
        box = box.parentElement;
      }
      if (!box) return null;
      const pick = re => [...box.querySelectorAll('button, a, input[type=button]')]
        .find(b => re.test(btnText(b)));
      return {box, no: pick(LABELS.no), maybe: pick(LABELS.maybe), yes};
    }).filter(Boolean);
  }

  // Title = first substantial line, abstract = longest paragraph.
  function parseStudy(box) {
    const lines = box.innerText.split('\n').map(l => l.trim())
      .filter(l => l && !/^(no|maybe|yes|include|exclude)$/i.test(l));
    const abstract = lines.reduce((a, b) => (b.length > a.length ? b : a), '');
    const title = lines.find(l => l.length > 20 && l !== abstract) || lines[0] || '';
    const meta = lines.filter(l => l !== title && l !== abstract && l.length < 200).slice(0, 3);
    return {title, abstract, meta};
  }

  // ---------- abstract headings ----------
  const LABELLED = /\b(background|introduction|objectives?|aims?|purpose|methods?|design|setting|participants|results?|findings|discussion|conclusions?|interpretation)\s*:/gi;
  const CUES = {
    // Background talk keeps a sentence in Intro.
    Intro: /\b(previous(ly)?|prior (studies|work)|recent years|has (gained|become|been)|have been|is (expected|increasingly|widely)|to (our|the best of our) knowledge|little is known|remains? (unclear|unknown)|however|gap|no (exclusive |previous )?(study|review)|aims? (of|to)|objective|purpose)\b/i,
    Methods: /\b(this (review|study|paper|scoping review|systematic review)|we (conducted|performed|searched|recruited|analy[sz]ed|used|included|reviewed|examine[ds]?)|(articles|studies|records|papers) (from|were|in)|databases?|pubmed|medline|embase|scopus|web of science|ieee|science ?direct|between (19|20)\d\d and (19|20)\d\d|retrospective|prospective|cohort|randomi[sz]ed|cross-sectional|systematic(ally)? search|participants were|data were|regression|interviews?|questionnaire|n ?= ?\d)/i,
    Results: /(\d+(\.\d+)?\s?%|p ?[<=>] ?0?\.\d|95% ?ci|odds ratio|hazard ratio|\b(or|hr|rr|auc)\b ?[=:]|we found|results (showed|show|indicate)|(was|were) (significantly )?associated|identified \d+|\d+ (studies|articles|patients|participants) (were|met))/i,
    Discussion: /\b(we conclude|in conclusion|conclusions?|our (work|findings|results|review|study) (highlights?|shows?|suggests?|demonstrates?)|these (findings|results)|implications?|future (research|studies|work)|further research|we aim|as such|finally|overall|in summary|this review (provides|offers|serves))\b/i
  };
  const esc = s => String(s).replace(/[&<>"]/g, c => ({'&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;'}[c]));

  function structureAbstract(text) {
    if (!protocol?.headings || !text) return [{heading: '', text}];
    const labelled = [...text.matchAll(LABELLED)];
    if (labelled.length >= 2) {
      return labelled.map((m, i) => ({
        heading: m[1],
        text: text.slice(m.index + m[0].length, labelled[i + 1]?.index ?? text.length).trim()
      }));
    }
    const order = ['Intro', 'Methods', 'Results', 'Discussion'];
    const sentences = text.match(/[^.!?]+[.!?]+(\s|$)|[^.!?]+$/g) || [text];
    const n = sentences.length;
    let stage = 0;
    const parts = [];
    sentences.forEach((s, i) => {
      const pos = i / n;
      // Strongest cue wins, but the section can only move forward.
      let next = stage;
      if (CUES.Discussion.test(s) && pos >= 0.5) next = 3;
      else if (CUES.Results.test(s) && stage >= 1) next = 2;
      else if (CUES.Methods.test(s)
        && !(stage === 0 && CUES.Intro.test(s) && !/\bthis (review|study|paper)\b/i.test(s))) next = 1;
      if (i === n - 1 && stage < 3 && pos >= 0.6 && /\b(suggest|conclude|may|should|need)/i.test(s)) next = 3;
      stage = Math.max(stage, next);
      const name = order[stage];
      if (!parts.length || parts.at(-1).heading !== name) parts.push({heading: name, text: ''});
      parts.at(-1).text += s;
    });
    parts.guessed = true;
    return parts;
  }

  // ---------- keyword highlighting ----------
  function highlightGroups() {
    if (!protocol) return [];
    const fields = FRAMEWORKS[protocol.framework] || [];
    const groups = fields.map((label, i) => ({label, terms: protocol.terms?.[label], colour: COLOURS[i]}));
    groups.push({label: 'Search keywords', terms: protocol.keywords, colour: KEYWORD_COLOUR});
    groups.push({label: 'Exclude', terms: protocol.excludeTerms, colour: EXCLUDE_COLOUR});
    return groups.filter(g => (g.terms || '').trim());
  }

  function termsToRegex(raw) {
    const terms = (raw || '').split(/[,\n;]/).map(t => t.trim().replace(/^"|"$/g, '')).filter(Boolean);
    if (!terms.length) return null;
    const parts = terms.map(t => {
      const trunc = t.endsWith('*');
      const body = t.replace(/\*$/, '').replace(/[.+?^${}()|[\]\\]/g, '\\$&').replace(/\s+/g, '\\s+');
      return `\\b${body}${trunc ? '\\w*' : '\\b'}`;
    });
    return new RegExp(`(${parts.join('|')})`, 'gi');
  }

  function highlight(text) {
    let html = esc(text);
    highlightGroups().forEach(g => {
      const re = termsToRegex(g.terms);
      if (!re) return;
      html = html.split(/(<[^>]+>)/).map(chunk =>
        chunk.startsWith('<') ? chunk
          : chunk.replace(re, `<mark class="cvs-u" style="background:${g.colour}40;text-decoration-color:${g.colour}" title="${esc(g.label)}">$1</mark>`)
      ).join('');
    });
    return html;
  }

  // ---------- keyword-based recommendation ----------
  // Counts which framework fields appear in title + abstract, and any exclude words.
  function recommend(title, abstract) {
    const text = title + ' ' + abstract;
    const hits = re => (re ? (text.match(re) || []).length : 0);
    const fields = FRAMEWORKS[protocol.framework] || [];
    const withTerms = fields.filter(f => (protocol.terms?.[f] || '').trim());
    const matched = withTerms.filter(f => hits(termsToRegex(protocol.terms[f])) > 0);
    const kw = hits(termsToRegex(protocol.keywords));
    const exTitle = (title.match(termsToRegex(protocol.excludeTerms)) || []).length;
    const ex = hits(termsToRegex(protocol.excludeTerms));
    const found = re => [...new Set((text.match(re || /$^/) || []).map(w => w.toLowerCase()))].slice(0, 6).join(', ');
    const detail = withTerms.map(f => `${f}: ${found(termsToRegex(protocol.terms[f])) || '—'}`)
      .concat([`Search keywords: ${found(termsToRegex(protocol.keywords)) || '—'}`,
        `Exclude: ${found(termsToRegex(protocol.excludeTerms)) || '—'}`]);
    const why = [`${matched.length}/${withTerms.length} fields`, `${kw} keywords`, `${ex} exclude`].join(' · ');
    if (exTitle > 0 || (ex >= 2 && matched.length < withTerms.length)) return {d: 'No', why, detail};
    if (withTerms.length && matched.length === withTerms.length && kw >= 1) return {d: 'Yes', why, detail};
    if (matched.length >= 1 || kw >= 2) return {d: 'Maybe', why, detail};
    return {d: 'No', why, detail};
  }

  function showRecommendation(title, abstract) {
    const box = overlay.querySelector('#cvs-rec');
    box.style.display = 'block';
    box.title = 'Click to turn on / off';
    if (protocol.recommend === false) {
      box.innerHTML = '<div class="cvs-small">Recommend: off</div>';
      return;
    }
    const r = recommend(title, abstract);
    const colour = {Yes: '#3fb950', No: '#e5534b', Maybe: '#d4a72c'}[r.d];
    box.style.display = 'block';
    box.innerHTML = `<div class="cvs-small">Recommend decision</div>
      <div style="font-size:26px;font-weight:700;color:${colour}">${r.d}</div>
      <div class="cvs-small">${esc(r.why)}</div>
      <div class="cvs-small">click or R to hide</div>
      <div class="cvs-how">
        Keyword count, not AI.<br>
        ✅ Yes = all parts found<br>
        🤔 Maybe = some found<br>
        ❌ No = exclude word, or nothing found<br><br>
        ${r.detail.map(esc).join('<br>')}
      </div>`;
  }

  // ---------- protocol setup form ----------
  function showSetup() {
    const p = protocol || {framework: 'PCC', raw: '', headings: true};
    card.style.transform = 'none';
    card.style.opacity = 1;
    card.innerHTML = `
      <h2>Screening protocol, review ${esc(reviewId())}</h2>
      <p class="cvs-meta">Saved for this review only.</p>
      <label>1. Question framework</label>
      <select id="cvs-fw">${Object.keys(FRAMEWORKS).map(f =>
        `<option value="${f}" ${f === p.framework ? 'selected' : ''}>${f} (${FRAMEWORKS[f].join(', ')})</option>`).join('')}</select>
      <label>2. Upload your protocol (.docx), or paste the whole protocol below</label>
      <p class="cvs-meta">In Word press Ctrl+A, Ctrl+C, then paste here. It picks out the framework table, Inclusion / Exclusion lists and the Boolean search string, and ignores the rest.</p>
      <input type="file" id="cvs-file" accept=".docx">
      <textarea id="cvs-raw" rows="8">${esc(p.raw || '')}</textarea>
      <p><button id="cvs-extract" style="background:#5b7bd5">Extract keywords →</button></p>
      <div id="cvs-review"></div>
      <p><button id="cvs-export" style="background:#888">Export my notes (CSV)</button></p>`;
    card.querySelector('#cvs-export').onclick = exportNotes;
    const review = card.querySelector('#cvs-review');

    function showReview(terms, keywords, excludeTerms) {
      const fw = card.querySelector('#cvs-fw').value;
      review.innerHTML = `
        <label>3. Check the highlight words (edit freely, comma separated, * = truncation)</label>
        ${FRAMEWORKS[fw].map((f, i) => `
          <label><span class="cvs-dot" style="background:${COLOURS[i]}"></span>${esc(f)}</label>
          <textarea data-field="${esc(f)}" rows="2">${esc(terms[f] || '')}</textarea>`).join('')}
        <label><span class="cvs-dot" style="background:${KEYWORD_COLOUR}"></span>Search keywords</label>
        <textarea id="cvs-keywords" rows="2">${esc(keywords || '')}</textarea>
        <label><span class="cvs-dot" style="background:${EXCLUDE_COLOUR}"></span>Exclude words</label>
        <textarea id="cvs-exclude-terms" rows="2">${esc(excludeTerms || '')}</textarea>
        <label><input type="checkbox" id="cvs-headings" ${p.headings !== false ? 'checked' : ''}>
          Add Intro / Methods / Results / Discussion headings</label>
        <label><input type="checkbox" id="cvs-recommend" ${p.recommend !== false ? 'checked' : ''}>
          Show a recommended decision (from keyword matches)</label>
        <p><button id="cvs-save" style="background:#3fb950">Save and start screening</button></p>`;
      review.querySelector('#cvs-save').onclick = save;
      review.scrollIntoView({behavior: 'smooth'});
    }

    card.querySelector('#cvs-file').onchange = async e => {
      const file = e.target.files[0];
      if (!file) return;
      try {
        card.querySelector('#cvs-raw').value = await docxToText(file);
        card.querySelector('#cvs-extract').click();
      } catch (err) {
        card.querySelector('#cvs-raw').value = 'Could not read this file (' + err.message + '). Please paste instead.';
      }
    };

    card.querySelector('#cvs-extract').onclick = () => {
      const fw = card.querySelector('#cvs-fw').value;
      const parsed = parseProtocol(card.querySelector('#cvs-raw').value, fw);
      const terms = {};
      FRAMEWORKS[fw].forEach(f => { terms[f] = shortenTerms(extractTerms(parsed[f].include)); });
      const exclude = extractTerms(
        [...FRAMEWORKS[fw].map(f => parsed[f].exclude), parsed.general.exclude].join('\n'));
      const search = parsed.search
        .replace(/\b(AND|OR|NOT)\b/g, ',').replace(/\[[^\]]*\]|"|[{}]/g, ' ');
      const keywords = [extractTerms(search), extractTerms(parsed.general.include)]
        .filter(Boolean).join(', ');
      showReview(terms, keywords, exclude);
    };
    if (p.terms) showReview(p.terms, p.keywords, p.excludeTerms);

    function save() {
      const terms = {};
      card.querySelectorAll('[data-field]').forEach(t => { terms[t.dataset.field] = t.value; });
      protocol = {
        framework: card.querySelector('#cvs-fw').value,
        raw: card.querySelector('#cvs-raw').value,
        terms,
        keywords: card.querySelector('#cvs-keywords').value,
        excludeTerms: card.querySelector('#cvs-exclude-terms').value,
        headings: card.querySelector('#cvs-headings').checked,
        recommend: card.querySelector('#cvs-recommend').checked
      };
      chrome.storage.local.set({[storageKey()]: protocol}, render);
    }
    card.scrollTop = 0;
  }

  // ---------- swipe UI ----------
  let overlay, card, current, busy = false;
  const voteHistory = [];  // votes cast in this session, newest last

  function criteriaBox() {
    if (!protocol.raw) return '';
    return `<details class="cvs-criteria"><summary>Criteria (${esc(protocol.framework)}), click to show</summary>
      <div style="white-space:pre-wrap">${esc(protocol.raw)}</div></details>`;
  }

  function legend() {
    overlay.querySelector('#cvs-legend').innerHTML = highlightGroups()
      .map(g => `<span style="background:${g.colour}">${esc(g.label)}</span>`).join('')
      + ' <small>N note · P protocol · Ctrl+Z undo</small>';
  }

  function toast(msg) {
    const t = overlay?.querySelector('#cvs-toast');
    if (!t) return;
    t.textContent = msg;
    t.style.opacity = 1;
    clearTimeout(t.timer);
    t.timer = setTimeout(() => { t.style.opacity = 0; }, 3000);
  }

  // Left bar: screened this session vs still waiting on this page.
  function progress(left) {
    const wrap = overlay.querySelector('#cvs-progress');
    wrap.title = 'Click to turn on / off';
    wrap.classList.toggle('cvs-off', protocol.progress === false);
    const done = voteHistory.length, total = done + left;
    overlay.querySelector('#cvs-done-n').textContent = done + ' done';
    overlay.querySelector('#cvs-left-n').textContent = left;
    overlay.querySelector('#cvs-fill').style.height = (total ? (100 * done / total) : 0) + '%';
  }

  function toggleSetting(key, label) {
    if (!protocol) return;
    protocol[key] = protocol[key] === false;
    chrome.storage.local.set({[storageKey()]: protocol});
    toast(label + (protocol[key] ? ' on' : ' off'));
    render();
  }

  function render() {
    if (!protocol) return showSetup();
    legend();
    const studies = findStudies();
    current = studies[0];
    progress(studies.length);
    card.style.transition = 'none';
    card.style.transform = 'scale(.94)';
    card.style.opacity = 0;
    void card.offsetWidth;  // apply the start state before animating
    card.style.transition = '';
    card.style.transform = 'none';
    card.style.opacity = 1;
    if (!current) {
      overlay.querySelector('#cvs-rec').style.display = 'none';
      card.innerHTML = '<p>No more studies on this page. Press Esc, load the next page, then press S.</p>';
      return;
    }
    const {title, abstract, meta} = parseStudy(current.box);
    const parts = structureAbstract(abstract);
    showRecommendation(title, abstract);
    card.innerHTML = `
      ${criteriaBox()}
      <div class="cvs-meta">${studies.length} left on this page · ${esc(meta.join(' · '))}</div>
      <h2>${highlight(title)}</h2>
      ${parts.map(p => `${p.heading ? `<h3>${esc(p.heading)}</h3>` : ''}<p>${highlight(p.text.trim())}</p>`).join('')}
      ${parts.guessed ? '<div class="cvs-note">Headings are guessed from wording, check before relying on them.</div>' : ''}`;
    const prev = notes[noteId(title)];
    const noteBox = overlay.querySelector('#cvs-notebox');
    noteBox.value = prev?.note || '';
    noteBox.placeholder = prev?.vote ? `Last time: ${prev.vote.toUpperCase()} (${prev.date})` : 'Note: why? (N to type, Enter to finish)';
    noteBox.dataset.info = JSON.stringify(paperInfo(current.box, title));
    card.scrollTop = 0;
  }

  function vote(v) {
    if (v === 'close') return close();
    if (!protocol || !current || busy || !current[v]) return;
    busy = true;
    voteHistory.push({vote: v, title: parseStudy(current.box).title, box: current.box});
    const nb = overlay.querySelector('#cvs-notebox');
    saveNote(JSON.parse(nb.dataset.info || '{}'), nb.value, v);
    nb.blur();
    card.style.transform = {
      no: 'translateX(-120%) rotate(-12deg)',
      yes: 'translateX(120%) rotate(12deg)',
      maybe: 'translateY(60%)'
    }[v];
    card.style.opacity = 0;
    current[v].click();
    toast({no: '✗ No', yes: '✓ Yes', maybe: '? Maybe'}[v] + ' saved');
    setTimeout(() => { busy = false; render(); }, 700);
  }

  // Ctrl+Z: click Covidence's own Undo if it shows one, otherwise say where the vote went.
  function undo() {
    const last = voteHistory.pop();
    if (!last) return toast('Nothing to undo');
    const visible = b => b.offsetParent !== null;
    const undoBtn = [...document.querySelectorAll('button, a')]
      .find(b => /^undo\b/i.test(btnText(b)) && visible(b) && !overlay.contains(b));
    if (undoBtn) {
      undoBtn.click();
      toast(`Undone: ${last.vote.toUpperCase()} on "${last.title.slice(0, 60)}"`);
      setTimeout(render, 900);
      return;
    }
    if (document.body.contains(last.box)) {
      const change = [...last.box.querySelectorAll('button, a')]
        .find(b => /^(undo|change|edit)( vote)?$/i.test(btnText(b)));
      if (change) {
        change.click();
        toast(`Vote reopened for "${last.title.slice(0, 60)}"`);
        setTimeout(render, 900);
        return;
      }
    }
    voteHistory.push(last);
    toast(`No undo button found. "${last.title.slice(0, 50)}" was ${last.vote.toUpperCase()}, change it in Covidence.`);
  }

  function open() {
    if (overlay) return;
    overlay = document.createElement('div');
    overlay.id = 'cvs-overlay';
    overlay.innerHTML = `
      <div id="cvs-card"></div>
      <textarea id="cvs-notebox" rows="1"></textarea>
      <div id="cvs-bar">
        <button data-v="no" style="background:#e5534b">← No</button>
        <button data-v="maybe" style="background:#d4a72c">←+→ Maybe</button>
        <button data-v="yes" style="background:#3fb950">Yes →</button>
      </div>
      <button id="cvs-close" data-v="close" title="Close (Esc)">✕</button>
      <button id="cvs-protocol" data-v="protocol" title="Edit protocol (P)">Protocol</button>
      <div id="cvs-legend"></div>
      <div id="cvs-toast"></div>
      <div id="cvs-rec"></div>
      <div id="cvs-progress">
        <div id="cvs-done-n" title="Screened this session"></div>
        <div id="cvs-track"><div id="cvs-fill"></div></div>
        <div id="cvs-left-n"></div><div class="cvs-small">to go</div>
      </div>`;
    document.body.appendChild(overlay);
    card = overlay.querySelector('#cvs-card');
    overlay.onclick = e => {
      if (e.target.closest('#cvs-rec')) return toggleSetting('recommend', 'Recommendation');
      if (e.target.closest('#cvs-progress')) return toggleSetting('progress', 'Progress');
      const btn = e.target.closest('#cvs-bar button, #cvs-close, #cvs-protocol');
      if (!btn) return;
      if (btn.dataset.v === 'protocol') showSetup();
      else vote(btn.dataset.v);
    };

    // Finger swipe on touchscreens only. Mouse drag stays free for selecting text.
    let x0 = null, y0 = null;
    card.addEventListener('pointerdown', e => {
      if (e.pointerType !== 'touch' || /input|textarea|select|button|summary/i.test(e.target.tagName)) return;
      x0 = e.clientX;
      y0 = e.clientY;
    });
    card.addEventListener('pointermove', e => {
      if (x0 !== null && current) {
        card.style.transform = `translateX(${e.clientX - x0}px) rotate(${(e.clientX - x0) / 25}deg)`;
      }
    });
    card.addEventListener('pointerup', e => {
      if (x0 === null) return;
      const dx = e.clientX - x0, dy = e.clientY - y0;
      x0 = null;
      if (dx < -120) vote('no');
      else if (dx > 120) vote('yes');
      else if (Math.abs(dy) > 120 && Math.abs(dy) > Math.abs(dx)) vote('maybe');
      else card.style.transform = 'none';
    });
    const nb = overlay.querySelector('#cvs-notebox');
    nb.addEventListener('keydown', e => {
      if (e.key === 'Enter' && !e.shiftKey) { e.preventDefault(); nb.blur(); }
      if (e.key === 'Escape') nb.blur();
    });
    nb.addEventListener('blur', () => saveNote(JSON.parse(nb.dataset.info || '{}'), nb.value));
    loadNotes(() => loadProtocol(render));
  }

  function close() {
    if (unexported > 0) {
      exportNotes();
      alert('Your notes were saved to Downloads as a CSV.');
    }
    overlay?.remove();
    overlay = null;
  }

  let pendingArrow = null;

  // Touchpad: two-finger swipe left = No, right = Yes (wheel deltaX).
  let wheelSum = 0, wheelLock = false, wheelReset;
  document.addEventListener('wheel', e => {
    if (!overlay || !current || Math.abs(e.deltaX) <= Math.abs(e.deltaY)) return;
    e.preventDefault();  // also stops Chrome's swipe back / forward
    if (wheelLock) return;
    wheelSum += e.deltaX;
    clearTimeout(wheelReset);
    wheelReset = setTimeout(() => { wheelSum = 0; }, 250);
    if (Math.abs(wheelSum) > 120) {
      vote(wheelSum > 0 ? 'no' : 'yes');
      wheelSum = 0;
      wheelLock = true;
      setTimeout(() => { wheelLock = false; }, 1000);
    }
  }, {passive: false});

  // Touchpad: two-finger tap = right click on Windows = Maybe.
  // Skipped while text is selected, so right-click → Copy still works.
  document.addEventListener('contextmenu', e => {
    if (!overlay || !current || String(window.getSelection()).trim()) return;
    if (/input|textarea|select/i.test(e.target.tagName)) return;
    e.preventDefault();
    vote('maybe');
  });

  document.addEventListener('keydown', e => {
    if (/input|textarea|select/i.test(e.target.tagName) || e.target.isContentEditable) return;
    if (!overlay) {
      if (e.key === 's' || e.key === 'S') open();
      return;
    }
    if ((e.ctrlKey || e.metaKey) && (e.key === 'z' || e.key === 'Z')) {
      e.preventDefault();
      return undo();
    }
    if (e.ctrlKey || e.metaKey || e.altKey) return;
    if (e.key === 'p' || e.key === 'P') return showSetup();
    if (e.key === 'n' || e.key === 'N') {
      e.preventDefault();
      return overlay.querySelector('#cvs-notebox').focus();
    }
    if (e.key === 'r' || e.key === 'R') return toggleSetting('recommend', 'Recommendation');
    if (e.key === 'ArrowLeft' || e.key === 'ArrowRight') {
      // Left + right pressed together (within 200 ms) = Maybe.
      e.preventDefault();
      if (e.repeat) return;
      const side = e.key === 'ArrowLeft' ? 'no' : 'yes';
      if (pendingArrow && pendingArrow.side !== side) {
        clearTimeout(pendingArrow.timer);
        pendingArrow = null;
        return vote('maybe');
      }
      if (pendingArrow) return;
      pendingArrow = {side, timer: setTimeout(() => { pendingArrow = null; vote(side); }, 200)};
      return;
    }
    const v = {ArrowUp: 'maybe', ArrowDown: 'maybe', Escape: 'close'}[e.key];
    if (v) {
      e.preventDefault();
      vote(v);
    }
  });
})();
