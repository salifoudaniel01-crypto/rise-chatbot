// ════════════════════════════════════════════════════════════════════════
// RISE Assistant — moteur hybride 3 niveaux
// Niveau 1 : réponses instantanées (data/faq.json)
// Niveau 2 : recherche dans la base de connaissances (data/*.json)
// Niveau 3 : IA Groq via Netlify Function (/api/chat) — clé API côté serveur
// ════════════════════════════════════════════════════════════════════════

// ── DONNÉES (chargées au démarrage) ────────────────────────────────────
let FAQ = null, PROGRAMME = null, OBJECTIONS = null, CANDIDATS = null;
let INDEX = []; // index de recherche unifié, construit après chargement
let IDF = {};   // pondération inverse de fréquence des mots-clés

async function loadData() {
  const [faq, programme, objections, candidats] = await Promise.all([
    fetch('data/faq.json').then(r => r.json()),
    fetch('data/programme.json').then(r => r.json()),
    fetch('data/objections.json').then(r => r.json()),
    fetch('data/candidats.json').then(r => r.json()),
  ]);
  FAQ = faq; PROGRAMME = programme; OBJECTIONS = objections; CANDIDATS = candidats;
  buildIndex();
}

function buildIndex() {
  INDEX = [];
  (PROGRAMME.projets || []).forEach(p => INDEX.push({ type: 'projet', ref: p, keywords: p.keywords || [] }));
  (OBJECTIONS.items || []).forEach(o => INDEX.push({ type: 'objection', ref: o, keywords: o.keywords || [] }));
  Object.values(CANDIDATS.membres || {}).forEach(m => INDEX.push({ type: 'membre', ref: m, keywords: m.keywords || [] }));
  (FAQ.questions || []).forEach(f => INDEX.push({ type: 'faqQ', ref: f, keywords: f.keywords || [] }));

  // IDF : les mots-clés rares (ex: "gbaki") pèsent plus que les mots fréquents (ex: "comment")
  const freq = {};
  INDEX.forEach(e => e.keywords.forEach(k => { freq[k] = (freq[k] || 0) + 1; }));
  IDF = {};
  Object.keys(freq).forEach(k => { IDF[k] = Math.log(1 + INDEX.length / freq[k]); });
}

// ── NORMALISATION / TOKENISATION ───────────────────────────────────────
const STOPWORDS = new Set(("le la les un une des de du et en a au aux ce cette ces que qui quoi " +
  "est sont etre avoir pour par sur dans avec sans vous votre vos nous notre nos je tu il elle on " +
  "ne pas plus moins si comme ou mais donc or ni car son sa ses leur leurs y ou quel quelle quels " +
  "quelles cest ca cela ai as avons avez ont etait va vont fait faire dois doit").split(' '));

