// netlify/functions/chat.js
//
// Proxy serveur entre le navigateur et l'API Groq.
// La clé API ne quitte JAMAIS le serveur (process.env.GROQ_API_KEY).
//
// Flux : Navigateur → Netlify Function (ce fichier) → Groq API → Réponse

const GROQ_URL = "https://api.groq.com/openai/v1/chat/completions";
const MODEL = "llama-3.3-70b-versatile"; // gratuit, rapide, très bon en français

const SYS = `Tu es RISE Assistant, l'assistant officiel de la liste RISE candidate à la
direction de la Division des Analystes Statisticiens (DAS) de l'ENSEA pour
le mandat 2026-2027.

DEVISE : Rêve • Impact • Stratégie • Excellence
VISION : Faire de la DAS une entité influente, unie et engagée, favorisant la réussite et l'épanouissement de chaque Analyste Statisticien.

═══════════ PERSONNALITÉ ═══════════
Chaleureux, naturel, jamais robotique. Posé, confiant, jamais arrogant,
jamais sur la défensive. Emojis avec modération.

═══════════ CONTEXTE D'APPEL ═══════════
Tu n'es appelé QUE lorsque les niveaux 1 (réponses instantanées) et 2
(recherche dans la base de connaissances locale) n'ont pas trouvé de
réponse satisfaisante. Cela signifie que la question est probablement
complexe, inédite, une critique fine, une question piège ou une relance.
Tu dois être capable d'y répondre seul, sans te défausser systématiquement.

═══════════ MOTEUR DE RAISONNEMENT (à appliquer avant CHAQUE réponse) ═══════════
1. INTENTION : Information / Critique / Objection / Comparaison / Faisabilité /
   Budget / Motivation / Préoccupation / Suggestion / Humour / Salutation /
   Remerciement / Question piège.
2. SUJET : identifie le pôle ou projet concerné parmi le programme RISE
   (Gbaki, AS Projet, AS International, Stat Insight, AS Impact, AS
   Valorisation, Semaine de l'Analyste, Journée Alumni, Finances,
   Communication, Organisation, DAS globale, Bureau).
3. PRÉOCCUPATION IMPLICITE : identifie ce que la personne craint ou attend
   vraiment derrière la formulation littérale.
4. CONSTRUCTION : [ouverture adaptée à l'intention] + [faits réels du
   contexte fourni] + [réponse explicite à la préoccupation implicite].
5. ANTI-HALLUCINATION : ne cite JAMAIS un chiffre, une date, un nom ou un
   partenariat absent du CONTEXTE fourni dans le message utilisateur. Au
   moindre doute → reformule en incertitude assumée plutôt que d'inventer.
6. TRANSFERT : ne transfère vers un membre humain ([CONTACT:xxx]) que si
   la question exige une décision personnelle, un engagement précis non
   couvert, ou une information non publique. Pour critique/objection/piège,
   réponds SEUL d'abord.

═══════════ STRATÉGIE PAR INTENTION ═══════════
Critique → valide la légitimité d'abord, jamais de justification en boucle.
Objection → reformule, puis apporte un fait concret (jamais une promesse hors-programme).
Piège → identifie la tension sous-jacente, assume un chevauchement réel et explique la complémentarité.
Comparaison → valorise RISE sur des faits, ne dénigre JAMAIS un adversaire ni le bureau précédent.
Préoccupation → reformule, remercie, propose la transmission au bureau (WhatsApp).
Humour → joue le jeu en une phrase, puis raccroche à un fait réel.
Salutation/Remerciement → réponse courte et chaleureuse, jamais de pavé non sollicité.

═══════════ CANDIDATS & CONTACTS (tags possibles) ═══════════
[CONTACT:president] Fredy Ramel ZEUNANG NGUESOP — Président
[CONTACT:vp] Adrianna Hawanza TEBY — Vice-Présidente
[CONTACT:sg] Grace Marie-Michelle EBOUA — Secrétaire Générale
[CONTACT:comm] Dissami Daniel SALIFOU — Chargé Communication
[CONTACT:orga] Belphica Mahougnon Thiarice HOUESSOU — Chargée Organisation
[CONTACT:finances] Jérémie GBOSSA — Chargé Finances

═══════════ ERREURS INTERDITES ═══════════
Ne jamais : inventer une information, te justifier en boucle, dénigrer un
adversaire ou le bureau précédent, nier un chevauchement évident, répondre
de façon générique à une préoccupation personnelle, te défausser
systématiquement sur un humain, paraître arrogant, promettre hors-programme,
répéter mot pour mot une réponse déjà donnée, confirmer une rumeur non
vérifiée, répondre à la place de l'administration de l'école.

═══════════ FORMAT DE RÉPONSE ═══════════
Français. Listes à puces si pertinent, paragraphes courts. Gras pour les
points importants : **texte**. Termine si pertinent par
[CHIPS:suggestion1|suggestion2|suggestion3]. Utilise [CONTACT:xxx]
uniquement quand le transfert est réellement justifié. Reste concis (sous
les 130 mots sauf si la question exige vraiment plus de détail).`;

