const EMOJI_IDS = Object.freeze({
  "🔢": ["5226513232549664618"],
  "🖼": [
    "5258050709252743821",
    "5257974976094412956",
    "5258254475386167466",
  ],
  "👤": [
    "5258362837411045098",
    "5258011929993026890",
    "5260399854500191689",
  ],
  "⭐️": ["5258185631355378853", "5260412365739925015"],
  "📂": [
    "5258514780469075716",
    "5258389041006518073",
    "5257969839313526622",
  ],
  "❌": [
    "5258226313285607065",
    "5260280853841321805",
    "5258071638628377037",
    "5258123337149717894",
    "5258318620722733379",
    "5260342697075416641",
    "5258453452631056344",
  ],
  "⚽️": ["5258169263235013408"],
  "🐻": ["5258145898612924124"],
  "📝": ["5257965174979042426"],
  "🪙": ["5258368777350816286"],
  "⚡️": ["5258152182150077732"],
  "📖": ["5258328383183396223"],
  "🤖": ["5258093637450866522"],
  "💼": ["5258260149037965799"],
  "👨‍🎨": ["5258450450448915742"],
  "🗓": ["5258105663359294787"],
  "🤙": ["5258337316715373336"],
  "📸": ["5258205968025525531"],
  "👩‍🎨": ["5258215635996908355"],
  "📣": ["5260268501515377807"],
  "✅": [
    "5260726538302660868",
    "5260416304224936047",
    "5258057130228849960",
  ],
  "⛓": ["5260730055880876557"],
  "📄": ["5258477770735885832"],
  "©": ["5258507474729704350"],
  "👥": ["5258513401784573443", "5258486128742244085"],
  "✍️": ["5258331647358540449"],
  "🗑": ["5258130763148172425"],
  "↔️": ["5260233433107407649"],
  "🎭": ["5258430848218176413"],
  "📁": ["5257965810634202885"],
  "➡️": ["5260450573768990626", "5258215850745275216"],
  "🎮": ["5258508428212445001"],
  "🎓": ["5258334872878980409"],
  "❤️": ["5258179403652801593"],
  "🏘": ["5257963315258204021"],
  "🚪": ["5258084656674250503"],
  "💡": ["5258216851472654189"],
  "📍": ["5258509201306557640"],
  "🔒": ["5258476306152038031"],
  "💬": [
    "5258215846450305872",
    "5260535596941582167",
    "5287595522993991899",
  ],
  "🌘": ["5258011861273551368"],
  "🎵": ["5258289810082111221"],
  "🔕": ["5260264520080695245"],
  "🎶": ["5258334469152054985"],
  "↗️": ["5257991477358763590"],
  "📌": ["5258461531464539536"],
  "✈️": ["5258115571848846212"],
  "➕": ["5258108352008823107"],
  "🍑": ["5258330865674494479"],
  "🔫": ["5260221883940347555"],
  "👏": ["5258501105293205250"],
  "🔄": ["5258420634785947640", "5260687119092817530"],
  "🌠": ["5258212268742549391"],
  "🔃": ["5260687681733533075"],
  "⬅️": ["5258236805890710909"],
  "❗️": ["5258474669769497337"],
  "💎": ["5280962371207077415"],
  "🤚": ["5260249440450520061"],
  "🗳": ["5258200019495821936"],
  "⬇️": ["5258336354642697821"],
  "🕔": ["5258419835922030550"],
  "⏲": ["5258258882022612173"],
  "👀": ["5260341314095947411"],
  "☁️": ["5280867942056108177"],
  "⬆️": ["5260652420052032852", "5258043150110301407"],
  "🔼": ["5260379144167890225"],
  "💻": ["5258423306255604960"],
  "ℹ️": ["5258503720928288433"],
  "🙂": ["5258262708838472996"],
  "🔇": ["5258267368877989660"],
  "📈": ["5258391025281408576"],
  "☀️": ["5258089153505009279"],
  "📚": ["5260512129240276089"],
  "📦": ["5258134813302332906"],
  "✋": ["5258362429389152256"],
  "📹": ["5258077307985207053"],
  "📞": ["5258020476977946656"],
  "📼": ["5258391252914676042"],
});

const EMOJI_PATTERN = new RegExp(
  Object.keys(EMOJI_IDS)
    .sort((left, right) => right.length - left.length)
    .map((emoji) => emoji.replace(/[.*+?^${}()|[\]\\]/g, "\\$&"))
    .join("|"),
  "gu",
);

