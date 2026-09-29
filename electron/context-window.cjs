function positiveTokens(value) {
  const number = Number(value);
  return Number.isSafeInteger(number) && number > 0 ? number : null;
}

function modelContextInfo(model) {
  const meta = model?._meta || model?.meta || {};
  const defaultContextTokens = positiveTokens(meta.totalContextTokens);
  const selectedContextTokens = positiveTokens(meta.contextWindow);
  const contextWindows = [...new Set(
    (Array.isArray(meta.contextWindows) ? meta.contextWindows : [])
      .map(positiveTokens)
      .filter(Boolean)
  )];
  if (contextWindows.length && defaultContextTokens && !contextWindows.includes(defaultContextTokens)) {
    contextWindows.push(defaultContextTokens);
  }
  contextWindows.sort((a, b) => a - b);
  return { defaultContextTokens, selectedContextTokens, contextWindows };
}

function contextWindowForModel(models, modelId, preferred) {
  const model = models.find((item) => item.id === modelId);
  if (!model) return null;
  const options = model.contextWindows || [];
  const selected = positiveTokens(preferred);
  if (selected && options.includes(selected)) return selected;
  return model.defaultContextTokens || options[0] || null;
}

module.exports = { positiveTokens, modelContextInfo, contextWindowForModel };
