---
"traits": minor
---

Make `layerLanguageModel` optional. Without it, `derive_trait` returns
`GenerationRequired` for trait decomposition and reconciliation, and the calling
agent supplies the JSON through the new `generated` parameter. Configs that
provide a language model keep the current behavior.
