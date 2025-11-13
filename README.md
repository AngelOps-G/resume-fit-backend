# Resume–Job Fit App (Chrome Extension + Node Backend, OpenAI Scoring)

This is an MVP you can run locally. It scores a résumé against a job description and returns:
- a **score out of 5**
- **4–5 client-facing bullets** only if score ≥ 4

## 1) Prereqs
- Node 18+
- An OpenAI API key with access to `gpt-4o-mini` (or change the model in `.env`).

## 2) Setup

```bash
cd backend
cp .env.example .env
# Edit .env and set OPENAI_API_KEY=...

npm install
npm start
# Backend runs at http://localhost:4000
```

## 3) Load the Chrome Extension

1. Open Chrome and go to `chrome://extensions`
2. Enable **Developer mode**
3. Click **Load unpacked** and select the `chrome-extension` folder
4. Pin the extension for quick access

## 4) Use It
- Go to a job posting page (or open any page), select the JD text if you want better auto-fill, then click the extension.
- Upload a résumé **PDF** *or* paste résumé text.
- Click **Score Candidate**.

## 5) Notes
- The backend enforces the rule: bullets are only returned when score ≥ 4.
- Lock down CORS and deploy the backend if you plan to use it beyond local.
- You can change the model by editing `.env` (`OPENAI_MODEL`).

## 6) Troubleshooting
- If you see 401/403 errors, ensure your `OPENAI_API_KEY` is correct and has model access.
- Some sites block content scripts; if auto-fill fails, just paste the JD.
- PDF parsing depends on file quality; if text is embedded as images, OCR is not included in this MVP.