function normalize(s) {
  return s.toLowerCase()
    .normalize('NFD').replace(/[\u0300-\u036f]/g, '') // retire les accents
    .replace(/[?!.,;:()«»"'’]/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

// ── NIVEAU 1 : RÉPONSES INSTANTANÉES ───────────────────────────────────
function matchInstant(rawQuery) {
  const nq = normalize(rawQuery);
  for (const cat of ['greetings', 'thanks', 'reactions']) {
    const block = FAQ[cat];
    if (!block) continue;
    if (block.patterns.some(p => nq === p || nq.startsWith(p + ' ') || nq.split(' ').includes(p))) {
      const resp = block.responses[Math.floor(Math.random() * block.responses.length)];
      return tagged(resp, block.chips, null);
    }
  }
  // Pattern complet d'une question FAQ connue
  for (const f of (FAQ.questions || [])) {
    if (f.patterns && f.patterns.some(p => nq.includes(p))) {
      return tagged(f.answer, f.chips, f.contact);
    }
  }
  return null;
}

function tagged(text, chips, contact) {
  let out = text;
  if (chips && chips.length) out += ` [CHIPS:${chips.join('|')}]`;
  if (contact) out += ` [CONTACT:${contact}]`;
  return out;
}

// ── INTENTIONS SPÉCIALES (contact, candidats, programme) ──────────────
function tryContactIntent(nq) {
  if (!/contact|contacter|joindre|whatsapp|numero|appeler|ecrire un message/.test(nq)) return null;
  // Cherche un membre nommé explicitement
  for (const m of Object.values(CANDIDATS.membres)) {
    const nameTokens = normalize(m.nom).split(' ').concat(m.role ? normalize(m.role).split(' ') : []);
    if (nameTokens.some(t => t.length > 3 && nq.includes(t))) {
      return tagged(`Vous pouvez contacter **${m.nom}** directement 📲`, [], m.id);
    }
  }
  return tagged(
    `Vous souhaitez contacter un membre du bureau RISE ? 😊\n\nChaque membre est joignable directement sur WhatsApp. Qui cherchez-vous ?`,
    ['Contacter le Président', 'Contacter la VP', 'Contacter la Secrétaire Générale', 'Contacter la Communication'],
    null
  );
}

function tryCandidateOverview(nq) {
  if (/contact/.test(nq)) return null; // déjà géré par tryContactIntent
  const explicit = /(qui sont les candidats|presente (tous les candidats|le bureau|les candidats du bureau|toute l.equipe)|liste des candidats|tout le bureau|membres du bureau|composition du bureau|qui compose (le bureau|la liste))/;
  const isShortGeneric = nq.split(' ').length <= 6 && /\b(candidats?|bureau|equipe|membres)\b/.test(nq);
  if (!explicit.test(nq) && !isShortGeneric) return null;

  const lines = Object.values(CANDIDATS.membres)
    .map(m => `• **${m.nom}** — ${m.role} (${m.promo})`).join('\n');
  return tagged(
    `Merci pour votre question 😊 ! Le bureau **RISE** est composé de 6 candidats :\n\n${lines}\n\nSouhaitez-vous en savoir plus sur l'un d'eux ?`,
    ['Parle-moi du Président', 'Présente la VP', 'Qui est la Secrétaire Générale ?', 'Qui est le Chargé aux Finances ?'],
    null
  );
}

function tryProgrammeOverview(nq) {
  const explicit = /(presente (le |tout le |)programme|vision (globale )?rise|en detail le programme|axes du programme|piliers? du programme)/;
  const isShortGeneric = nq.split(' ').length <= 5 && /\bprogramme\b/.test(nq);
  if (!explicit.test(nq) && !isShortGeneric) return null;

  const poleLines = PROGRAMME.poles.map(p => {
    const m = CANDIDATS.membres[p.porteur];
    return `• 🏛️ **${p.nom}** — ${(p.projets || []).map(pid => {
      const proj = PROGRAMME.projets.find(x => x.id === pid);
      return proj ? proj.nom : pid;
    }).join(', ')}`;
  }).join('\n');
  return tagged(
    `Voici le programme **RISE** en un coup d'œil 🌟\n\n**Devise :** ${PROGRAMME.devise}\n**Vision :** ${PROGRAMME.vision}\n\n**6 pôles d'action :**\n${poleLines}`,
    ['Présente tous les candidats', 'Parle-moi de Gbaki', "Pourquoi voter RISE ?"],
    null
  );
}

function tryMemberBio(nq) {
  let best = null, bestScore = 0;
  for (const m of Object.values(CANDIDATS.membres)) {
    const nameTokens = normalize(m.nom).split(' ').filter(t => t.length > 3);
    const score = nameTokens.filter(t => nq.includes(t)).length;
    if (score > bestScore) { bestScore = score; best = m; }
  }
  if (!best || bestScore === 0) return null;
  const projChips = (best.projets || []).slice(0, 3).map(pid => {
    const proj = PROGRAMME.projets.find(x => x.id === pid);
    return proj ? `Parle-moi de ${proj.nom}` : null;
  }).filter(Boolean);
  return tagged(
    `**${best.nom}** est candidat(e) au poste de **${best.role}** (${best.promo}) 🌟\n\nSa mission : ${best.mission}`,
    projChips.length ? projChips : ['Présente le programme', 'Pourquoi voter RISE ?'],
    best.id
  );
}

// ── NIVEAU 2 : RECHERCHE PONDÉRÉE DANS LA BASE DE CONNAISSANCES ───────
function escapeRegex(s) { return s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'); }

// Cache des regex à frontières de mots, pour éviter les faux positifs
// du type "ete" matchant à l'intérieur de "meteo" (substring naïf).
const _kwRegexCache = {};
function keywordRegex(nkw) {
  if (!_kwRegexCache[nkw]) {
    _kwRegexCache[nkw] = new RegExp('\\b' + escapeRegex(nkw) + '\\b');
  }
  return _kwRegexCache[nkw];
}

function scoreEntry(nq, entry) {
  let score = 0;
  for (const kw of entry.keywords) {
    const nkw = normalize(kw);
    if (nkw.length > 2 && keywordRegex(nkw).test(nq)) {
      score += (IDF[kw] || 1) * (nkw.split(' ').length); // bonus mots-clés composés
    }
  }
  return score;
}

// Seuil plancher absolu : sans lui, une requête totalement hors sujet pourrait
// "gagner" par défaut dès qu'aucun autre résultat ne fait mieux que 0.
const MIN_CONFIDENT_SCORE = 2.6;

function searchKB(rawQuery) {
  const nq = normalize(rawQuery);
  let best = null, bestScore = 0, second = 0;
  for (const entry of INDEX) {
    const s = scoreEntry(nq, entry);
    if (s > bestScore) { second = bestScore; bestScore = s; best = entry; }
    else if (s > second) { second = s; }
  }
  // Confiance : score suffisant en absolu ET nettement au-dessus du 2e résultat
  const CONFIDENT = bestScore >= MIN_CONFIDENT_SCORE && bestScore >= second * 1.05;
  return { best, bestScore, second, confident: CONFIDENT };
}

function renderProjet(p) {
  const details = (p.details || []).map(d => `• ${d}`).join('\n');
  const complement = p.complement ? `\n\n${p.complement}` : '';
  return tagged(`**${p.nom}**\n\n${p.description}\n\n${details}${complement}`, p.chips || [], null);
}

function renderObjection(o) {
  const prefixes = {
    critique: "C'est une remarque pertinente 😊\n\n",
    piege: "Bonne question, on l'a anticipée 😊\n\n",
    opposition: "Je comprends votre point de vue.\n\n",
  };
  const prefix = prefixes[o.category] || '';
  const ans = o.answer.charAt(0).toUpperCase() + o.answer.slice(1);
  return tagged(`${prefix}${ans}`,
    ['Présente le programme', 'Qui sont les candidats ?', 'Pourquoi voter RISE ?'], null);
}

function renderKBEntry(entry) {
  switch (entry.type) {
    case 'projet': return renderProjet(entry.ref);
    case 'objection': return renderObjection(entry.ref);
    case 'membre': return tagged(
      `**${entry.ref.nom}** est candidat(e) au poste de **${entry.ref.role}** (${entry.ref.promo}) 🌟\n\nSa mission : ${entry.ref.mission}`,
      ['Présente le programme', 'Pourquoi voter RISE ?'], entry.ref.id);
    case 'faqQ': return tagged(entry.ref.answer, entry.ref.chips || [], entry.ref.contact);
  }
  return null;
}

// ── PIPELINE LOCAL COMPLET (niveaux 1 + 2) ─────────────────────────────
function answerLocally(rawQuery) {
  const nq = normalize(rawQuery);

  const instant = matchInstant(rawQuery);
  if (instant) return { raw: instant, level: 1 };

  const contact = tryContactIntent(nq);
  if (contact) return { raw: contact, level: 1 };

  const overview = tryCandidateOverview(nq);
  if (overview) return { raw: overview, level: 1 };

  const programme = tryProgrammeOverview(nq);
  if (programme) return { raw: programme, level: 1 };

  const bio = tryMemberBio(nq);
  if (bio) return { raw: bio, level: 2 };

  const { best, confident } = searchKB(rawQuery);
  if (best && confident) {
    const raw = renderKBEntry(best);
    if (raw) return { raw, level: 2 };
  }

  return null; // → niveau 3 (IA)
}

// Construit un petit contexte factuel pour aider l'IA (niveau 3),
// même quand aucune réponse n'est assez confiante pour être utilisée seule.
function buildAIContext(rawQuery) {
  const nq = normalize(rawQuery);
  const scored = INDEX.map(e => ({ e, s: scoreEntry(nq, e) }))
    .filter(x => x.s > 0)
    .sort((a, b) => b.s - a.s)
    .slice(0, 4);
  if (!scored.length) return '';
  return scored.map(({ e }) => {
    if (e.type === 'projet') return `[Projet] ${e.ref.nom} : ${e.ref.description}`;
    if (e.type === 'objection') return `[Q/R] ${e.ref.question} → ${e.ref.answer}`;
    if (e.type === 'membre') return `[Membre] ${e.ref.nom} (${e.ref.role}) : ${e.ref.mission}`;
    if (e.type === 'faqQ') return `[FAQ] ${e.ref.question} → ${e.ref.answer}`;
    return '';
  }).join('\n');
}

// ── NIVEAU 3 : APPEL IA (Netlify Function → Groq) ──────────────────────
async function askAI(message) {
  const context = buildAIContext(message);
  const r = await fetch('/api/chat', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ message, history: hist.slice(-10), context }),
  });
  if (!r.ok) throw new Error('AI request failed: ' + r.status);
  const data = await r.json();
  return data.reply || '';
}

// ── STATE ─────────────────────────────────────────────────────────────
const hist = [];
let busy = false;

// ── ACTIONS UI ────────────────────────────────────────────────────────
function q(txt) { if (!busy) go(txt); }
function preoc() { if (!busy) showPF(); }
function hkey(e) { if (e.key === 'Enter' && !e.shiftKey) { e.preventDefault(); send(); } }
function grow(el) { el.style.height = 'auto'; el.style.height = Math.min(el.scrollHeight, 96) + 'px'; }

function send() {
  const el = document.getElementById('inp');
  const t = el.value.trim();
  if (!t || busy) return;
  el.value = ''; el.style.height = 'auto';
  go(t);
}

async function go(txt) {
  userBub(txt);
  hist.push({ role: 'user', content: txt });
  busy = true; showTyp();

  // NIVEAUX 1 + 2 : local, sans appel API
  const local = answerLocally(txt);
  if (local) {
    hist.push({ role: 'assistant', content: local.raw });
    rmTyp(); render(local.raw);
    busy = false;
    return;
  }

  // NIVEAU 3 : IA (Groq via Netlify Function)
  try {
    const raw = await askAI(txt);
    hist.push({ role: 'assistant', content: raw });
    rmTyp(); render(raw);
  } catch (e) {
    rmTyp();
    render(fallback(txt));
  }
  busy = false;
}

function fallback(q) {
  return `Merci pour votre question 😊 Je n'ai pas d'information précise sur ce sujet dans le programme officiel RISE.\n\nSouhaitez-vous être mis en relation avec un membre du bureau pour en savoir plus ? [CHIPS:Présente le programme RISE|Qui sont les candidats ?|Contacter le bureau] [CONTACT:president]`;
}

// ── RENDER ─────────────────────────────────────────────────────────────
function render(raw) {
  let txt = raw, chips = [], contact = null;

  const cm = txt.match(/\[CHIPS:([^\]]+)\]/);
  if (cm) { chips = cm[1].split('|').map(s => s.trim()).filter(Boolean); txt = txt.replace(cm[0], '').trim(); }

  const co = txt.match(/\[CONTACT:(\w+)\]/g);
  if (co) { contact = co[co.length - 1].match(/\[CONTACT:(\w+)\]/)[1]; txt = txt.replace(/\[CONTACT:\w+\]/g, '').trim(); }

  let h = `<p>${fmt(txt)}</p>`;

  if (contact && CANDIDATS.membres[contact]) {
    const mb = CANDIDATS.membres[contact];
    const wa = `https://wa.me/${mb.tel}?text=Bonjour%20${encodeURIComponent(mb.nom)}%2C%20je%20suis%20%C3%A9tudiant(e)%20%C3%A0%20l%27ENSEA%20et%20j%27ai%20une%20question%20sur%20le%20programme%20RISE.`;
    h += `<div class="ccard">
      <div class="cr">📋 ${mb.role}</div>
      <div class="cn">${mb.nom}</div>
      <div class="cm">${mb.mission}</div>
      <a class="wa-btn" href="${wa}" target="_blank">
        <svg width="15" height="15" viewBox="0 0 24 24" fill="white"><path d="M17.472 14.382c-.297-.149-1.758-.867-2.03-.967-.273-.099-.471-.148-.67.15-.197.297-.767.966-.94 1.164-.173.199-.347.223-.644.075-.297-.15-1.255-.463-2.39-1.475-.883-.788-1.48-1.761-1.653-2.059-.173-.297-.018-.458.13-.606.134-.133.298-.347.446-.52.149-.174.198-.298.298-.497.099-.198.05-.371-.025-.52-.075-.149-.669-1.612-.916-2.207-.242-.579-.487-.5-.669-.51-.173-.008-.371-.01-.57-.01-.198 0-.52.074-.792.372-.272.297-1.04 1.016-1.04 2.479 0 1.462 1.065 2.875 1.213 3.074.149.198 2.096 3.2 5.077 4.487.709.306 1.262.489 1.694.625.712.227 1.36.195 1.871.118.571-.085 1.758-.719 2.006-1.413.248-.694.248-1.289.173-1.413-.074-.124-.272-.198-.57-.347m-5.421 7.403h-.004a9.87 9.87 0 01-5.031-1.378l-.361-.214-3.741.982.998-3.648-.235-.374a9.86 9.86 0 01-1.51-5.26c.001-5.45 4.436-9.884 9.888-9.884 2.64 0 5.122 1.03 6.988 2.898a9.825 9.825 0 012.893 6.994c-.003 5.45-4.437 9.884-9.885 9.884m8.413-18.297A11.815 11.815 0 0012.05 0C5.495 0 .16 5.335.157 11.892c0 2.096.547 4.142 1.588 5.945L.057 24l6.305-1.654a11.882 11.882 0 005.683 1.448h.005c6.554 0 11.89-5.335 11.893-11.893a11.821 11.821 0 00-3.48-8.413z"/></svg>
        Contacter sur WhatsApp
      </a>
    </div>`;
  }

  if (chips.length) {
    h += `<div class="chips">`;
    chips.forEach(c => { h += `<span class="chip" onclick="q('${c.replace(/'/g, "\\'")}')">` + c + `</span>`; });
    h += `</div>`;
  }

  botBub(h);
}

