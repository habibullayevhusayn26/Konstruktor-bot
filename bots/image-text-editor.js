const fs = require("node:fs/promises");
const path = require("node:path");
const sharp = require("sharp");

const TEMPLATE_PATH = path.join(__dirname, "..", "images", "uzum.png");
const DETAIL_COLOR = "#FFFFFF";
const DETAIL_FONT_FAMILY = "Segoe UI";
const DETAIL_FONT_WEIGHT = 900;
const MAX_TITLE_LENGTH = 48;
const DEFAULT_VALUES = Object.freeze({
  quantity: "10 000 quti",
  productName: "Katta Mahsulot",
  productCode: "1728",
  time: "1:42",
  battery: "50",
});

class TitleInputError extends Error {}

function escapeXml(value) {
  return value
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&apos;");
}

function validateField(field, value) {
  const text = String(value || "").trim().replace(/\s+/g, " ");
  if (!text || text.length > MAX_TITLE_LENGTH) {
    throw new TitleInputError(`${field} 1–${MAX_TITLE_LENGTH} belgi bo'lishi kerak.`);
  }
  return text;
}

async function replaceTemplateTitle(
  quantity = DEFAULT_VALUES.quantity,
  productName = DEFAULT_VALUES.productName,
  productCode = DEFAULT_VALUES.productCode,
  time = DEFAULT_VALUES.time,
  battery = DEFAULT_VALUES.battery,
) {
  const values = {
    quantity: validateField("1-yozuv", quantity),
    productName: validateField("2-yozuv", productName),
    productCode: validateField("3-yozuv", productCode),
    time: validateField("4-yozuv", time),
    battery: validateField("5-yozuv", battery),
  };
  const template = await fs.readFile(TEMPLATE_PATH);
  const statusBackground = [
    `<rect x="34" y="27" width="170" height="50" fill="#6507E1"/>`,
    `<rect x="685" y="28" width="38" height="34" fill="#6507E1"/>`,
  ].join("");
  const details = [
    {
      text: values.time,
      x: 40,
      y: 67,
      size: 34,
      weight: 900,
    },
    {
      text: values.battery,
      x: 704,
      y: 58,
      size: 34,
      weight: 900,
    },
    { text: values.quantity, y: 347 },
    { text: `${values.productName} · ${values.productCode}`, y: 420 },
  ];
  const text = details
    .map((line) => {
      const fontSize = line.size || Math.min(52, Math.floor(680 / (line.text.length * 0.64)));
      const x = line.x ?? 48;
      const weight = line.weight ?? DETAIL_FONT_WEIGHT;
      return `<text x="${x}" y="${line.y}" text-anchor="start" ` +
        `font-family="${DETAIL_FONT_FAMILY}, sans-serif" font-size="${fontSize}" ` +
        `font-weight="${weight}" fill="${DETAIL_COLOR}">${escapeXml(line.text)}</text>`;
    })
    .join("");
  const svg = Buffer.from(
    `<svg xmlns="http://www.w3.org/2000/svg" width="768" height="1706">` +
      statusBackground +
      text +
      `</svg>`,
  );

  return sharp(template).composite([{ input: svg }]).png().toBuffer();
}

