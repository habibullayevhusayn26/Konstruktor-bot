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
  8: { label: "8%", ratio: 0.08 },
  10: { label: "10%", ratio: 0.1 },
  20: { label: "20%", ratio: 0.2 },
  30: { label: "30%", ratio: 0.3 },
};

const LEGACY_LOGO_SCALES = {
  small: "8",
  medium: "10",
  large: "20",
  xlarge: "30",
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
  logoScale = "10",
}) {
  if (!SHAPES[shape]) throw new Error("Logo shakli noto'g'ri.");
  const sizeOption = SIZES[size];
  if (!sizeOption) throw new Error("Rasm o'lchami noto'g'ri.");
  if (!POSITIONS[position]) throw new Error("Watermark joyi noto'g'ri.");
  const scaleOption = LOGO_SCALES[LEGACY_LOGO_SCALES[logoScale] || logoScale];
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
    return profile.templates.map((template) => ({
      ...template,
      logoScale: normalizeScale(template.logoScale),
    }));
  }
  if (!profile.logo) return [];
  return [{
    id: "default",
    name: "Asosiy",
    logo: profile.logo,
    shape: profile.shape || "original",
    size: profile.size || "original",
    position: profile.position || "topRight",
    logoScale: normalizeScale(profile.logoScale),
  }];
}

function normalizeScale(value) {
  const normalized = LEGACY_LOGO_SCALES[value] || String(value || "10");
  return LOGO_SCALES[normalized] ? normalized : "10";
}

function activeTemplate(profile, templates = getTemplates(profile)) {
  return templates.find((template) => template.id === profile.activeTemplateId) ||
    templates[0] ||
    null;
}

function mainMenu() {
  return {
    reply_markup: {
      keyboard: [[
        { text: "📚 Shablonlar" },
        { text: "🖨 Pechat bosish" },
      ]],
      resize_keyboard: true,
      is_persistent: true,
    },
  };
}

function templatesMenu(templates) {
  return {
    reply_markup: {
      inline_keyboard: [
        ...templates.map((template) => [{
          text: `🧩 ${template.name}`,
          callback_data: `wm:manage:${template.id}`,
        }]),
        [{ text: "➕ Yangi shablon", callback_data: "wm:new-template" }],
      ],
    },
  };
}

function templateMenu(template) {
  return {
    reply_markup: {
      inline_keyboard: [
        [{
          text: "🖼 Logoni yuklash / yangilash",
          callback_data: `wm:template-logo:${template.id}`,
        }],
        [{
          text: `🔷 Logo shakli: ${SHAPES[template.shape] || SHAPES.original}`,
          callback_data: `wm:template-shape:${template.id}`,
        }],
        [{
          text: `📏 Logo o'lchami: ${LOGO_SCALES[template.logoScale]?.label || LOGO_SCALES[10].label}`,
          callback_data: `wm:template-scale:${template.id}`,
        }],
        [{
          text: `📍 Joylashuvi: ${POSITIONS[template.position] || POSITIONS.topRight}`,
          callback_data: `wm:template-position:${template.id}`,
        }],
        [{
          text: "✏️ Shablon nomini o'zgartirish",
          callback_data: `wm:template-name:${template.id}`,
        }],
        [{ text: "⬅️ Shablonlarga qaytish", callback_data: "wm:templates" }],
      ],
    },
  };
}

function nextTemplateName(templates) {
  const numbers = templates
    .map((template) => template.name.match(/^Namuna\s*(\d+)$/i)?.[1])
    .filter(Boolean)
    .map(Number);
  return `Namuna${Math.max(0, ...numbers) + 1}`;
}

function optionKeyboard(templateId, type) {
  if (type === "shape") {
    return [[
      { text: "Asl holi", callback_data: `wm:set-shape:${templateId}:original` },
      { text: "Kvadrat", callback_data: `wm:set-shape:${templateId}:square` },
      { text: "Dumaloq", callback_data: `wm:set-shape:${templateId}:round` },
    ]];
  }
  if (type === "scale") {
    return [[8, 10, 20, 30].map((scale) => ({
      text: `${scale}%`,
      callback_data: `wm:set-scale:${templateId}:${scale}`,
    }))];
  }
  return [
    [
      { text: "Yuqori o'ng", callback_data: `wm:set-position:${templateId}:topRight` },
      { text: "Yuqori chap", callback_data: `wm:set-position:${templateId}:topLeft` },
    ],
    [{
      text: "Pastda, markazda",
      callback_data: `wm:set-position:${templateId}:bottomCenter`,
    }],
  ];
}

