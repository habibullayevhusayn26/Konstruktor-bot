const sharp = require("sharp");

const MAX_INPUT_FILE_SIZE = 20 * 1024 * 1024;
const MAX_OUTPUT_FILE_SIZE = 10 * 1024 * 1024;
const MAX_PIXELS = 16_000_000;
const LOGO_MAX_SIZE = 2 * 1024 * 1024;

const SHAPES = {
  original: "Asl holi",
  square: "Kvadrat",
  round: "Dumaloq",
};

const SIZES = {
  original: { label: "Asl holi" },
  landscape: { label: "16:9", width: 1280, height: 720 },
  portrait: { label: "9:16", width: 720, height: 1280 },
  square: { label: "Kvadrat", width: 1080, height: 1080 },
  threeFour: { label: "3:4", width: 900, height: 1200 },
};

const POSITIONS = {
  topRight: "Yuqori o'ng burchak",
  topLeft: "Yuqori chap burchak",
  bottomCenter: "Pastda, gorizontal markazda",
};

const LOGO_SCALES = {
  small: { label: "Kichik (10%)", ratio: 0.1 },
  medium: { label: "O'rtacha (15%)", ratio: 0.15 },
  large: { label: "Katta (22%)", ratio: 0.22 },
  xlarge: { label: "Juda katta (30%)", ratio: 0.3 },
};

const isImageDocument = (document) => {
  const fileName = document.file_name || "";
  return (
    document.mime_type?.startsWith("image/") ||
    /\.(png|jpe?g|webp|gif|bmp|tiff?)$/i.test(fileName)
  );
};

const imageFromMessage = (message) => {
  if (message.photo?.length) {
    return message.photo[message.photo.length - 1];
  }
  if (message.document && isImageDocument(message.document)) {
    return message.document;
  }
  return null;
};

function normalizeImageBuffer(value) {
  if (Buffer.isBuffer(value)) return value;
  if (value?.value && typeof value.value === "function") {
    return Buffer.from(value.value());
  }
  if (value?.buffer && Buffer.isBuffer(value.buffer)) {
    return value.buffer;
  }
  return Buffer.from(value);
}

async function downloadImage(bot, fileId) {
  const file = await bot.api("getFile", { file_id: fileId });
  if (file.file_size && file.file_size > MAX_INPUT_FILE_SIZE) {
    throw new Error("Kirish rasmi hajmi 20 MB dan oshmasin.");
  }
  const buffer = await bot.downloadFile(file.file_path);
  if (buffer.length > MAX_INPUT_FILE_SIZE) {
    throw new Error("Kirish rasmi hajmi 20 MB dan oshmasin.");
  }
  const metadata = await sharp(buffer, { limitInputPixels: MAX_PIXELS }).metadata();
  if (!metadata.width || !metadata.height) {
    throw new Error("Rasm o'lchamini aniqlab bo'lmadi.");
  }
  return buffer;
}

async function makeLogo(buffer, shape, maxWidth, maxHeight) {
  const source = sharp(buffer, { limitInputPixels: MAX_PIXELS }).rotate();
  let logo;
  if (shape === "original") {
    logo = await source
      .resize({
        width: maxWidth,
        height: maxHeight,
        fit: "inside",
        withoutEnlargement: true,
      })
      .png()
      .toBuffer();
  } else {
    const side = Math.max(1, Math.min(maxWidth, maxHeight));
    const square = await source
      .resize(side, side, { fit: "cover", position: "centre" })
      .ensureAlpha()
      .png()
      .toBuffer();

    if (shape === "square") {
      logo = square;
    } else {
      const circleMask = Buffer.from(
        `<svg xmlns="http://www.w3.org/2000/svg" width="${side}" height="${side}">` +
          `<circle cx="${side / 2}" cy="${side / 2}" r="${side / 2}" fill="#fff"/>` +
          "</svg>",
      );
      logo = await sharp(square)
        .composite([{ input: circleMask, blend: "dest-in" }])
        .png()
        .toBuffer();
    }
  }

  const { data, info } = await sharp(logo)
    .ensureAlpha()
    .raw()
    .toBuffer({ resolveWithObject: true });
  for (let index = 3; index < data.length; index += info.channels) {
    data[index] = Math.round(data[index] * 0.72);
  }
  return sharp(data, { raw: info }).png().toBuffer();
}