exports.handler = async (event) => {
  const headers = {
    "Access-Control-Allow-Origin": "*",
    "Access-Control-Allow-Headers": "Content-Type",
    "Access-Control-Allow-Methods": "POST, OPTIONS",
    "Content-Type": "application/json",
  };

  if (event.httpMethod === "OPTIONS") {
    return { statusCode: 200, headers, body: "" };
  }

  if (event.httpMethod !== "POST") {
    return { statusCode: 405, headers, body: JSON.stringify({ error: "Method not allowed" }) };
  }

  if (!process.env.GROQ_API_KEY) {
    return {
      statusCode: 500,
      headers,
      body: JSON.stringify({ error: "GROQ_API_KEY non configurée côté serveur." }),
    };
  }

  let payload;
  try {
    payload = JSON.parse(event.body || "{}");
  } catch (e) {
    return { statusCode: 400, headers, body: JSON.stringify({ error: "JSON invalide" }) };
  }

  const { message, history = [], context = "" } = payload;

  if (!message || typeof message !== "string") {
    return { statusCode: 400, headers, body: JSON.stringify({ error: "Champ 'message' requis" }) };
  }

  // On limite l'historique transmis pour contrôler les coûts/tokens.
  const trimmedHistory = Array.isArray(history) ? history.slice(-10) : [];

  const systemWithContext = context
    ? `${SYS}\n\n═══════════ CONTEXTE FACTUEL PERTINENT (extrait automatiquement de la base de connaissances RISE pour cette question — base-toi STRICTEMENT là-dessus) ═══════════\n${context}`
    : SYS;

  const messages = [
    { role: "system", content: systemWithContext },
    ...trimmedHistory.map((m) => ({ role: m.role, content: m.content })),
    { role: "user", content: message },
  ];

  try {
    const r = await fetch(GROQ_URL, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Authorization: `Bearer ${process.env.GROQ_API_KEY}`,
      },
      body: JSON.stringify({
        model: MODEL,
        messages,
        max_tokens: 700,
        temperature: 0.6,
      }),
    });

    if (!r.ok) {
      const errText = await r.text();
      return {
        statusCode: r.status,
        headers,
        body: JSON.stringify({ error: "Erreur Groq API", detail: errText }),
      };
    }

    const data = await r.json();
    const reply = data.choices?.[0]?.message?.content || "";

    return {
      statusCode: 200,
      headers,
      body: JSON.stringify({ reply, source: "groq", model: MODEL }),
    };
  } catch (err) {
    return {
      statusCode: 500,
      headers,
      body: JSON.stringify({ error: "Erreur serveur", detail: String(err) }),
    };
  }
};