function fmt(t) {
  return t
    .replace(/\*\*(.+?)\*\*/g, '<strong>$1</strong>')
    .replace(/\*(.+?)\*/g, '<em>$1</em>')
    .replace(/\n\n/g, '</p><p style="margin-top:7px">')
    .replace(/\n•/g, '<br>•')
    .replace(/•\s/g, '• ')
    .replace(/\n/g, '<br>');
}

// ── DOM ────────────────────────────────────────────────────────────────
function userBub(t) {
  const a = document.getElementById('msgs');
  const r = document.createElement('div');
  r.className = 'row u';
  r.innerHTML = `<div class="av u2">👤</div><div class="bub u">${esc(t)}</div>`;
  a.appendChild(r); a.scrollTop = a.scrollHeight;
}
function botBub(h) {
  const a = document.getElementById('msgs');
  const r = document.createElement('div');
  r.className = 'row';
  r.innerHTML = `<div class="av b">R</div><div class="bub b">${h}</div>`;
  a.appendChild(r); a.scrollTop = a.scrollHeight;
}
function showTyp() {
  const a = document.getElementById('msgs');
  const r = document.createElement('div');
  r.className = 'typing-row'; r.id = 'typ';
  r.innerHTML = `<div class="av b">R</div><div class="typing-bub"><div class="dot"></div><div class="dot"></div><div class="dot"></div></div>`;
  a.appendChild(r); a.scrollTop = a.scrollHeight;
}
function rmTyp() { const e = document.getElementById('typ'); if (e) e.remove(); }