async function createWatermarkedImage({
  imageBuffer,
  logoBuffer,
  shape = "original",
  size = "original",
  position = "topRight",
  logoScale = "medium",
}) {
  if (!SHAPES[shape]) throw new Error("Logo shakli noto'g'ri.");
  const sizeOption = SIZES[size];
  if (!sizeOption) throw new Error("Rasm o'lchami noto'g'ri.");
  if (!POSITIONS[position]) throw new Error("Watermark joyi noto'g'ri.");
  const scaleOption = LOGO_SCALES[logoScale];
  if (!scaleOption) throw new Error("Logo o'lchami noto'g'ri.");

  const source = sharp(imageBuffer, { limitInputPixels: MAX_PIXELS }).rotate();
  const prepared = sizeOption.width
    ? source.resize(sizeOption.width, sizeOption.height, {
        fit: "cover",
        position: sharp.strategy.attention,
      })
    : source;
  const { data: baseImage, info } = await prepared
    .flatten({ background: "#ffffff" })
    .jpeg({ quality: 90, mozjpeg: true })
    .toBuffer({ resolveWithObject: true });

  const maxSide = Math.max(
    1,
    Math.round(Math.min(info.width, info.height) * scaleOption.ratio),
  );
  const watermark = await makeLogo(
    normalizeImageBuffer(logoBuffer),
    shape,
    maxSide,
    maxSide,
  );
  const logoInfo = await sharp(watermark).metadata();
  const padding = Math.max(12, Math.round(Math.min(info.width, info.height) * 0.035));
  let left;
  let top;

  if (position === "topLeft") {
    left = padding;
    top = padding;
  } else if (position === "bottomCenter") {
    left = Math.round((info.width - logoInfo.width) / 2);
    top = info.height - logoInfo.height - padding;
  } else {
    left = info.width - logoInfo.width - padding;
    top = padding;
  }

  const output = await sharp(baseImage)
    .composite([{ input: watermark, left, top }])
    .jpeg({ quality: 90, mozjpeg: true })
    .toBuffer();
  if (output.length > MAX_OUTPUT_FILE_SIZE) {
    throw new Error("Tayyor rasm hajmi 10 MB dan oshdi.");
  }
  return output;
}

function panel(profile) {
  return {
    reply_markup: {
      inline_keyboard: [
        [{ text: "➕ Logoni yuklash / almashtirish", callback_data: "wm:logo" }],
        [{
          text: `Logo shakli: ${SHAPES[profile.shape] || SHAPES.original}`,
          callback_data: "wm:shape",
        }],
        [{
          text: `Logo o'lchami: ${LOGO_SCALES[profile.logoScale]?.label || LOGO_SCALES.medium.label}`,
          callback_data: "wm:logo-scale",
        }],
        [{
          text: `Rasm o'lchami: ${SIZES[profile.size]?.label || SIZES.original.label}`,
          callback_data: "wm:size",
        }],
        [{
          text: `Joylashuvi: ${POSITIONS[profile.position] || POSITIONS.topRight}`,
          callback_data: "wm:position",
        }],
        [{ text: "🖼 Rasmga watermark qo'yish", callback_data: "wm:apply" }],
      ],
    },
  };
}