const TEXT_ICONS = [
  [/bekor|cancel|rad et|xato|error|blok/i, "❌"],
  [/orqaga|back|qayt/i, "⬅️"],
  [/tayyor|saqla|tasdiq|done|save|start|yoqish/i, "✅"],
  [/balans|to'lov|tarif|stars|summa|narx|price/i, "🪙"],
  [
    /rasm|logo|muqova|photo|image|kvadrat|dumaloq|shakl|nisbat|o'lcham|shape|ratio/i,
    "🖼",
  ],
  [/foydalanuvchi|profil|user|admin/i, "👤"],
  [/bot/i, "🤖"],
  [/kanal|channel|post/i, "📣"],
  [/musiqa|audio|mp3|ijrochi|artist/i, "🎵"],
  [/statistika|statistic|soni|count/i, "🔢"],
  [/fayl|file|ro'yxat|list/i, "📂"],
];

function chooseTextIcon(text) {
  for (const match of text.matchAll(EMOJI_PATTERN)) {
    return match[0];
  }
  const rule = TEXT_ICONS.find(([pattern]) => pattern.test(text));
  return rule?.[1] || "ℹ️";
}

function nextEmojiId(emoji, counts) {
  const ids = EMOJI_IDS[emoji];
  const index = counts.get(emoji) || 0;
  counts.set(emoji, index + 1);
  return ids[index % ids.length];
}

function escapeHtml(text) {
  return text.replace(/[&<>]/g, (character) => ({
    "&": "&amp;",
    "<": "&lt;",
    ">": "&gt;",
  })[character]);
}

function renderHtmlText(text, parseMode) {
  const counts = new Map();
  const escape = parseMode !== "HTML";
  let result = "";
  let cursor = 0;
  for (const match of text.matchAll(EMOJI_PATTERN)) {
    const before = text.slice(cursor, match.index);
    result += escape ? escapeHtml(before) : before;
    result += `<tg-emoji emoji-id="${nextEmojiId(match[0], counts)}">${match[0]}</tg-emoji>`;
    cursor = match.index + match[0].length;
  }
  if (cursor === 0) {
    const emoji = chooseTextIcon(text);
    const id = nextEmojiId(emoji, counts);
    result = `<tg-emoji emoji-id="${id}">${emoji}</tg-emoji> `;
    cursor = 0;
  }
  const rest = text.slice(cursor);
  result += escape ? escapeHtml(rest) : rest;
  return result;
}

function addEmojiEntities(text, entities) {
  const counts = new Map();
  const additions = [];
  for (const match of text.matchAll(EMOJI_PATTERN)) {
    if (
      entities.some(
        (entity) =>
          entity.type === "custom_emoji" && entity.offset === match.index,
      )
    ) {
      continue;
    }
    additions.push({
      type: "custom_emoji",
      offset: match.index,
      length: match[0].length,
      custom_emoji_id: nextEmojiId(match[0], counts),
    });
  }

  if (!additions.length && !text.match(EMOJI_PATTERN)) {
    const emoji = chooseTextIcon(text);
    const id = nextEmojiId(emoji, counts);
    const offset = emoji.length + 1;
    return {
      text: `${emoji} ${text}`,
      entities: [
        { type: "custom_emoji", offset: 0, length: emoji.length, custom_emoji_id: id },
        ...entities.map((entity) => ({ ...entity, offset: entity.offset + offset })),
      ],
    };
  }

  return {
    text,
    entities: [...entities, ...additions].sort(
      (left, right) =>
        left.offset - right.offset || right.length - left.length,
    ),
  };
}

function decorateText(payload, textField, entitiesField) {
  const text = payload[textField];
  if (typeof text !== "string" || !text.length) return payload;
  if (payload.parse_mode && payload.parse_mode !== "HTML") return payload;

  const hasEntities = Array.isArray(payload[entitiesField]);
  if (hasEntities) {
    const result = addEmojiEntities(text, payload[entitiesField]);
    return { ...payload, [textField]: result.text, [entitiesField]: result.entities };
  }

  const nextText = renderHtmlText(text, payload.parse_mode);
  return {
    ...payload,
    [textField]: nextText,
    ...(!payload.parse_mode ? { parse_mode: "HTML" } : {}),
  };
}

function buttonIcon(text, counts) {
  const matches = [...text.matchAll(EMOJI_PATTERN)];
  if (matches.length) {
    const emoji = matches[0][0];
    const label = text.replace(EMOJI_PATTERN, "").trim();
    return {
      icon_custom_emoji_id: nextEmojiId(emoji, counts),
      text: label || "\u00a0",
    };
  }
  return {
    icon_custom_emoji_id: nextEmojiId(chooseTextIcon(text), counts),
    text,
  };
}

function decorateKeyboard(replyMarkup) {
  if (!replyMarkup || typeof replyMarkup !== "object") return replyMarkup;
  let changed = false;
  const counts = new Map();
  const result = { ...replyMarkup };
  for (const field of ["inline_keyboard", "keyboard"]) {
    if (!Array.isArray(replyMarkup[field])) continue;
    result[field] = replyMarkup[field].map((row) =>
      Array.isArray(row)
        ? row.map((button) => {
            if (typeof button === "string") {
              changed = true;
              return { ...buttonIcon(button, counts) };
            }
            if (
              !button ||
              typeof button !== "object" ||
              typeof button.text !== "string" ||
              button.icon_custom_emoji_id
            ) {
              return button;
            }
            changed = true;
            return { ...button, ...buttonIcon(button.text, counts) };
          })
        : row,
    );
  }
  return changed ? result : replyMarkup;
}

function decoratePayload(method, payload) {
  let result = payload;
  const textField = ["sendMessage", "editMessageText"].includes(method)
    ? "text"
    : [
        "sendPhoto",
        "sendDocument",
        "sendAudio",
        "sendVideo",
        "sendAnimation",
        "sendVoice",
        "editMessageCaption",
      ].includes(method)
      ? "caption"
      : null;
  if (textField) {
    const entitiesField = textField === "text" ? "entities" : "caption_entities";
    result = decorateText(result, textField, entitiesField);
  }
  if (result.reply_markup) {
    const replyMarkup = decorateKeyboard(result.reply_markup);
    if (replyMarkup !== result.reply_markup) {
      result = { ...result, reply_markup: replyMarkup };
    }
  }
  return { payload: result, changed: result !== payload };
}

module.exports = { decoratePayload, EMOJI_IDS };
