# AI Video Studio

An Indonesian, local-first production planner for turning a video idea into a reviewed story, editable storyboard, scene-linked reference assets, copyable prompts, and a per-scene production checklist.

## Run

Requires Python 3.10+ and no third-party packages.

```powershell
python app.py
```

Open <http://127.0.0.1:8000>. Press Ctrl+C to stop. Project data is stored in `data/studio.sqlite3`; uploaded images are in `data/uploads/`. Existing project records are read and updated in place.

## Optional story AI

The manual workflow works without AI. In the Ide tab, choose a provider explicitly:

- **Ollama (local):** install and run Ollama yourself, then choose an already installed model. The app checks only `127.0.0.1:11434`; it does not download models.
- **Gemini API:** the server uses the fixed text model `gemini-3.1-flash-lite` and reads its credential only from the server process environment variable `GEMINI_API_KEY`. For example, set it for a local PowerShell session before starting the app with `$env:GEMINI_API_KEY = "your-key"`. Do not put a real key in source files, browser code, or the repository. The app does not create a secret config file.

When Gemini is selected, the user must press the story request button before the idea, video type, target duration, and visual style are sent to Google. The generated alternatives are only a draft: review and explicitly apply a selection before it replaces story/storyboard content. The app does not automatically switch providers if a request fails or quota is exhausted. Check current API access, quotas, and pricing for your Google account before use; an app subscription does not establish API access or guarantee free usage. No billing is enabled by this app.

Ollama local API documentation: <https://github.com/ollama/ollama/blob/main/docs/api/introduction.mdx>. For example, Ollama's current quickstart lists Gemma 4 E2B at about 7.2 GB, so check model requirements before downloading: <https://github.com/ollama/ollama/blob/main/docs/quickstart.mdx>.

## What works

- Create, rename, reopen, and delete projects.
- Make transparent rule-based manual scene drafts, or request up to three alternatives from an explicitly selected Ollama or Gemini text provider; review and select before applying.
- Edit scene purpose, visual, action, expression, location/time, camera, lighting, dialogue, and duration; reorder scenes and link local image assets.
- Upload local image references up to 12 MB each, categorized as character, location, product, scene, or general.
- Prepare and edit prompts per scene for manual Google Flow, Kling AI, or Runway workflows. Only assets linked to that scene are described in its prompt.
- Track reference, prompt, external clip creation, and collection per scene.
- Export a project/scene JSON summary (not a provider API payload).

## Boundaries

- Single-user and local computer only. No cloud sync, image generation, video generation, video upload, or clip merging.
- Ollama and Gemini are optional. If neither is configured, use the clearly labeled manual draft. Gemini calls require a user-configured `GEMINI_API_KEY` and send the submitted story brief to Google only after an explicit request.
- This prototype binds only to `127.0.0.1`; do not expose it to the public internet as-is.
- Provider access, model input requirements, limits, and prices change. Check the selected provider/model's account and current terms before production. Gemini errors, including quota errors, are shown without automatic fallback; this app does not enable billing.
- The reference screenshots were used only for workflow inspiration; no third-party brand assets are included.
