const QRCode = require("qrcode");
const jsQR = require("jsqr");
const sharp = require("sharp");

async function createStyledQr(text) {
  return QRCode.toBuffer(text, {
    type: "png",
    width: 800,
    margin: 4,
    errorCorrectionLevel: "M",
    color: {
      dark: "#000000",
      light: "#FFFFFF",
    },
  });
}

async function decodeQrImage(image) {
  const variants = [
    sharp(image).ensureAlpha(),
    sharp(image).greyscale().normalise().ensureAlpha(),
    sharp(image).greyscale().normalise().threshold(128).ensureAlpha(),
  ];

  for (const pipeline of variants) {
    try {
      const { data, info } = await pipeline
        .ensureAlpha()
        .raw()
        .toBuffer({ resolveWithObject: true });
      const expected = info.width * info.height * 4;
      if (data.length !== expected) continue;
      const decoded = jsQR(
        new Uint8ClampedArray(data),
        info.width,
        info.height,
      );
      if (decoded) return decoded.data;
    } catch (error) {
      if (!/Malformed data passed to binarizer/i.test(error.message)) throw error;
    }
  }

  return null;
}

function registerQrGenerator(bot) {
  bot.command("start", async (ctx) => {
    await ctx.reply(
      bot.config.welcome ||
        "Matn yoki havola yuboring — QR-kod yarataman. QR-kodni rasm sifatida yuborsangiz, ichidagi matnni o'qiyman.",
    );
  });

  bot.onText(/[\s\S]+/, async (ctx) => {
    const text = ctx.text.trim();
    if (text.startsWith("/")) {
      await ctx.reply("QR yaratish uchun matn yoki havola yuboring.");
      return;
    }
    if (!text) {
      await ctx.reply("Bo'sh matndan QR-kod yaratib bo'lmaydi.");
      return;
    }
    if (text.length > 2000) {
      await ctx.reply("Matn 2000 belgidan oshmasin.");
      return;
    }

    try {
      const image = await createStyledQr(text);
      await bot.sendPhoto(ctx.chat.id, image, "qr-code.png", {
        caption: "Rangli QR-kodingiz tayyor.",
      });
    } catch (error) {
      console.error("QR-kod yaratib bo'lmadi:", error.message);
      await ctx.reply("QR-kod yaratishda xato yuz berdi. Boshqa matn yuboring.");
    }
  });

  bot.onPhoto(async (ctx) => {
    await scanTelegramImage(bot, ctx, ctx.message.photo[ctx.message.photo.length - 1].file_id);
  });

  bot.onDocument(async (ctx) => {
    const document = ctx.message.document;
    if (!document || !/^image\//i.test(document.mime_type || "") && !/\.(png|jpe?g|webp)$/i.test(document.file_name || "")) {
      await ctx.reply("Iltimos, QR-kodli PNG, JPG yoki WebP rasmini yuboring.");
      return;
    }
    await scanTelegramImage(bot, ctx, document.file_id);
  });

  async function scanTelegramImage(bot, ctx, fileId) {
    try {
      const file = await bot.api("getFile", { file_id: fileId });
      if (file.file_size && file.file_size > 10 * 1024 * 1024) {
        await ctx.reply("Rasm hajmi 10 MB dan kichik bo'lishi kerak.");
        return;
      }

      const image = await bot.downloadFile(file.file_path);
      if (image.length > 10 * 1024 * 1024) {
        await ctx.reply("Rasm hajmi 10 MB dan kichik bo'lishi kerak.");
        return;
      }
      const decoded = await decodeQrImage(image);
      if (!decoded) {
        await ctx.reply("Rasm ichidan QR-kod topilmadi.");
        return;
      }
      await ctx.reply(`QR-koddagi ma'lumot:\n${decoded.slice(0, 4000)}`);
    } catch (error) {
      console.error("QR-rasmni o'qib bo'lmadi:", error.message);
      await ctx.reply("Rasmni o'qishda xato. Boshqa QR-rasm yuborib ko'ring.");
    }
  }
}

module.exports = registerQrGenerator;
module.exports.createStyledQr = createStyledQr;
module.exports.decodeQrImage = decodeQrImage;
