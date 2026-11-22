async function normalizeBotType(doc, Bots) {
  const isLegacyBot = Array.isArray(doc.commands);
  const type = isLegacyBot || !doc.type ? "qr" : doc.type;
  if (type === doc.type && !isLegacyBot) return doc;

  const update = { $set: { type } };
  if (isLegacyBot) update.$unset = { commands: "" };
  await Bots.updateOne({ _id: doc._id }, update);

  doc.type = type;
  if (isLegacyBot) delete doc.commands;
  return doc;
}

module.exports = normalizeBotType;
