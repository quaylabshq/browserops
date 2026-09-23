---
name: relay-project-map
description: Generate or substantially refresh Relay's feature-based architecture map for a linked Git project when a person asks for a project overview or the map is missing or materially outdated.
---

# Relay project map

Create a one-time, evidence-backed explanation of how the project works. Relay renders a connected 3D graph of feature dependencies. Selecting a feature shows its components as simple connected cards in the map and in a plain list grouped by software layer, with live agent activity highlighted through the relevant paths. This skill does the semantic analysis; Relay validates and displays the resulting artifact. Run it once per project and regenerate only when the product's feature architecture changes substantially. The user's requested generation authorizes the model cost for this pass.

## Investigate

Read the repository's own instructions first. Inspect the README, manifests, entry points, routes or commands, core modules, storage, UI, infrastructure, and relevant tests. Trace each important user capability from entry point through behavior and state to its outputs. Use source evidence for every component. Include cross-cutting platform capabilities where they matter to understanding the system; do not call folders or file types “features.”

Aim for a newcomer to answer: what this project does, what a user can do, where each feature lives, how requests/data travel through it, what depends on what, and where an agent is working now. If source evidence is ambiguous, say so in the feature description instead of inventing behavior. Avoid secrets, environment file names, credentials, source snippets, and absolute local paths.

## Write the artifact

Create `.relay/project-map.json` at the Git root using this schema. IDs should be stable, short slugs. Make layers meaningful to this project, such as interface, orchestration, domain, data, and infrastructure. Keep features at a useful product capability scale; a component can span several files or directories. Reuse a path in multiple components if it implements multiple features. Paths must be repository-relative and should point to real files or directories. Dependencies are feature IDs and mean “this feature relies on that feature.”

```json
{
  "schemaVersion": 2,
  "summary": "Two to four sentences explaining the project and its users.",
  "architecture": "How the main interfaces, runtime processes, data stores, and external systems connect.",
  "layers": [
    { "id": "interface", "name": "Interface", "description": "User-facing entry points" }
  ],
  "features": [
    {
      "id": "example-capability",
      "name": "Example capability",
      "summary": "What this capability does and why it matters.",
      "journey": "The concrete user or system flow from input through result.",
      "visual": "engine",
      "dependsOn": [],
      "components": [
        { "id": "example-entry", "name": "Entry point", "layer": "interface", "description": "Its role in this feature.", "paths": ["src/example.ts"] }
      ]
    }
  ]
}
```

The validator supports 1–8 layers, 1–24 features, 1–16 components per feature, and 1–10 evidence paths per component. Every component needs a description and evidence. Make dependencies accurate and avoid self or missing references. Keep the artifact below 220 KB. Preserve useful stable IDs when refreshing so people can follow the map over time.

Choose one familiar symbol for each feature marker: `gateway` for setup or entry, `workspace` for user-facing collaboration, `engine` for execution, `flow` for a pipeline, `network` for connections and integrations, `vault` for stored data or memory, `shield` for safeguards and policy, or `observatory` for monitoring and insights. Choose by what the feature does, not by its folder or implementation language. This field is optional for older maps; Relay infers a symbol when it is missing.

Validate the JSON and ensure every evidence path exists. If Relay's in-app Generate map button launched this skill, stop after writing the artifact; Relay validates and publishes it automatically and shows progress in Live work. Otherwise run `relay map refresh <linked-project-id>` on the linked host to publish it. If the project ID is unknown, inspect `relay status` to find the linked project. Report the feature count, any uncertainty, and the published result. Relay's companion will subsequently sync the same artifact by fingerprint without repeating the AI analysis.
