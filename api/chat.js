// Vercel Serverless Function — /api/chat
// Every real question is sent to OpenAI with the full FAQ knowledge base as
// context. The model is instructed to answer ONLY from that context, or
// return a specific NOT_FOUND signal if the question isn't covered — that
// signal, not a separate pre-filter, is what triggers the escalation message.
// This is more robust than keyword pre-filtering because it doesn't depend
// on exact word overlap between the question and the FAQ text.

const KB = [
  { id: "login", title: "Logging in for the first time", text: "New users log in to BSX Connect with their existing Boston Scientific single sign-on (SSO) credentials — no separate password is needed. On first login, you'll be prompted to confirm your region and sales team." },
  { id: "sso-issue", title: "SSO login not working", text: "If SSO login fails, first confirm you're using your @bsci.com email. If the issue persists, it's usually a regional access provisioning delay — contact your local IT helpdesk, not the BSX Connect support line, since this is an identity/access issue." },
  { id: "account-sync", title: "Syncing existing account data", text: "Existing account and deal data from your prior spreadsheets or local CRM exports can be imported via the 'Import Data' tool in Settings. Uploads are matched against existing account records automatically; duplicates are flagged for your review before merging, not merged silently." },
  { id: "data-source", title: "Where does account data come from", text: "BSX Connect pulls account, contact, and deal data from a single unified data layer that synchronizes nightly across all connected regional systems. This replaces the need to maintain separate local spreadsheets." },
  { id: "quote-create", title: "Creating a new quote", text: "From any account page, select 'New Quote', choose the relevant product line, and BSX Connect will pre-fill pricing and terms based on your region's approved catalog. Quotes can be edited before submission." },
  { id: "quote-approval", title: "Quote approval process", text: "Quotes above your individual approval threshold are automatically routed to your regional sales manager for review. You'll see the approval status directly on the quote page — no separate email chain required." },
  { id: "deal-tracking", title: "Tracking deal status", text: "Each account has a live Deal Timeline showing every stage from first contact to close. This replaces manually updating a spreadsheet — the timeline updates automatically as quotes, meetings, and follow-ups are logged." },
  { id: "mobile-access", title: "Using BSX Connect on mobile", text: "BSX Connect has a mobile-optimized view accessible from any browser — no separate app install is required for the initial launch. A dedicated mobile app is planned for a later phase." },
  { id: "offline-mode", title: "Working offline", text: "BSX Connect requires an internet connection for real-time data sync. If you're in a low-connectivity environment, key account and quote data can be viewed in a cached read-only mode, but new entries should be submitted once reconnected." },
  { id: "ai-assistant-scope", title: "What this assistant can help with", text: "This assistant can answer questions about how to use BSX Connect — logging in, syncing data, creating quotes, tracking deals, and finding support contacts. It does not have access to your personal account data or specific deal details." },
  { id: "data-privacy", title: "How is my data kept secure", text: "All data in BSX Connect is encrypted in transit and at rest, and access follows the same regional data privacy requirements (including GDPR, PDPA, and PIPL where applicable) as existing Boston Scientific systems. Data residency rules for China remain unchanged under the new platform." },
  { id: "champion-program", title: "What is the Champion Program", text: "Each anchor market has a designated BSX Connect Champion — a peer sales rep trained early to help their team with day-to-day questions and model best practices during rollout. Ask your regional sales manager who your local Champion is." },
  { id: "training-resources", title: "Where to find training resources", text: "Short video walkthroughs and a quick-start guide are available under the 'Learn' tab inside BSX Connect. Live onboarding sessions are also scheduled during your market's launch week." },
  { id: "rollout-timeline", title: "When is BSX Connect launching in my market", text: "BSX Connect launches first for Sales Representatives in Singapore, Japan, and Vietnam, followed by remaining APAC markets, then extension to Sales Operations and Account Management teams. Check with your regional sales manager for your market's specific date." },
  { id: "support-contact", title: "Who to contact for help", text: "For platform how-to questions, start with your local BSX Connect Champion. For technical issues (login, sync errors), contact IT Helpdesk. For questions about data accuracy, contact your regional Sales Operations lead." },
  { id: "notifications", title: "Managing notifications", text: "Notification preferences (email digest, in-app alerts, deal status changes) can be adjusted under Settings > Notifications. By default, you'll be notified when a quote you submitted is approved or needs revision." },
  { id: "old-tools", title: "Do I still use my old spreadsheets", text: "No — once your market launches, BSX Connect becomes the single source of truth for account and deal data. Continuing to maintain parallel spreadsheets creates data conflicts and is discouraged after your launch date." },
  { id: "forecasting", title: "Forecasting and reporting", text: "Regional forecasts are generated automatically from live deal data in BSX Connect, replacing manually compiled spreadsheet rollups. Reps can see how their pipeline contributes to the regional forecast directly on their dashboard." },
  { id: "multi-country", title: "Working across multiple countries", text: "If you manage accounts across more than one country, BSX Connect lets you toggle between market views from your profile — pricing, approval routing, and compliance rules automatically adjust to the selected market." },
  { id: "feedback", title: "How to give feedback on the platform", text: "A feedback link is available in the footer of every BSX Connect page. Feedback is reviewed weekly by the regional product team during the rollout period." }
];