function updateTemplate(templates, templateId, changes) {
  return templates.map((template) =>
    template.id === templateId ? { ...template, ...changes } : template);
}

function templateById(templates, id) {
  return templates.find((template) => template.id === id);
}

function templateSettingsMarkup(templateId, type) {
  return {
    reply_markup: {
      inline_keyboard: optionKeyboard(templateId, type),
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

  const renderWatermark = async (ctx, userId, template, imageFileId) => {
    if (!template?.logo) {
      await ctx.reply("Tanlangan shablonda logo yo'q. Avval shablon ichida logo yuklang.");
      return;
    }
    try {
      const buffer = await downloadImage(bot, imageFileId);
      const result = await createWatermarkedImage({
        imageBuffer: buffer,
        logoBuffer: normalizeImageBuffer(template.logo),
        shape: template.shape || "original",
        size: template.size || "original",
        position: template.position || "topRight",
        logoScale: template.logoScale || "10",
      });
      await saveProfile(userId, { awaiting: null }, {
        pendingImageId: "",
        pendingTemplateId: "",
      });
      await bot.sendPhoto(ctx.chat.id, result, "watermarked.jpg", {
        caption: `✅ Pechat tayyor. Shablon: ${template.name}`,
      });
    } catch (error) {
      await ctx.reply(`❌ Rasmni qayta ishlab bo'lmadi: ${error.message}`);
    }
  };

  bot.command("start", async (ctx) => {
    await ctx.reply(
      "Watermark botga xush kelibsiz!\n\n" +
        "Shablonlarni boshqaring yoki rasmga pechat bosing.\n" +
        "Buyruqsiz yuborilgan rasm uchun shablon tanlash so'raladi.",
      mainMenu(),
    );
  });

  bot.onCallbackData(
    /^wm:[\w:-]+$/,
    async (ctx) => {
      await ctx.answer();
      const userId = ctx.from.id;
      const profile = (await getProfile(userId)) || {};
      const templates = getTemplates(profile);
      const selectedTemplate = activeTemplate(profile, templates);

      if (ctx.text === "wm:templates") {
        await ctx.edit("Shablonlar ro'yxati:", templatesMenu(templates));
        return;
      }

      if (ctx.text === "wm:new-template") {
        const id = randomUUID().replace(/-/g, "");
        await saveProfile(userId, {
          awaiting: "template-name",
          pendingTemplateId: id,
        });
        await ctx.edit("Yangi shablon nomini yuboring (1–40 belgi). Bekor qilish: /cancel");
        return;
      }

      const manageMatch = ctx.text.match(/^wm:(?:manage|select-template):([\w-]+)$/);
      if (manageMatch) {
        const template = templateById(templates, manageMatch[1]);
        if (!template) {
          await ctx.edit("Shablon topilmadi. Ro'yxatni yangilang.", templatesMenu(templates));
          return;
        }
        await saveProfile(userId, { templates }, { logo: "" });
        await ctx.edit(`⚙️ ${template.name} sozlamalari:`, templateMenu(template));
        return;
      }

      const renameMatch = ctx.text.match(/^wm:template-name:([\w-]+)$/);
      if (renameMatch) {
        const template = templateById(templates, renameMatch[1]);
        if (!template) {
          await ctx.edit("Shablon topilmadi.", templatesMenu(templates));
          return;
        }
        await saveProfile(userId, {
          awaiting: "template-rename",
          pendingTemplateId: template.id,
        });
        await ctx.edit(`“${template.name}” shabloni uchun yangi nom yuboring (1–40 belgi).`);
        return;
      }

      const logoMatch = ctx.text.match(/^wm:template-logo:([\w-]+)$/);
      if (logoMatch) {
        const template = templateById(templates, logoMatch[1]);
        if (!template) {
          await ctx.edit("Shablon topilmadi.", templatesMenu(templates));
          return;
        }
        await saveProfile(userId, {
          awaiting: "template-logo",
          pendingTemplateId: template.id,
          pendingTemplateName: template.name,
        });
        await ctx.edit(`🖼 ${template.name} uchun logo rasmini yuboring.`);
        return;
      }

      const submenuMatch = ctx.text.match(
        /^wm:template-(shape|scale|position):([\w-]+)$/,
      );
      if (submenuMatch) {
        const template = templateById(templates, submenuMatch[2]);
        if (!template) {
          await ctx.edit("Shablon topilmadi.", templatesMenu(templates));
          return;
        }
        const type = submenuMatch[1];
        const text = type === "shape"
          ? "Logo shaklini tanlang:"
          : type === "scale"
            ? "Logo o'lchamini tanlang:"
            : "Watermark joylashuvini tanlang:";
        await ctx.edit(text, templateSettingsMarkup(template.id, type));
        return;
      }

      const updateMatch = ctx.text.match(
        /^wm:set-(shape|scale|position):([\w-]+):([\w-]+)$/,
      );
      const legacyUpdateMatch = ctx.text.match(
        /^wm:set-(shape|logo-scale|position):(.+)$/,
      );
      const settingMatch = updateMatch || legacyUpdateMatch;
      if (settingMatch) {
        const type = settingMatch[1] === "logo-scale" ? "scale" : settingMatch[1];
        const templateId = updateMatch ? settingMatch[2] : selectedTemplate?.id;
        const value = updateMatch ? settingMatch[3] : settingMatch[2];
        const normalizedScale = LEGACY_LOGO_SCALES[value] || value;
        const validValue = type === "shape"
          ? Boolean(SHAPES[value])
          : type === "scale"
            ? Boolean(LOGO_SCALES[normalizedScale])
            : Boolean(POSITIONS[value]);
        const template = templateById(templates, templateId);
        if (!template || !validValue) return;
        const changes = type === "shape"
          ? { shape: value }
          : type === "scale"
            ? { logoScale: normalizedScale }
            : { position: value };
        const updatedTemplates = updateTemplate(templates, templateId, changes);
        const updatedTemplate = templateById(updatedTemplates, templateId);
        await saveProfile(userId, { templates: updatedTemplates }, { logo: "" });
        await ctx.edit(
          `✅ ${updatedTemplate.name} shabloni yangilandi.`,
          templateMenu(updatedTemplate),
        );
        return;
      }

      const printMatch = ctx.text.match(/^wm:print-template:([\w-]+)$/);
      if (printMatch) {
        const template = templateById(templates, printMatch[1]);
        if (!template?.logo) {
          await ctx.edit("Bu shablonda logo yo'q. Avval logoni yuklang.");
          return;
        }
        await saveProfile(userId, {
          awaiting: "image",
          pendingTemplateId: template.id,
        }, { pendingImageId: "" });
        await ctx.edit(`🖨 ${template.name} tanlandi. Pechat bosiladigan rasmni yuboring.`);
        return;
      }

      const useMatch = ctx.text.match(/^wm:use-template:([\w-]+)$/);
      if (useMatch) {
        const template = templateById(templates, useMatch[1]);
        if (!template || !profile.pendingImageId) {
          await ctx.edit("Shablon yoki kutilayotgan rasm topilmadi.");
          return;
        }
        await renderWatermark(ctx, userId, template, profile.pendingImageId);
        return;
      }

      if (ctx.text === "wm:logo") {
        const id = selectedTemplate?.id || randomUUID().replace(/-/g, "");
        await saveProfile(userId, {
          awaiting: "template-logo",
          pendingTemplateId: id,
          pendingTemplateName: selectedTemplate?.name || nextTemplateName(templates),
        });
        await ctx.edit("Logo rasmini yuboring. Bekor qilish: /cancel");
        return;
      }

      if (ctx.text === "wm:apply") {
        if (!selectedTemplate?.logo) {
          await ctx.edit("Avval shablon yarating va unga logo yuklang.");
          return;
        }
        await saveProfile(userId, {
          awaiting: "image",
          pendingTemplateId: selectedTemplate.id,
        }, { pendingImageId: "" });
        await ctx.edit("Pechat bosiladigan rasmni yuboring. Bekor qilish: /cancel");
      }
    },
  );

  bot.onUpdate("message", async (ctx) => {
    const userId = ctx.from?.id;
    if (!userId) return;
    const profile = await getProfile(userId);
    if (
      profile?.awaiting === "template-name" ||
      profile?.awaiting === "template-rename"
    ) {
      const name = ctx.message.text?.trim();
      if (!name || name.length > 40) {
        await ctx.reply("Shablon nomi 1–40 belgidan iborat bo'lsin. Qayta yuboring.");
        return;
      }
      const templates = getTemplates(profile);
      const duplicate = templates.find((template) =>
        template.id !== profile.pendingTemplateId &&
        template.name.toLowerCase() === name.toLowerCase());
      if (duplicate) {
        await ctx.reply("Bu nomdagi shablon bor. Boshqa nom tanlang.");
        return;
      }

      if (profile.awaiting === "template-name") {
        await saveProfile(userId, {
          awaiting: "template-logo",
          pendingTemplateName: name,
        });
        await ctx.reply(`🖼 “${name}” shabloni uchun logo rasmini yuboring.`);
        return;
      }

      const template = templateById(templates, profile.pendingTemplateId);
      if (!template) {
        await saveProfile(userId, { awaiting: null }, {
          pendingTemplateId: "",
        });
        await ctx.reply("Nomini o'zgartirmoqchi bo'lgan shablon topilmadi.");
        return;
      }
      const updatedTemplates = updateTemplate(templates, template.id, { name });
      const updatedTemplate = templateById(updatedTemplates, template.id);
      await saveProfile(userId, {
        templates: updatedTemplates,
        awaiting: null,
      }, { pendingTemplateId: "", logo: "" });
      await ctx.reply(
        `✅ Shablon nomi “${name}” qilib o'zgartirildi.`,
        templateMenu(updatedTemplate),
      );
      return;
    }

    const menuText = (ctx.message.text || "")
      .trim()
      .replace(/^[^\p{L}\p{N}]+/u, "")
      .toLowerCase();

    if (menuText === "shablonlar") {
      const templates = getTemplates(profile || {});
      await ctx.reply("Shablonlar ro'yxati:", templatesMenu(templates));
      return;
    }

    if (menuText === "pechat bosish") {
      const templates = getTemplates(profile || {});
      if (!templates.length) {
        await ctx.reply("Avval 📚 Shablonlar bo'limida yangi shablon yarating.");
        return;
      }
      await ctx.reply("Pechat bosiladigan shablonni tanlang:", {
        reply_markup: {
          inline_keyboard: templates.map((template) => [{
            text: `🖨 ${template.name}`,
            callback_data: `wm:print-template:${template.id}`,
          }]),
        },
      });
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
        const id = profile.pendingTemplateId ||
          activeTemplate(profile, templates)?.id ||
          randomUUID().replace(/-/g, "");
        const oldTemplate = templateById(templates, id);
        const template = {
          ...(oldTemplate || {}),
          id,
          name: oldTemplate?.name || profile.pendingTemplateName || "Namuna1",
          logo,
          shape: oldTemplate?.shape || "original",
          size: oldTemplate?.size || "original",
          position: oldTemplate?.position || "topRight",
          logoScale: oldTemplate?.logoScale || "10",
        };
        const updatedTemplates = oldTemplate
          ? updateTemplate(templates, id, template)
          : [...templates, template];
        await saveProfile(userId, {
          templates: updatedTemplates,
          activeTemplateId: id,
          awaiting: null,
        }, { pendingTemplateName: "", pendingTemplateId: "", logo: "" });
        await ctx.reply(
          `✅ ${template.name} shablonining logosi saqlandi. Sozlamalarni 📚 Shablonlar bo'limidan o'zgartiring.`,
          mainMenu(),
        );
      } catch (error) {
        await ctx.reply(`❌ Logo saqlanmadi: ${error.message}`);
      }
      return;
    }

    if (profile?.awaiting === "image") {
      const templates = getTemplates(profile);
      const template = templateById(templates, profile.pendingTemplateId) ||
        activeTemplate(profile, templates);
      if (!template) {
        await saveProfile(userId, { awaiting: null });
        await ctx.reply("Tanlangan shablon topilmadi. Qayta tanlang.");
      } else {
        await renderWatermark(ctx, userId, template, image.file_id);
      }
      return;
    }

    const templates = getTemplates(profile || {});
    if (!templates.length) {
      await ctx.reply("Avval 📚 Shablonlar bo'limida yangi shablon yarating.");
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
        pendingTemplateId: "",
        pendingTemplateName: "",
      });
      return true;
    },
  };
}

module.exports = registerWatermarkBot;
module.exports.createWatermarkedImage = createWatermarkedImage;
