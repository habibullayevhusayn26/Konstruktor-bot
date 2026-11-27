const fs = require("node:fs/promises");
const path = require("node:path");

const BOT_TYPES = Object.freeze({
  smm: {
    label: "Nakrutka / SMM bot",
    description: "Obunachi, layk, ko'rish va boshqa ijtimoiy tarmoq xizmatlarini so'mda buyurtma qilish.",
    module: "smm-panel",
  },
  qr: {
    label: "QR generator / scanner",
    description: "Matn yoki havoladan QR kod yarating va yuborilgan rasmdagi QR kodni o'qing.",
    module: "qr-generator",
  },
  nickname: {
    label: "Nickname shrift generator",
    description: "Nikname uchun 17 xil yozuv uslubini yarating va natijani bir bosishda nusxalang.",
    module: "nickname-font",
  },
  footer: {
    label: "Kanal postiga matn qo'shish",
    description: "Tanlangan kanaldagi yangi postlarga sozlangan matn yoki havolani avtomatik qo'shing.",
    module: "channel-footer",
  },
  watermark: {
    label: "Watermark bot",
    description: "Logotip shakli va joyini tanlab, rasmlarga watermark qo'ying.",
    module: "watermark",
  },
  "file-editor": {
    label: "Fayl nomi va muqova tahrirlovchi",
    description: "Fayl nomi, muqovasi va MP3 musiqa ma'lumotlarini tahrirlang.",
    module: "file-editor",
  },
  "image-text": {
    label: "Rasm sarlavhasi tahrirlovchi",
    description: "Uzum shablonidagi O'tkazildi yozuvi ostiga aniq ma'lumotlarni qo'shing.",
    module: "image-text-editor",
  },
  guard: {
    label: "Telegram Qorovul Bot",
    description: "Guruhlarni captcha, spam filtri, flood nazorati, warn tizimi va shaxsiy admin panel orqali boshqaring.",
    runtime: "webhook",
  },
  "user-scheduler": {
    label: "User Bot — rejalashtirilgan postlar",
    description: "Telegram akkauntingizni QR orqali ulang va admin/egasi bo'lgan guruh-kanallaringizga postlarni jadval bilan yuboring.",
    module: "user-scheduler",
  },
});

const generatedDirectory = path.join(__dirname, "generated");

function generatedFilePath(botId) {
  const numericId = Number(botId);
  if (!Number.isSafeInteger(numericId) || numericId < 1) {
    throw new Error("Bot ID noto'g'ri.");
  }
  return path.join(generatedDirectory, `${numericId}.js`);
}

async function writeGeneratedBotFile(doc) {
  const botType = BOT_TYPES[doc.type];
  if (!botType) throw new Error("Noma'lum tayyor bot turi.");
  if (!botType.module) {
    throw new Error("Bu bot turi alohida runtime orqali ishga tushiriladi.");
  }

  const botId = Number(doc._id);
  const filePath = generatedFilePath(botId);
  const source = [
    '"use strict";',
    "module.exports = {",
    `  botId: ${botId},`,
    `  register: require("../${botType.module}"),`,
    "};",
    "",
  ].join("\n");

  await fs.mkdir(generatedDirectory, { recursive: true });
  await fs.writeFile(filePath, source, { encoding: "utf8", mode: 0o600 });
  return filePath;
}

async function removeGeneratedBotFile(botId) {
  const filePath = generatedFilePath(botId);
  try {
    await fs.unlink(filePath);
  } catch (error) {
    if (error.code !== "ENOENT") throw error;
  }
}

module.exports = {
  BOT_TYPES,
  generatedFilePath,
  removeGeneratedBotFile,
  writeGeneratedBotFile,
};