function registerWatermarkBot(bot, { doc, WatermarkProfiles }) {
  const getProfile = (userId) =>
    WatermarkProfiles.findOne({ botId: doc._id, userId });
  const saveProfile = (userId, fields, unset) => {
    const update = {
      $set: { ...fields, updatedAt: new Date() },
      $setOnInsert: { botId: doc._id, userId, createdAt: new Date() },
    };
    if (unset) update.$unset = unset;
    return WatermarkProfiles.updateOne(
      { botId: doc._id, userId },
      update,
      { upsert: true },
    );
  };

  bot.command("start", async (ctx) => {
    const profile = (await getProfile(ctx.from.id)) || {};
    await ctx.reply(
      "Watermark botga xush kelibsiz!\n\n" +
        "1) O'z logotipingizni yuklang\n" +
        "2) Logo shakli, rasm o'lchami va joylashuvini tanlang\n" +
        "3) Watermark qo'yiladigan rasmni yuboring",
      panel(profile),
    );
  });

  bot.onCallbackData(
    /^wm:(logo|shape|logo-scale|size|position|apply|set-shape:(original|square|round)|set-logo-scale:(small|medium|large|xlarge)|set-size:(original|landscape|portrait|square|threeFour)|set-position:(topRight|topLeft|bottomCenter))$/,
    async (ctx) => {
      await ctx.answer();
      const userId = ctx.from.id;
      const profile = (await getProfile(userId)) || {};

      if (ctx.text === "wm:logo") {
        await saveProfile(userId, { awaiting: "logo" });
        await ctx.edit("Logo rasmini yuboring. Almashtirilgan logo profilingizda saqlanadi.");
        return;
      }

      if (ctx.text === "wm:apply") {
        if (!profile.logo) {
          await ctx.edit("Avval logotipingizni yuklang.", panel(profile));
          return;
        }
        await saveProfile(userId, { awaiting: "image" });
        await ctx.edit("Watermark qo'yiladigan rasmni yuboring. Bekor qilish: /cancel");
        return;
      }

      if (ctx.text === "wm:shape") {
        await ctx.edit("Logo shaklini tanlang:", {
          reply_markup: {
            inline_keyboard: [[
              { text: "Asl holi", callback_data: "wm:set-shape:original" },
              { text: "Kvadrat", callback_data: "wm:set-shape:square" },
              { text: "Dumaloq", callback_data: "wm:set-shape:round" },
            ]],
          },
        });
        return;
      }

      if (ctx.text === "wm:logo-scale") {
        await ctx.edit("Watermark logo o'lchamini tanlang:", {
          reply_markup: {
            inline_keyboard: [
              [
                { text: "Kichik 10%", callback_data: "wm:set-logo-scale:small" },
                { text: "O'rtacha 15%", callback_data: "wm:set-logo-scale:medium" },
              ],
              [
                { text: "Katta 22%", callback_data: "wm:set-logo-scale:large" },
                { text: "Juda katta 30%", callback_data: "wm:set-logo-scale:xlarge" },
              ],
            ],
          },
        });
        return;
      }

      if (ctx.text === "wm:size") {
        await ctx.edit("Tayyor rasm o'lchamini tanlang:", {
          reply_markup: {
            inline_keyboard: [
              [
                { text: "Asl holi", callback_data: "wm:set-size:original" },
                { text: "16:9", callback_data: "wm:set-size:landscape" },
              ],
              [
                { text: "9:16", callback_data: "wm:set-size:portrait" },
                { text: "Kvadrat", callback_data: "wm:set-size:square" },
              ],
              [{ text: "3:4", callback_data: "wm:set-size:threeFour" }],
            ],
          },
        });
        return;
      }

      if (ctx.text === "wm:position") {
        await ctx.edit("Watermark joyini tanlang:", {
          reply_markup: {
            inline_keyboard: [
              [
                { text: "Yuqori o'ng", callback_data: "wm:set-position:topRight" },
                { text: "Yuqori chap", callback_data: "wm:set-position:topLeft" },
              ],
              [{ text: "Pastda, markazda", callback_data: "wm:set-position:bottomCenter" }],
            ],
          },
        });
        return;
      }

      const shapeMatch = ctx.text.match(/^wm:set-shape:(original|square|round)$/);
      if (shapeMatch) {
        await saveProfile(userId, { shape: shapeMatch[1] });
      }
      const sizeMatch = ctx.text.match(
        /^wm:set-size:(original|landscape|portrait|square|threeFour)$/,
      );
      if (sizeMatch) {
        await saveProfile(userId, { size: sizeMatch[1] });
      }
      const logoScaleMatch = ctx.text.match(
        /^wm:set-logo-scale:(small|medium|large|xlarge)$/,
      );
      if (logoScaleMatch) {
        await saveProfile(userId, { logoScale: logoScaleMatch[1] });
      }
      const positionMatch = ctx.text.match(
        /^wm:set-position:(topRight|topLeft|bottomCenter)$/,
      );
      if (positionMatch) {
        await saveProfile(userId, { position: positionMatch[1] });
      }

      await ctx.edit("Watermark sozlamalari:", panel({
        ...profile,
        ...(shapeMatch ? { shape: shapeMatch[1] } : {}),
        ...(logoScaleMatch ? { logoScale: logoScaleMatch[1] } : {}),
        ...(sizeMatch ? { size: sizeMatch[1] } : {}),
        ...(positionMatch ? { position: positionMatch[1] } : {}),
      }));
    },
  );

  bot.onUpdate("message", async (ctx) => {
    const userId = ctx.from?.id;
    if (!userId) return;
    const profile = await getProfile(userId);
    const image = imageFromMessage(ctx.message);
    if (!image) return;

    if (profile?.awaiting === "logo") {
      try {
        const buffer = await downloadImage(bot, image.file_id);
        const logo = await sharp(buffer, { limitInputPixels: MAX_PIXELS })
          .rotate()
          .resize(512, 512, { fit: "inside", withoutEnlargement: true })
          .webp({ quality: 85, effort: 4 })
          .toBuffer();
        if (logo.length > LOGO_MAX_SIZE) {
          throw new Error("Logo faylini kichraytirib bo'lmadi. Boshqa rasm yuboring.");
        }
        await saveProfile(userId, { logo, awaiting: null });
        await ctx.reply("✅ Logo saqlandi. Shakli, o'lchami va joylashuvini tanlang:", panel({
          ...profile,
          logo,
        }));
      } catch (error) {
        await ctx.reply(`❌ Logo saqlanmadi: ${error.message}`);
      }
      return;
    }

    if (profile?.awaiting !== "image") {
      await ctx.reply("Rasmga watermark qo'yish uchun /start bosing va avval logo hamda sozlamalarni tanlang.");
      return;
    }
    if (!profile.logo) {
      await saveProfile(userId, { awaiting: null });
      await ctx.reply("Avval logotipingizni yuklang. /start bosing.");
      return;
    }

    try {
      const buffer = await downloadImage(bot, image.file_id);
      const result = await createWatermarkedImage({
        imageBuffer: buffer,
        logoBuffer: normalizeImageBuffer(profile.logo),
        shape: profile.shape || "original",
        size: profile.size || "original",
        position: profile.position || "topRight",
        logoScale: profile.logoScale || "medium",
      });
      await saveProfile(userId, { awaiting: null });
      await bot.sendPhoto(ctx.chat.id, result, "watermarked.jpg", {
        caption: "✅ Watermark tayyor.",
      });
    } catch (error) {
      await ctx.reply(`❌ Rasmni qayta ishlab bo'lmadi: ${error.message}`);
    }
  });

  return {
    cancelPending: async (ctx) => {
      const userId = ctx.from?.id;
      if (!userId) return false;
      const profile = await getProfile(userId);
      if (!profile?.awaiting) return false;
      await saveProfile(userId, { awaiting: null });
      return true;
    },
  };
}

module.exports = registerWatermarkBot;
module.exports.createWatermarkedImage = createWatermarkedImage;
