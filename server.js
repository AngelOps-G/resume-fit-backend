import express from "express";
import cors from "cors";
import multer from "multer";
import pdfParse from "pdf-parse";
import dotenv from "dotenv";
import OpenAI from "openai";
import rateLimit from "express-rate-limit";

dotenv.config();

const app = express();
const port = process.env.PORT || 4000;

// ---------- Core middleware ----------
app.use(cors());                               // permissive now; tighten later
app.use(express.json({ limit: "2mb" }));

// ---------- Security: shared secret + rate limit ----------
app.use((req, res, next) => {
  const key = req.get("x-api-key");
  if (process.env.INTERNAL_API_KEY && key !== process.env.INTERNAL_API_KEY) {
    return res.status(401).json({ error: "Unauthorized" });
  }
  next();
});

app.use(
  rateLimit({
    windowMs: 60_000,     // 1 minute
    max: 120,             // 120 requests per IP per minute
    standardHeaders: true,
    legacyHeaders: false
  })
);

// ---------- File upload helper ----------
const upload = multer({ storage: multer.memoryStorage() });

// ---------- Utils ----------
function cleanText(text) {
  return (text || "").replace(/\s+/g, " ").trim();
}

async function extractPdfText(buffer) {
  const data = await pdfParse(buffer);
  return cleanText(data.text || "");
}

// ---------- OpenAI client ----------
const client = new OpenAI({ apiKey: process.env.OPENAI_API_KEY });

if (!process.env.OPENAI_API_KEY) {
  console.warn("[WARN] OPENAI_API_KEY not set. Set it in .env before running in production.");
}

// ---------- Scoring prompt ----------
const SYSTEM_PROMPT = `You are a recruiting assistant.
Given a RESUME and a JOB DESCRIPTION (JD), you will:
1) Score the candidate's fit on a 1–5 scale (half points allowed; 5=excellent fit).
2) If score >= 4, return 4–5 bullet points highlighting key strengths in a neutral, client-facing tone.
3) If score < 4, return an empty array for bullets.
Return STRICT JSON only:
{ "score": number, "bullets": string[] }`;

function buildUserMessage(resumeText, jobDescription) {
  return [
    { type: "text", text:
`RESUME:
"""${resumeText}"""

JOB DESCRIPTION:
"""${jobDescription}"""

Follow the JSON schema exactly.` }
  ];
}

async function llmScore(resumeText, jobDescription) {
  const messages = [
    { role: "system", content: SYSTEM_PROMPT },
    { role: "user", content: buildUserMessage(resumeText, jobDescription) }
  ];

  const completion = await client.chat.completions.create({
    model: process.env.OPENAI_MODEL || "gpt-4o-mini",
    messages,
    temperature: 0.2,
    response_format: { type: "json_object" }
  });

  const content = completion.choices?.[0]?.message?.content || "{}";
  let parsed;
  try { parsed = JSON.parse(content); } catch { parsed = { score: 1, bullets: [] }; }

  let score = Number(parsed.score);
  if (!Number.isFinite(score)) score = 1;
  score = Math.min(5, Math.max(1, score));

  let bullets = Array.isArray(parsed.bullets) ? parsed.bullets.map(String).slice(0, 5) : [];
  if (score < 4) bullets = [];

  return { score, bullets };
}

// ---------- Routes ----------
app.post("/score-candidate", upload.single("resumeFile"), async (req, res) => {
  try {
    const jobDescription = cleanText(req.body.jobDescription || "");
    let resumeText = cleanText(req.body.resumeText || "");

    if (!jobDescription) return res.status(400).json({ error: "Missing jobDescription" });

    if (req.file?.buffer) {
      const pdfText = await extractPdfText(req.file.buffer);
      resumeText = cleanText(resumeText + "\n" + pdfText);
    }

    if (!resumeText) return res.status(400).json({ error: "Missing résumé text (provide resumeText or resumeFile)" });

    const { score, bullets } = await llmScore(resumeText, jobDescription);
    res.json({ score, score_out_of: 5, bullets });
  } catch (err) {
    console.error(err);
    const message = err.status ? `Upstream error ${err.status}: ${err.message}` :
                    err.error?.message || "Internal server error";
    res.status(500).json({ error: message });
  }
});

app.get("/health", (_req, res) => {
  res.json({ ok: true });
});

// ---------- LinkedIn Recruiter Filters (YoE + keyword boolean) ----------
const FILTERS_SYSTEM_PROMPT = `You are a recruitment search strategist.
Given a JOB DESCRIPTION (JD), produce structured filters for a LinkedIn Recruiter search.

Return STRICT JSON only with this schema:
{
  "job_titles": string[],          // 6–12 precise variants, quoted for LI search, e.g. "Senior Software Engineer"
  "boolean_titles": string,        // Single boolean for titles using quotes and OR
  "skills": string[],              // 10–20 hard skills/technologies
  "locations": string[],           // 1–5 locations (city/region or "Remote")
  "keywords": string[],            // 6–12 include keywords for refinement
  "boolean_keywords": string,      // Single boolean for keywords with quotes and OR
  "industries": string[],          // 3–8 industries to target
  "years_experience": string[]     // 1–4 ranges, e.g. ["3-5 years","5-7 years","7+ years"]
}

Rules:
- Use common, globally recognizable titles; avoid duplicates and obscure synonyms.
- For booleans, only quotes and OR (e.g., "React" OR "Node.js" OR "TypeScript").
- If the JD implies remote/hybrid, include "Remote" in locations.
- Keep outputs concise and de-duplicated.
`;

app.post("/generate-filters", async (req, res) => {
  try {
    const jobDescription = cleanText(req.body.jobDescription || "");
    if (!jobDescription) return res.status(400).json({ error: "Missing jobDescription" });

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
    try { payload = JSON.parse(completion.choices?.[0]?.message?.content || "{}"); }
    catch { payload = {}; }

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

// ---------- Start ----------
app.listen(port, () => {
  console.log(`Backend listening on http://localhost:${port}`);
});