const KNOWLEDGE_BASE_TEXT = KB.map(e => `[${e.title}]: ${e.text}`).join("\n\n");

const NOT_FOUND_TOKEN = "NOT_FOUND";

const SYSTEM_PROMPT = `You are the BSX Connect Assistant, an internal onboarding assistant for Boston Scientific's new commercial platform, BSX Connect.

Below is the complete official FAQ knowledge base for BSX Connect. Answer the user's question using ONLY information contained in this knowledge base. Keep answers concise (2-4 sentences), friendly, and practical for a sales rep.

If the knowledge base does not contain enough information to answer the question confidently, respond with EXACTLY this and nothing else: ${NOT_FOUND_TOKEN}

Do not guess, do not use outside knowledge, and do not soften a non-answer into a partial guess — if it's not covered, return the token above exactly.

KNOWLEDGE BASE:
${KNOWLEDGE_BASE_TEXT}`;

const FALLBACK_MESSAGE = "I don't have a confident answer to that yet — rather than guess, I'd rather point you to a person. For platform how-to questions, reach out to your local BSX Connect Champion; for anything account-specific, your regional Sales Operations lead.";

export default async function handler(req, res) {
  if (req.method !== "POST") {
    return res.status(405).json({ error: "Method not allowed" });
  }

  const { query } = req.body || {};
  if (!query || typeof query !== "string" || !query.trim()) {
    return res.status(400).json({ error: "Missing 'query' in request body" });
  }
  const trimmedQuery = query.trim();

  // Casual greetings get a friendly canned reply — no LLM call needed for these.
  const GREETING_PATTERN = /^(hi|hello|hey|helo|hii+|yo|sup|good\s?morning|good\s?afternoon|good\s?evening|greetings)[\s!.,]*$/i;
  if (GREETING_PATTERN.test(trimmedQuery)) {
    return res.status(200).json({
      answer: "Hi! I'm the BSX Connect Assistant — ask me about logging in, syncing your data, submitting quotes, or finding the right contact for help.",
      grounded: true
    });
  }

  if (!process.env.OPENAI_API_KEY) {
    return res.status(500).json({ error: "Server is missing OPENAI_API_KEY — set it in your hosting provider's environment variables." });
  }

  try {
    const response = await fetch("https://api.openai.com/v1/chat/completions", {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "Authorization": "Bearer " + process.env.OPENAI_API_KEY
      },
      body: JSON.stringify({
        model: "gpt-4o-mini",
        max_tokens: 300,
        temperature: 0.3,
        messages: [
          { role: "system", content: SYSTEM_PROMPT },
          { role: "user", content: trimmedQuery }
        ]
      })
    });

    const data = await response.json();
    if (data.error) throw new Error(data.error.message || "OpenAI request failed");

    const raw = (data.choices && data.choices[0] && data.choices[0].message
      ? data.choices[0].message.content
      : "").trim();

    if (!raw || raw === NOT_FOUND_TOKEN || raw.startsWith(NOT_FOUND_TOKEN)) {
      return res.status(200).json({ answer: FALLBACK_MESSAGE, grounded: false });
    }

    return res.status(200).json({ answer: raw, grounded: true });
  } catch (err) {
    return res.status(500).json({ error: "Upstream model error", detail: err.message });
  }
}
