function stylize(text, options) {
  const {
    upperStart,
    lowerStart,
    digitStart,
    upperOverrides = {},
    lowerOverrides = {},
    uppercase = false,
    lowercase = false,
    mapDigit,
  } = options;

  return Array.from(text, (originalCharacter) => {
    const character = uppercase
      ? originalCharacter.toUpperCase()
      : lowercase
        ? originalCharacter.toLowerCase()
        : originalCharacter;
    const code = character.codePointAt(0);

    if (code >= 65 && code <= 90) {
      return String.fromCodePoint(
        upperOverrides[code - 65] || upperStart + code - 65,
      );
    }
    if (code >= 97 && code <= 122) {
      return String.fromCodePoint(
        lowerOverrides[code - 97] || lowerStart + code - 97,
      );
    }
    if (code >= 48 && code <= 57) {
      if (mapDigit) return mapDigit(code - 48);
      if (digitStart) return String.fromCodePoint(digitStart + code - 48);
    }
    return originalCharacter;
  }).join("");
}

const scriptUpperOverrides = {
  B: 0x212c,
  E: 0x2130,
  F: 0x2131,
  H: 0x210b,
  I: 0x2110,
  L: 0x2112,
  M: 0x2133,
  R: 0x211b,
};
const scriptLowerOverrides = {
  e: 0x212f,
  g: 0x210a,
  o: 0x2134,
};
const doubleStruckUpperOverrides = {
  C: 0x2102,
  H: 0x210d,
  N: 0x2115,
  P: 0x2119,
  Q: 0x211a,
  R: 0x211d,
  Z: 0x2124,
};
const frakturUpperOverrides = {
  C: 0x212d,
  H: 0x210c,
  I: 0x2111,
  R: 0x211c,
  Z: 0x2128,
};

const styles = [
  ["Bold", { upperStart: 0x1d400, lowerStart: 0x1d41a, digitStart: 0x1d7ce }],
  ["Italic", { upperStart: 0x1d434, lowerStart: 0x1d44e, lowerOverrides: { h: 0x210e } }],
  ["Bold italic", { upperStart: 0x1d468, lowerStart: 0x1d482 }],
  ["Sans", { upperStart: 0x1d5a0, lowerStart: 0x1d5ba, digitStart: 0x1d7e2 }],
  ["Sans bold", { upperStart: 0x1d5d4, lowerStart: 0x1d5ee, digitStart: 0x1d7ec }],
  ["Sans italic", { upperStart: 0x1d608, lowerStart: 0x1d622 }],
  ["Sans bold italic", { upperStart: 0x1d63c, lowerStart: 0x1d656 }],
  ["Monospace", { upperStart: 0x1d670, lowerStart: 0x1d68a, digitStart: 0x1d7f6 }],
  [
    "Double-struck",
    {
      upperStart: 0x1d538,
      lowerStart: 0x1d552,
      digitStart: 0x1d7d8,
      upperOverrides: doubleStruckUpperOverrides,
    },
  ],
  [
    "Script",
    {
      upperStart: 0x1d49c,
      lowerStart: 0x1d4b6,
      upperOverrides: scriptUpperOverrides,
      lowerOverrides: scriptLowerOverrides,
    },
  ],
  ["Bold script", { upperStart: 0x1d4d0, lowerStart: 0x1d4ea }],
  [
    "Fraktur",
    {
      upperStart: 0x1d504,
      lowerStart: 0x1d51e,
      upperOverrides: frakturUpperOverrides,
    },
  ],
  ["Bold fraktur", { upperStart: 0x1d56c, lowerStart: 0x1d586 }],
  [
    "Circled uppercase",
    {
      upperStart: 0x24b6,
      lowerStart: 0x24b6,
      uppercase: true,
      mapDigit: (digit) =>
        String.fromCodePoint(digit === 0 ? 0x24ea : 0x2460 + digit - 1),
    },
  ],
  [
    "Circled lowercase",
    {
      upperStart: 0x24d0,
      lowerStart: 0x24d0,
      lowercase: true,
      mapDigit: (digit) =>
        String.fromCodePoint(digit === 0 ? 0x24ea : 0x2460 + digit - 1),
    },
  ],
  [
    "Parenthesized",
    {
      upperStart: 0x249c,
      lowerStart: 0x249c,
      lowercase: true,
      mapDigit: (digit) =>
        String.fromCodePoint(digit === 0 ? 0x24eb : 0x2474 + digit - 1),
    },
  ],
  ["Fullwidth", { upperStart: 0xff21, lowerStart: 0xff41, digitStart: 0xff10 }],
];

function createNicknameVariants(text) {
  return styles.map(([name, options]) => ({
    name,
    value: stylize(text, options),
  }));
}

function registerNicknameFont(bot) {
  bot.command("start", async (ctx) => {
    await ctx.reply(
      bot.config.welcome ||
        "Nickname yoki matn yuboring — 17 xil uslub tayyorlayman. Istagan variantni bosing — nusxa olinadi.",
    );
  });

  bot.onText(/[\s\S]+/, async (ctx) => {
    const text = ctx.text.trim();
    if (text.startsWith("/")) {
      await ctx.reply("Nickname yoki matn yuboring.");
      return;
    }
    if (!text) {
      await ctx.reply("Bo'sh matn yubormang.");
      return;
    }
    if (Array.from(text).length > 32) {
      await ctx.reply("Nickname 32 belgidan oshmasin.");
      return;
    }

    const variants = createNicknameVariants(text);
    const keyboard = [];
    for (let index = 0; index < variants.length; index += 2) {
      keyboard.push(
        variants.slice(index, index + 2).map(({ value }) => ({
          text: value,
          copy_text: { text: value },
        })),
      );
    }

    await ctx.reply("17 xil nickname tayyor. Nusxa olish uchun keraklisini bosing:", {
      reply_markup: { inline_keyboard: keyboard },
    });
  });
}

module.exports = registerNicknameFont;
module.exports.createNicknameVariants = createNicknameVariants;
