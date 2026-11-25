const sharp = require("sharp");
const { randomUUID } = require("node:crypto");

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

function getTemplates(profile) {
  if (Array.isArray(profile.templates) && profile.templates.length) {
    return profile.templates;
  }
  if (!profile.logo) return [];
  return [{
    id: "default",
    name: "Asosiy",
    logo: profile.logo,
    shape: profile.shape || "original",
    size: profile.size || "original",
    position: profile.position || "topRight",
    logoScale: profile.logoScale || "medium",
  }];
}

function activeTemplate(profile, templates = getTemplates(profile)) {
  return templates.find((template) => template.id === profile.activeTemplateId) ||
    templates[0] ||
    null;
}

function panelTitle(profile) {
  const template = activeTemplate(profile);
  return template
    ? `Shablon: ${template.name}\nWatermark sozlamalari:`
    : "Watermark sozlamalari:";
}

function templateFields(template) {
  return {
    shape: template.shape || "original",
    size: template.size || "original",
    position: template.position || "topRight",
    logoScale: template.logoScale || "medium",
    activeTemplateId: template.id,
  };
}

function panel(profile) {
  const templates = getTemplates(profile);
  const selectedTemplate = activeTemplate(profile, templates);
  return {
    reply_markup: {
      inline_keyboard: [
        [{
          text: `📚 Shablonlar (${templates.length})`,
          callback_data: "wm:templates",
        }],
        [{ text: "➕ Logoni yuklash / almashtirish", callback_data: "wm:logo" }],
        [{
          text: `Logo shakli: ${SHAPES[selectedTemplate?.shape] || SHAPES.original}`,
          callback_data: "wm:shape",
        }],
        [{
          text: `Logo o'lchami: ${LOGO_SCALES[selectedTemplate?.logoScale]?.label || LOGO_SCALES.medium.label}`,
          callback_data: "wm:logo-scale",
        }],
        [{
          text: `Rasm o'lchami: ${SIZES[selectedTemplate?.size]?.label || SIZES.original.label}`,
          callback_data: "wm:size",
        }],
        [{
          text: `Joylashuvi: ${POSITIONS[selectedTemplate?.position] || POSITIONS.topRight}`,
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
        "Watermark shablonlarini yarating va har biriga alohida logo hamda sozlamalarni tanlang.\n" +
        "Buyruqsiz rasm yuborsangiz, qaysi shablonni ishlatishni so'rayman.",
      panel(profile),
    );
  });

  bot.onCallbackData(
    /^wm:(logo|shape|logo-scale|size|position|apply|templates|new-template|back|select-template:[\w-]+|use-template:[\w-]+|set-shape:(original|square|round)|set-logo-scale:(small|medium|large|xlarge)|set-size:(original|landscape|portrait|square|threeFour)|set-position:(topRight|topLeft|bottomCenter))$/,
    async (ctx) => {
      await ctx.answer();
      const userId = ctx.from.id;
      const profile = (await getProfile(userId)) || {};
      const templates = getTemplates(profile);
      const selectedTemplate = activeTemplate(profile, templates);

      if (ctx.text === "wm:templates") {
        await ctx.edit("Watermark shablonini tanlang yoki yangisini yarating:", {
          reply_markup: {
            inline_keyboard: [
              ...templates.map((template) => [{
                text: `${template.id === selectedTemplate?.id ? "✅ " : ""}${template.name}`,
                callback_data: `wm:select-template:${template.id}`,
              }]),
              [{ text: "➕ Yangi shablon yaratish", callback_data: "wm:new-template" }],
              [{ text: "⬅️ Sozlamalarga qaytish", callback_data: "wm:back" }],
            ],
          },
        });
        return;
      }

      if (ctx.text === "wm:new-template") {
        await saveProfile(userId, { awaiting: "template-name" });
        await ctx.edit("Yangi shablon nomini yuboring (1–40 belgi). Bekor qilish: /cancel");
        return;
      }

      if (ctx.text === "wm:back") {
        await ctx.edit(panelTitle(profile), panel(profile));
        return;
      }

      const selectTemplateMatch = ctx.text.match(/^wm:select-template:([\w-]+)$/);
      const useTemplateMatch = ctx.text.match(/^wm:use-template:([\w-]+)$/);
      const templateMatch = selectTemplateMatch || useTemplateMatch;
      if (templateMatch) {
        const template = templates.find((item) => item.id === templateMatch[1]);
        if (!template) {
          await ctx.edit("Shablon topilmadi. Ro'yxatni yangilang.", panel(profile));
          return;
        }
        await saveProfile(userId, {
          templates,
          ...templateFields(template),
        }, { logo: "" });
        if (selectTemplateMatch) {
          await ctx.edit(panelTitle({
            ...profile,
            ...templateFields(template),
          }), panel({
            ...profile,
            ...templateFields(template),
          }));
          return;
        }
        if (!profile.pendingImageId) {
          await ctx.edit("Tanlash uchun kutilayotgan rasm yo'q.", panel(profile));
          return;
        }
        try {
          const buffer = await downloadImage(bot, profile.pendingImageId);
          const result = await createWatermarkedImage({
            imageBuffer: buffer,
            logoBuffer: normalizeImageBuffer(template.logo),
            shape: template.shape || "original",
            size: template.size || "original",
            position: template.position || "topRight",
            logoScale: template.logoScale || "medium",
          });
          await saveProfile(userId, { awaiting: null }, { pendingImageId: "" });
          await bot.sendPhoto(ctx.chat.id, result, "watermarked.jpg", {
            caption: `✅ Watermark tayyor. Shablon: ${template.name}`,
          });
        } catch (error) {
          await ctx.reply(`❌ Rasmni qayta ishlab bo'lmadi: ${error.message}`);
        }
        return;
      }

      if (ctx.text === "wm:logo") {
        await saveProfile(userId, { awaiting: "logo" });
        await ctx.edit("Logo rasmini yuboring. Almashtirilgan logo profilingizda saqlanadi.");
        return;
      }

      if (ctx.text === "wm:apply") {
        if (!selectedTemplate?.logo) {
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
      const sizeMatch = ctx.text.match(
        /^wm:set-size:(original|landscape|portrait|square|threeFour)$/,
      );
      const logoScaleMatch = ctx.text.match(
        /^wm:set-logo-scale:(small|medium|large|xlarge)$/,
      );
      const positionMatch = ctx.text.match(
        /^wm:set-position:(topRight|topLeft|bottomCenter)$/,
      );
      const settingMatch = shapeMatch || sizeMatch || logoScaleMatch || positionMatch;
      if (settingMatch && selectedTemplate) {
        const changedTemplate = {
          ...selectedTemplate,
          ...(shapeMatch ? { shape: shapeMatch[1] } : {}),
          ...(logoScaleMatch ? { logoScale: logoScaleMatch[1] } : {}),
          ...(sizeMatch ? { size: sizeMatch[1] } : {}),
          ...(positionMatch ? { position: positionMatch[1] } : {}),
        };
        const changedTemplates = templates.map((template) =>
          template.id === changedTemplate.id ? changedTemplate : template);
        await saveProfile(userId, {
          templates: changedTemplates,
          ...templateFields(changedTemplate),
        });
      }

      const updatedProfile = {
        ...profile,
        ...(settingMatch && selectedTemplate ? {
          ...selectedTemplate,
          ...(shapeMatch ? { shape: shapeMatch[1] } : {}),
          ...(logoScaleMatch ? { logoScale: logoScaleMatch[1] } : {}),
          ...(sizeMatch ? { size: sizeMatch[1] } : {}),
          ...(positionMatch ? { position: positionMatch[1] } : {}),
          activeTemplateId: selectedTemplate.id,
        } : {}),
      };
      await ctx.edit(panelTitle(updatedProfile), panel(updatedProfile));
    },
  );

  bot.onUpdate("message", async (ctx) => {
    const userId = ctx.from?.id;
    if (!userId) return;
    const profile = await getProfile(userId);
    if (profile?.awaiting === "template-name") {
      const name = ctx.message.text?.trim();
      if (!name || name.length > 40) {
        await ctx.reply("Shablon nomi 1–40 belgidan iborat bo'lsin. Qayta yuboring.");
        return;
      }
      await saveProfile(userId, {
        awaiting: "template-logo",
        pendingTemplateName: name,
      });
      await ctx.reply(`“${name}” shabloni uchun logo rasmini yuboring.`);
      return;
    }

    const image = imageFromMessage(ctx.message);
    if (!image) return;

    if (profile?.awaiting === "logo" || profile?.awaiting === "template-logo") {
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
        const templates = getTemplates(profile);
        const selectedTemplate = activeTemplate(profile, templates);
        const isNewTemplate = profile.awaiting === "template-logo";
        const template = {
          ...(isNewTemplate ? {} : selectedTemplate || {}),
          id: isNewTemplate
            ? randomUUID().replace(/-/g, "")
            : selectedTemplate?.id || "default",
          name: isNewTemplate
            ? profile.pendingTemplateName
            : selectedTemplate?.name || "Asosiy",
          logo,
          shape: selectedTemplate?.shape || "original",
          size: selectedTemplate?.size || "original",
          position: selectedTemplate?.position || "topRight",
          logoScale: selectedTemplate?.logoScale || "medium",
        };
        const updatedTemplates = isNewTemplate || !selectedTemplate
          ? [...templates, template]
          : templates.map((item) => item.id === template.id ? template : item);
        await saveProfile(userId, {
          templates: updatedTemplates,
          ...templateFields(template),
          awaiting: null,
        }, { pendingTemplateName: "", logo: "" });
        await ctx.reply(`✅ “${template.name}” shablonining logosi saqlandi.`, panel({
          ...profile,
          templates: updatedTemplates,
          ...templateFields(template),
        }));
      } catch (error) {
        await ctx.reply(`❌ Logo saqlanmadi: ${error.message}`);
      }
      return;
    }

    const templates = getTemplates(profile || {});
    if (!templates.length) {
      await ctx.reply("Avval /start orqali watermark shabloni yarating va unga logo yuklang.");
      return;
    }

    if (profile?.awaiting === "image") {
      const template = activeTemplate(profile, templates);
      if (!template?.logo) {
        await saveProfile(userId, { awaiting: null });
        await ctx.reply("Tanlangan shablonda logo yo'q. /start orqali logo yuklang.");
        return;
      }
      try {
        const buffer = await downloadImage(bot, image.file_id);
        const result = await createWatermarkedImage({
          imageBuffer: buffer,
          logoBuffer: normalizeImageBuffer(template.logo),
          shape: template.shape || "original",
          size: template.size || "original",
          position: template.position || "topRight",
          logoScale: template.logoScale || "medium",
        });
        await saveProfile(userId, { awaiting: null });
        await bot.sendPhoto(ctx.chat.id, result, "watermarked.jpg", {
          caption: `✅ Watermark tayyor. Shablon: ${template.name}`,
        });
      } catch (error) {
        await ctx.reply(`❌ Rasmni qayta ishlab bo'lmadi: ${error.message}`);
      }
      return;
    }

    await saveProfile(userId, {
      awaiting: "template-selection",
      pendingImageId: image.file_id,
    });
    await ctx.reply("Rasmga qaysi watermark shablonini qo'yay?", {
      reply_markup: {
        inline_keyboard: templates.map((template) => [{
          text: template.name,
          callback_data: `wm:use-template:${template.id}`,
        }]),
      },
    });
  });

  return {
    cancelPending: async (ctx) => {
      const userId = ctx.from?.id;
      if (!userId) return false;
      const profile = await getProfile(userId);
      if (!profile?.awaiting) return false;
      await saveProfile(userId, { awaiting: null }, {
        pendingImageId: "",
        pendingTemplateName: "",
      });
      return true;
    },
  };
}

module.exports = registerWatermarkBot;
module.exports.createWatermarkedImage = createWatermarkedImage;
