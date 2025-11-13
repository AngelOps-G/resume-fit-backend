import express from "express";
import cors from "cors";
import multer from "multer";
import pdfParse from "pdf-parse";
import dotenv from "dotenv";
import OpenAI from "openai";

dotenv.config();

const app = express();
const port = process.env.PORT || 4000;

// In dev we allow any origin; lock down in prod if needed.
app.use(cors());
app.use(express.json({ limit: "2mb" }));

const upload = multer({ storage: multer.memoryStorage() });

// --- Helpers ---
function cleanText(text) {
  return (text || "").replace(/\s+/g, " ").trim();
}

async function extractPdfText(buffer) {
  const data = await pdfParse(buffer);
  return cleanText(data.text || "");
}

const client = new OpenAI({
  apiKey: process.env.OPENAI_API_KEY
});

if (!process.env.OPENAI_API_KEY) {
  console.warn("[WARN] OPENAI_API_KEY not set. Set it in .env before running in production.");
}

// System prompt guiding strict JSON output and the rubric.
const SYSTEM_PROMPT = `You are a recruiting assistant.
Given a RESUME and a JOB DESCRIPTION (JD), you will:
1) Score the candidate's fit on a 1–5 scale (integers allowed, half points allowed; 5=excellent fit).
2) If score >= 4, return 4–5 bullet points highlighting the key strengths relevant to the JD in a neutral, client-facing tone.
3) If score < 4, return an empty array for bullets.
4) Be concise and avoid personal data.

Return STRICT JSON only with this schema:
{
  "score": number,    // 1..5, half points allowed
  "bullets": string[] // 0..5 items
}`;

// Build a single user message that includes both texts.
function buildUserMessage(resumeText, jobDescription) {
  return [
    { type: "text", text:
`RESUME:
"""${resumeText}"""

JOB DESCRIPTION:
"""${jobDescription}"""

Please follow the JSON schema exactly.`
    }
  ];
}

// Call OpenAI to score + produce bullets (JSON).
async function llmScore(resumeText, jobDescription) {
  const messages = [
    { role: "system", content: SYSTEM_PROMPT },
    { role: "user", content: buildUserMessage(resumeText, jobDescription) }
  ];

  // Using Chat Completions with response_format for JSON safety.
  const completion = await client.chat.completions.create({
    model: process.env.OPENAI_MODEL || "gpt-4o-mini",
    messages,
    temperature: 0.2,
    response_format: { type: "json_object" }
  });

  const content = completion.choices?.[0]?.message?.content || "{}";
  let parsed;
  try {
    parsed = JSON.parse(content);
  } catch (e) {
    // Fallback: enforce safe default
    parsed = { score: 1, bullets: [] };
  }

  // Normalize/enforce schema
  let score = Number(parsed.score);
  if (!Number.isFinite(score)) score = 1;
  if (score < 1) score = 1;
  if (score > 5) score = 5;

  let bullets = Array.isArray(parsed.bullets) ? parsed.bullets.map(b => String(b)).slice(0,5) : [];

  // Business rule enforcement
  if (score < 4) bullets = [];

  return { score, bullets };
}

// --- Routes ---
app.post("/score-candidate", upload.single("resumeFile"), async (req, res) => {
  try {
    const jobDescription = cleanText(req.body.jobDescription || "");
    let resumeText = cleanText(req.body.resumeText || "");

    if (!jobDescription) {
      return res.status(400).json({ error: "Missing jobDescription" });
    }

    if (req.file && req.file.buffer) {
      const pdfText = await extractPdfText(req.file.buffer);
      resumeText = cleanText(resumeText + "\n" + pdfText);
    }

    if (!resumeText) {
      return res.status(400).json({ error: "Missing résumé text (provide resumeText or resumeFile)" });
    }

    const { score, bullets } = await llmScore(resumeText, jobDescription);

    res.json({
      score,
      score_out_of: 5,
      bullets
    });
  } catch (err) {
    console.error(err);
    // Helpful error surface for common OpenAI issues
    let message = "Internal server error";
    if (err.status) message = `Upstream error ${err.status}: ${err.message}`;
    else if (err.error?.message) message = err.error.message;
    res.status(500).json({ error: message });
  }
});

app.get("/health", (_req, res) => {
  res.json({ ok: true });
});

// --- LinkedIn Recruiter Filters generation (with YoE + keyword boolean) ---
const FILTERS_SYSTEM_PROMPT = `You are a recruitment search strategist.
Given a JOB DESCRIPTION (JD), produce structured filters for a LinkedIn Recruiter search.

Return STRICT JSON only with this schema:
{
  "job_titles": string[],          // 6–12 precise variants, already quoted for LI search, e.g. "Senior Software Engineer"
  "boolean_titles": string,        // Single boolean for titles using quotes and OR (avoid NOT unless essential)
  "skills": string[],              // 10–20 hard skills/technologies (nouns/tech, no seniority words)
  "locations": string[],           // 1–5 locations (city/region or "Remote")
  "keywords": string[],            // 6–12 include keywords for refinement
  "boolean_keywords": string,      // Single boolean for keywords with quotes and OR
  "industries": string[],          // 3–8 industries to target
  "years_experience": string[]     // 1–4 ranges, e.g. ["3-5 years","5-7 years","7+ years"]
}

Rules:
- Use common, globally recognizable titles; avoid duplicates and obscure synonyms.
- Titles/keywords booleans: only use quotes and OR (e.g., "React" OR "Node.js" OR "TypeScript").
- If the JD implies remote/hybrid, include "Remote" in locations.
- Keep outputs concise and de-duplicated.
`;

app.post("/generate-filters", async (req, res) => {
  try {
    const jobDescription = cleanText(req.body.jobDescription || "");
    if (!jobDescription) {
      return res.status(400).json({ error: "Missing jobDescription" });
    }

    const messages = [
      { role: "system", content: FILTERS_SYSTEM_PROMPT },
      { role: "user", content: [{ type: "text", text: `JOB DESCRIPTION:\n"""${jobDescription}"""\nReturn ONLY the JSON as specified.` }] }
    ];

    const completion = await client.chat.completions.create({
      model: process.env.OPENAI_MODEL || "gpt-4o-mini",
      messages,
      temperature: 0.2,
      response_format: { type: "json_object" }
    });

    let payload;
    try {
      payload = JSON.parse(completion.choices?.[0]?.message?.content || "{}");
    } catch {
      payload = {};
    }

    const normArr = (x) => Array.isArray(x) ? x.map(v => String(v).trim()).filter(Boolean) : [];

    const job_titles        = normArr(payload.job_titles).slice(0, 16);
    const boolean_titles    = String(payload.boolean_titles || "");
    const skills            = normArr(payload.skills).slice(0, 24);
    const locations         = normArr(payload.locations).slice(0, 8);
    const keywords          = normArr(payload.keywords).slice(0, 16);
    const boolean_keywords  = String(payload.boolean_keywords || "");
    const industries        = normArr(payload.industries).slice(0, 10);
    const years_experience  = normArr(payload.years_experience).slice(0, 8);

    return res.json({
      job_titles,
      boolean_titles,
      skills,
      locations,
      keywords,
      boolean_keywords,
      industries,
      years_experience
    });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: "Internal server error" });
  }
});



app.listen(port, () => {
  console.log(`Backend listening on http://localhost:${port}`);
});
