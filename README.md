# AI Video Studio

An Indonesian, local-first production planner for turning a video idea into a reviewed story, editable storyboard, scene-linked reference assets, copyable prompts, and a per-scene production checklist.

## Run

Requires Python 3.10+ and no third-party packages.

```powershell
python app.py
```

Open <http://127.0.0.1:8000>. Press Ctrl+C to stop. Project data is stored in `data/studio.sqlite3`; uploaded images are in `data/uploads/`. Existing project records are read and updated in place.

## Optional local text AI

The manual workflow works without AI. For AI-generated story alternatives, install Ollama yourself, download a model that fits your computer, start its local service, then use **Periksa lagi** in the Ide tab. The app checks only `127.0.0.1:11434`, lets you choose an installed model, and asks before applying a selected story. It does not download models, call a cloud provider, or store API keys. Model downloads and local inference use disk, memory, and electricity; performance depends on hardware.

Ollama local API documentation: <https://github.com/ollama/ollama/blob/main/docs/api/introduction.mdx>. For example, Ollama's current quickstart lists Gemma 4 E2B at about 7.2 GB, so check model requirements before downloading: <https://github.com/ollama/ollama/blob/main/docs/quickstart.mdx>.

## What works

- Create, rename, reopen, and delete projects.
- Make transparent rule-based manual scene drafts, or request up to three alternatives from an installed Ollama model; review and select before applying.
- Edit scene purpose, visual, action, expression, location/time, camera, lighting, dialogue, and duration; reorder scenes and link local image assets.
- Upload local image references up to 12 MB each, categorized as character, location, product, scene, or general.
- Prepare and edit prompts per scene for manual Google Flow, Kling AI, or Runway workflows. Only assets linked to that scene are described in its prompt.
- Track reference, prompt, external clip creation, and collection per scene.
- Export a project/scene JSON summary (not a provider API payload).

## Boundaries

- Single-user and local computer only. No cloud sync, external AI API, image generation, video generation, video upload, or clip merging.
- Ollama is optional and not bundled. If unavailable, use the clearly labeled manual draft. No API key is needed for the local Ollama endpoint.
- This prototype binds only to `127.0.0.1`; do not expose it to the public internet as-is.
- Provider access, model input requirements, limits, and prices change. Check the selected provider/model's interface before production. This app does not make provider generation requests or paid calls.
- The reference screenshots were used only for workflow inspiration; no third-party brand assets are included.
