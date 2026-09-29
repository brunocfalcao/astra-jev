export const DEFAULT_MODEL = "gpt-6-astra";
export const MANAGED_MODELS = Object.freeze({
  "gpt-6-astra": "GPT-6 Astra",
  "gpt-6.1-sol": "GPT-6.1 Sol",
});
export const isManagedModel = (model) => Object.hasOwn(MANAGED_MODELS, model);