function registerImageTextEditor(bot) {
  const sessions = new Map();

  function editMenu() {
    return {
      inline_keyboard: [
        [
          { text: "1: 10 000 quti", callback_data: "uzum:edit:quantity" },
        ],
        [
          { text: "2: Katta Mahsulot", callback_data: "uzum:edit:productName" },
        ],
        [
          { text: "3: 1728", callback_data: "uzum:edit:productCode" },
        ],
        [
          { text: "4: 1:42", callback_data: "uzum:edit:time" },
        ],
        [
          { text: "5: 50", callback_data: "uzum:edit:battery" },
        ],
      ],
    };
  }

  function resetSession(userId) {
    const session = {
      quantity: DEFAULT_VALUES.quantity,
      productName: DEFAULT_VALUES.productName,
      productCode: DEFAULT_VALUES.productCode,
      time: DEFAULT_VALUES.time,
      battery: DEFAULT_VALUES.battery,
      step: "quantity",
    };
    sessions.set(userId, session);
    return session;
  }

  async function sendEditedImage(bot, ctx, session) {
    const image = await replaceTemplateTitle(
      session.quantity,
      session.productName,
      session.productCode,
      session.time,
      session.battery,
    );
    await bot.sendPhoto(ctx.chat.id, image, "edited-uzum.png", {
      caption: "Rasm tayyor. Har bir yozuvni alohida o'zgartiring.",
      reply_markup: editMenu(),
    });
  }

  bot.command("start", async (ctx) => {
    try {
      const userId = ctx.from?.id ?? ctx.chat.id;
      resetSession(userId);
      const sample = await fs.readFile(TEMPLATE_PATH);
      await bot.sendPhoto(ctx.chat.id, sample, "uzum.png", {
        caption: "Uzum shabloni. O'tkazildi yozuvi ostiga ma'lumot qo'shiladi.",
      });
      await ctx.reply("1/5 — Birinchi yozuvni yuboring:\n10 000 quti");
    } catch (error) {
      console.error("Rasm matni shablonini yuborib bo'lmadi:", error.message);
      await ctx.reply("Namuna rasmni yuborishda xato yuz berdi. Keyinroq urinib ko'ring.");
    }
  });

  bot.onCallbackData(/^uzum:edit:(quantity|productName|productCode|time|battery)$/, async (ctx) => {
    const userId = ctx.from?.id ?? ctx.chat?.id;
    if (!userId) return;
    let session = sessions.get(userId);
    if (!session) session = resetSession(userId);

    const field = ctx.text.split(":")[2];
    session.pendingField = field;
    session.step = null;
    await ctx.answer();
    const prompts = {
      quantity: "1/3 — Birinchi yozuvning yangi matnini yuboring:",
      productName: "2/3 — Ikkinchi yozuvning yangi matnini yuboring:",
      productCode: "3/3 — Uchinchi yozuvning yangi matnini yuboring:",
      time: "4/5 — 1:42 matnining yangi qiymatini yuboring:",
      battery: "5/5 — 50 raqamining yangi qiymatini yuboring:",
    };
    await ctx.reply(prompts[field]);
  });

  bot.onText(/[\s\S]+/, async (ctx) => {
    if (ctx.chat?.type !== "private" || ctx.text.startsWith("/")) return;
    const userId = ctx.from?.id ?? ctx.chat.id;
    let session = sessions.get(userId);
    const startedByText = !session;
    if (!session) {
      session = resetSession(userId);
    }

    try {
      const value = ctx.text.trim();
      if (startedByText) {
        session.quantity = validateField("1-yozuv", value);
        session.step = null;
        await sendEditedImage(bot, ctx, session);
      } else if (session.step === "quantity") {
        session.quantity = validateField("1-yozuv", value);
        session.step = "productName";
        await ctx.reply("2/5 — Ikkinchi yozuvni yuboring:\nKatta Mahsulot");
      } else if (session.step === "productName") {
        session.productName = validateField("2-yozuv", value);
        session.step = "productCode";
        await ctx.reply("3/5 — Uchinchi yozuvni yuboring:\n1728");
      } else if (session.step === "productCode") {
        session.productCode = validateField("3-yozuv", value);
        session.step = "time";
        await ctx.reply("4/5 — Vaqtni yuboring:\n1:42");
      } else if (session.step === "time") {
        session.time = validateField("4-yozuv", value);
        session.step = "battery";
        await ctx.reply("5/5 — Batareya foizini yuboring:\n50");
      } else if (session.step === "battery") {
        session.battery = validateField("5-yozuv", value);
        session.step = null;
        await sendEditedImage(bot, ctx, session);
      } else {
        session.pendingField = session.pendingField || null;
        if (session.pendingField) {
          const fieldName =
            session.pendingField === "quantity"
              ? "1-yozuv"
              : session.pendingField === "productName"
                ? "2-yozuv"
                : session.pendingField === "productCode"
                  ? "3-yozuv"
                  : session.pendingField === "time"
                    ? "4-yozuv"
                    : "5-yozuv";
          session[session.pendingField] = validateField(fieldName, value);
          session.pendingField = null;
          await sendEditedImage(bot, ctx, session);
        } else {
          await ctx.reply("O'zgartirish uchun quyidagi tugmalardan birini tanlang.", {
            reply_markup: editMenu(),
          });
        }
      }
    } catch (error) {
      if (error instanceof TitleInputError) {
        await ctx.reply(`❌ ${error.message}`);
        return;
      }
      console.error("Rasm sarlavhasini o'zgartirib bo'lmadi:", error.message);
      await ctx.reply("Rasmni tahrirlashda xato yuz berdi. Keyinroq urinib ko'ring.");
    }
  });
}

module.exports = registerImageTextEditor;
module.exports.replaceTemplateTitle = replaceTemplateTitle;