function showPF() {
  const a = document.getElementById('msgs');
  const r = document.createElement('div');
  r.className = 'row';
  r.innerHTML = `<div class="av b">R</div><div class="bub b">
    <div class="tag">💡 Votre préoccupation</div>
    Merci de prendre le temps de partager votre préoccupation 😊. Décrivez-la ci-dessous — elle sera transmise au membre du bureau le plus concerné.
    <div class="pform">
      <textarea id="pft" placeholder="Ex : Je souhaite que la division soit plus présente sur les réseaux sociaux..."></textarea>
      <button class="psub" onclick="subP()">📤 Transmettre au bureau RISE</button>
    </div>
  </div>`;
  a.appendChild(r); a.scrollTop = a.scrollHeight;
}

function waTeamLink(mb, t) {
  const msg = `Bonjour ${mb.nom} 👋, je suis étudiant(e) à l'ENSEA. Je souhaite partager une préoccupation concernant le programme RISE :\n\n"${t}"`;
  return `https://wa.me/${mb.tel}?text=${encodeURIComponent(msg)}`;
}

function showTeamWA(t) {
  const a = document.getElementById('msgs');
  const r = document.createElement('div');
  r.className = 'row';
  const waIcon = `<svg width="13" height="13" viewBox="0 0 24 24" fill="white"><path d="M17.472 14.382c-.297-.149-1.758-.867-2.03-.967-.273-.099-.471-.148-.67.15-.197.297-.767.966-.94 1.164-.173.199-.347.223-.644.075-.297-.15-1.255-.463-2.39-1.475-.883-.788-1.48-1.761-1.653-2.059-.173-.297-.018-.458.13-.606.134-.133.298-.347.446-.52.149-.174.198-.298.298-.497.099-.198.05-.371-.025-.52-.075-.149-.669-1.612-.916-2.207-.242-.579-.487-.5-.669-.51-.173-.008-.371-.01-.57-.01-.198 0-.52.074-.792.372-.272.297-1.04 1.016-1.04 2.479 0 1.462 1.065 2.875 1.213 3.074.149.198 2.096 3.2 5.077 4.487.709.306 1.262.489 1.694.625.712.227 1.36.195 1.871.118.571-.085 1.758-.719 2.006-1.413.248-.694.248-1.289.173-1.413-.074-.124-.272-.198-.57-.347m-5.421 7.403h-.004a9.87 9.87 0 01-5.031-1.378l-.361-.214-3.741.982.998-3.648-.235-.374a9.86 9.86 0 01-1.51-5.26c.001-5.45 4.436-9.884 9.888-9.884 2.64 0 5.122 1.03 6.988 2.898a9.825 9.825 0 012.893 6.994c-.003 5.45-4.437 9.884-9.885 9.884m8.413-18.297A11.815 11.815 0 0012.05 0C5.495 0 .16 5.335.157 11.892c0 2.096.547 4.142 1.588 5.945L.057 24l6.305-1.654a11.882 11.882 0 005.683 1.448h.005c6.554 0 11.89-5.335 11.893-11.893a11.821 11.821 0 00-3.48-8.413z"/></svg>`;
  let btns = '';
  Object.values(CANDIDATS.membres).forEach(mb => {
    btns += `<a class="pteam-btn" href="${waTeamLink(mb, t)}" target="_blank">${waIcon}${mb.role}</a>`;
  });
  r.innerHTML = `<div class="av b">R</div><div class="bub b">
    <div class="tag">📤 Transmission au bureau</div>
    Votre préoccupation est prête à être envoyée directement sur WhatsApp à chaque membre du bureau RISE — cliquez sur un ou plusieurs boutons ci-dessous (le message est déjà pré-rempli) :
    <div class="pteam">${btns}</div>
  </div>`;
  a.appendChild(r); a.scrollTop = a.scrollHeight;
}

// La transmission d'une préoccupation est gérée 100% localement (pas d'appel IA) :
// accusé de réception standard + boutons WhatsApp pré-remplis pour tout le bureau.
function subP() {
  const t = document.getElementById('pft')?.value?.trim();
  if (!t) return;
  document.getElementById('pft').value = '';
  hist.push({ role: 'user', content: `PRÉOCCUPATION : ${t}` });

  render(`Merci pour votre préoccupation 🙏 Elle a bien été enregistrée et sera transmise directement à l'ensemble du bureau RISE.\n\n**RISE écoute, RISE agit.** Nous nous engageons à la prendre en compte. [CHIPS:Voir le programme|Qui sont les candidats ?]`);
  showTeamWA(t);
}

function esc(t) { return t.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;'); }

// ── INIT ─────────────────────────────────────────────────────────────
loadData().catch(err => {
  console.error('Erreur de chargement des données RISE :', err);
});
