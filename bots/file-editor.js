const fs = require("node:fs/promises");
const os = require("node:os");
const path = require("node:path");
const { spawn } = require("node:child_process");
const ffmpegPath = require("ffmpeg-static") || "ffmpeg";
const NodeID3 = require("node-id3");
const sharp = require("sharp");

const MAX_FILE_SIZE = 20 * 1024 * 1024;
const MAX_IMAGE_SIZE = 10 * 1024 * 1024;
const MAX_THUMBNAIL_SIZE = 200 * 1024;
const SESSION_TTL = 15 * 60 * 1000;
const MAX_ACTIVE_SESSIONS = 10;
const activeSessions = new Set();

function mediaFromMessage(message) {
  if (message.document) return message.document;
  if (message.audio) return message.audio;
  if (message.video) return message.video;
  if (message.animation) return message.animation;
  if (message.voice) return message.voice;
  if (message.video_note) return message.video_note;
  if (message.photo?.length) return message.photo.at(-1);
  return null;
}

function isMp3(_media, _filename, buffer) {
  if (!Buffer.isBuffer(buffer)) return false;
  if (buffer.subarray(0, 3).toString("ascii") === "ID3") return true;

  const first = buffer[0];
  const second = buffer[1];
  const third = buffer[2];
  if (first === undefined || second === undefined || third === undefined) return false;

  const version = (second >> 3) & 0b11;
  const layer = (second >> 1) & 0b11;
  const bitrateIndex = (third >> 4) & 0b1111;
  return (
    first === 0xff &&
    (second & 0b11100000) === 0b11100000 &&
    version !== 0b10 &&
    layer !== 0 &&
    bitrateIndex !== 0 &&
    bitrateIndex !== 0b1111
  );
}

function mp3Filename(filename) {
  const basename = path.posix.basename(filename.replace(/\\/g, "/"));
  const stem = basename.replace(/\.[^.]*$/, "") || "audio";
  return `${stem}.mp3`;
}

function isAudioFile(media, message, filename) {
  const mimeType = media.mime_type?.split(";")[0].trim().toLowerCase();
  return (
    Boolean(message.audio || message.voice) ||
    Boolean(mimeType?.startsWith("audio/")) ||
    /\.(mp3|m4a|aac|wav|flac|ogg|opus|wma|aiff?|ape)$/i.test(filename)
  );
}

function transcodeToMp3(inputPath, outputPath) {
  return new Promise((resolve, reject) => {
    const child = spawn(
      ffmpegPath,
      [
        "-nostdin",
        "-hide_banner",
        "-loglevel",
        "error",
        "-y",
        "-i",
        inputPath,
        "-map",
        "0:a:0",
        "-vn",
        "-map_metadata",
        "0",
        "-codec:a",
        "libmp3lame",
        "-q:a",
        "2",
        "-id3v2_version",
        "3",
        outputPath,
      ],
      { windowsHide: true, stdio: ["ignore", "ignore", "pipe"] },
    );
    let stderr = "";
    child.stderr.setEncoding("utf8");
    child.stderr.on("data", (chunk) => {
      stderr = `${stderr}${chunk}`.slice(-1000);
    });
    child.once("error", reject);
    child.once("close", (code) => {
      if (code === 0) {
        resolve();
      } else {
        reject(
          new Error(
            `Audio MP3 formatiga aylantirilmadi.${stderr ? ` ${stderr.trim()}` : ""}`,
          ),
        );
      }
    });
  });
}

function safeFilename(input, originalName, mp3) {
  let name = input.trim();
  if (!name || name.length > 180 || /[\\/\0-\x1f<>:"|?*]/.test(name)) {
    throw new Error("Fayl nomi 1–180 belgi bo'lsin va / \\ kabi belgilarni ishlatmang.");
  }
  const originalExtension = path.extname(originalName);
  if (!path.extname(name) && originalExtension) name += originalExtension;
  if (mp3 && path.extname(name).toLowerCase() !== ".mp3") {
    throw new Error("MP3 fayl kengaytmasi .mp3 bo'lib qolishi kerak.");
  }
  return name;
}

async function prepareThumbnail(buffer) {
  if (!Buffer.isBuffer(buffer) || buffer.length > MAX_IMAGE_SIZE) {
    throw new Error("Muqova rasmi 10 MB dan kichik bo'lishi kerak.");
  }
  const source = sharp(buffer, { limitInputPixels: 16_000_000 }).rotate();
  for (const quality of [85, 75, 65, 55]) {
    const thumbnail = await source
      .clone()
      .resize(320, 320, { fit: "inside", withoutEnlargement: true })
      .jpeg({ quality, mozjpeg: true })
      .toBuffer();
    if (thumbnail.length <= MAX_THUMBNAIL_SIZE) return thumbnail;
  }
  throw new Error("Rasmni Telegram thumbnail o'lchamigacha kichraytirib bo'lmadi.");
}

function updateMp3Buffer(buffer, { title, artist, cover }) {
  const tags = {};
  if (title !== undefined) tags.title = title;
  if (artist !== undefined) tags.artist = artist;
  if (cover) {
    tags.image = {
      mime: "image/jpeg",
      type: { id: 3, name: "front cover" },
      description: "Cover",
      imageBuffer: cover,
    };
  }
  if (!Object.keys(tags).length) return buffer;
  const updated = NodeID3.update(tags, buffer);
  if (!Buffer.isBuffer(updated)) {
    throw new Error("MP3 teglarini saqlab bo'lmadi.");
  }
  return updated;
}

function menu(session) {
  const rows = [
    [
      { text: "✏️ Fayl nomi", callback_data: "file:rename" },
      { text: "🖼 Fayl rasmi", callback_data: "file:thumbnail" },
    ],
  ];
  if (session.isMp3) {
    rows.push([
      { text: "🎤 Ijrochi", callback_data: "file:artist" },
      { text: "🎵 Musiqa nomi", callback_data: "file:title" },
    ]);
  }
  rows.push([{ text: "✅ Tayyor faylni olish", callback_data: "file:send" }]);
  rows.push([{ text: "🗑 Bekor qilish", callback_data: "file:cancel" }]);
  return { reply_markup: { inline_keyboard: rows } };
}

async function cleanupSession(sessions, userId) {
  const session = sessions.get(userId);
  if (!session) return;
  sessions.delete(userId);
  activeSessions.delete(session);
  clearTimeout(session.expiryTimer);
  for (const filePath of [
    session.filePath,
    session.thumbnailPath,
    session.convertedFilePath,
  ]) {
    if (!filePath) continue;
    try {
      await fs.unlink(filePath);
    } catch (error) {
      if (error.code !== "ENOENT") {
        console.error("Vaqtinchalik faylni o'chirib bo'lmadi:", error.message);
      }
    }
  }
  try {
    await fs.rmdir(session.directory);
  } catch (error) {
    if (error.code !== "ENOENT" && error.code !== "ENOTEMPTY") {
      console.error("Vaqtinchalik papkani o'chirib bo'lmadi:", error.message);
    }
  }
}

function refreshExpiry(sessions, userId, session) {
  clearTimeout(session.expiryTimer);
  session.expiryTimer = setTimeout(() => {
    cleanupSession(sessions, userId).catch((error) =>
      console.error("Fayl sessiyasini tozalab bo'lmadi:", error.message),
    );
  }, SESSION_TTL);
  session.expiryTimer.unref?.();
}

async function downloadTelegramFile(bot, media, maxSize) {
  if (media.file_size && media.file_size > maxSize) {
    throw new Error(`Fayl hajmi ${Math.floor(maxSize / 1024 / 1024)} MB dan oshmasin.`);
  }
  const file = await bot.api("getFile", { file_id: media.file_id });
  if (file.file_size && file.file_size > maxSize) {
    throw new Error(`Fayl hajmi ${Math.floor(maxSize / 1024 / 1024)} MB dan oshmasin.`);
  }
  const buffer = await bot.downloadFile(file.file_path);
  if (buffer.length > maxSize) {
    throw new Error(`Fayl hajmi ${Math.floor(maxSize / 1024 / 1024)} MB dan oshmasin.`);
  }
  return buffer;
}

function registerFileEditor(bot) {
  const sessions = new Map();
  const getImageBuffer = async (message) => {
    const image = message.photo?.at(-1) || message.document;
    if (!image) return null;
    return downloadTelegramFile(bot, image, MAX_IMAGE_SIZE);
  };

  bot.command("start", async (ctx) => {
    await ctx.reply(
      "Fayl tahrirlovchi botga xush kelibsiz!\n\n" +
        "Istalgan hujjat, rasm, video yoki audio fayl yuboring. Fayl nomi va " +
        "thumbnail rasmini o'zgartirishingiz mumkin. MP3 uchun ijrochi, " +
        "musiqa nomi va ichki cover ham tahrirlanadi. Boshqa audio formatlari " +
        "MP3 ga aylantiriladi.",
    );
  });

  bot.onCallbackData(
    /^file:(rename|thumbnail|artist|title|send|cancel)$/,
    async (ctx) => {
      await ctx.answer();
      const userId = ctx.from.id;
      const session = sessions.get(userId);
      if (!session) {
        await ctx.edit("Fayl sessiyasi tugagan. Yangi fayl yuboring.");
        return;
      }
      refreshExpiry(sessions, userId, session);

      switch (ctx.text) {
        case "file:rename":
          session.pending = "filename";
          await ctx.edit("Yangi fayl nomini yuboring (kengaytma yozmasangiz, eskisi saqlanadi).");
          return;
        case "file:thumbnail":
          session.pending = "thumbnail";
          await ctx.edit("Yangi rasm yuboring. U fayl thumbnail'i va MP3 bo'lsa ichki cover bo'ladi.");
          return;
        case "file:artist":
          if (!session.isMp3) break;
          session.pending = "artist";
          await ctx.edit("MP3 ijrochisining yangi nomini yuboring.");
          return;
        case "file:title":
          if (!session.isMp3) break;
          session.pending = "title";
          await ctx.edit("Musiqaning yangi nomini yuboring.");
          return;
        case "file:send":
          await sendEditedFile(bot, ctx, sessions, userId, session);
          return;
        case "file:cancel":
          await cleanupSession(sessions, userId);
          await ctx.edit("Fayl tahrirlash bekor qilindi.");
          return;
      }
      await ctx.edit("Bu amal tanlangan fayl uchun mavjud emas.", menu(session));
    },
  );

  bot.onUpdate("message", async (ctx) => {
    const userId = ctx.from?.id;
    if (!userId || ctx.chat?.type !== "private") return;
    const session = sessions.get(userId);
    const incoming = mediaFromMessage(ctx.message);

    if (session?.pending === "thumbnail" && incoming) {
      try {
        const image = await getImageBuffer(ctx.message);
        if (!image) {
          await ctx.reply("Thumbnail uchun rasm yoki rasm faylini yuboring.");
          ctx.handled = true;
          return;
        }
        const thumbnail = await prepareThumbnail(image);
        const thumbnailPath = path.join(session.directory, "thumbnail.jpg");
        await fs.writeFile(thumbnailPath, thumbnail);
        session.thumbnailPath = thumbnailPath;
        session.pending = null;
        refreshExpiry(sessions, userId, session);
        await ctx.reply("✅ Rasm saqlandi.", menu(session));
      } catch (error) {
        await ctx.reply(`❌ Rasm qabul qilinmadi: ${error.message}`);
      }
      ctx.handled = true;
      return;
    }

    if (incoming) {
      try {
        await cleanupSession(sessions, userId);
        if (activeSessions.size >= MAX_ACTIVE_SESSIONS) {
          throw new Error(
            "Hozir boshqa foydalanuvchilar fayllarni tahrirlayapti. Birozdan so'ng urinib ko'ring.",
          );
        }
        const reportedFilename =
          incoming.file_name ||
          (incoming.mime_type === "audio/mpeg" ? "audio.mp3" :
            incoming.mime_type?.startsWith("video/") ? "video.mp4" :
              incoming.mime_type?.startsWith("image/") || ctx.message.photo ? "image.jpg" :
                "file");
        const buffer = await downloadTelegramFile(bot, incoming, MAX_FILE_SIZE);
        const sourceIsMp3 = isMp3(incoming, reportedFilename, buffer);
        const convertToMp3 =
          !sourceIsMp3 && isAudioFile(incoming, ctx.message, reportedFilename);
        const mp3 = sourceIsMp3 || convertToMp3;
        const filename = mp3 ? mp3Filename(reportedFilename) : reportedFilename;
        const directory = await fs.mkdtemp(path.join(os.tmpdir(), "tg-file-editor-"));
        const filePath = path.join(directory, "source.bin");
        try {
          await fs.writeFile(filePath, buffer);
        } catch (error) {
          try {
            await fs.unlink(filePath);
          } catch (cleanupError) {
            if (cleanupError.code !== "ENOENT") {
              console.error("Yuklanmagan faylni tozalab bo'lmadi:", cleanupError.message);
            }
          }
          try {
            await fs.rmdir(directory);
          } catch (cleanupError) {
            if (cleanupError.code !== "ENOENT") {
              console.error("Bo'sh vaqtinchalik papkani o'chirib bo'lmadi:", cleanupError.message);
            }
          }
          throw error;
        }
        const newSession = {
          directory,
          filePath,
          filename,
          isMp3: mp3,
          convertToMp3,
          artist: undefined,
          title: undefined,
          thumbnailPath: null,
          pending: null,
        };
        sessions.set(userId, newSession);
        activeSessions.add(newSession);
        refreshExpiry(sessions, userId, newSession);
        await ctx.reply(
          `✅ Fayl qabul qilindi: ${filename}\n` +
            (newSession.isMp3
              ? "MP3 teglari va cover'ini ham o'zgartirishingiz mumkin."
              : "Nomini va thumbnail rasmini o'zgartirishingiz mumkin."),
          menu(newSession),
        );
      } catch (error) {
        await ctx.reply(`❌ Faylni qabul qilib bo'lmadi: ${error.message}`);
      }
      ctx.handled = true;
      return;
    }

    if (!session || !ctx.text) {
      if (ctx.text && !ctx.text.startsWith("/")) {
        await ctx.reply("Tahrirlash uchun avval fayl yuboring.");
        ctx.handled = true;
      }
      return;
    }

    if (!session.pending) {
      await ctx.reply("Fayl sozlamalarini tugmalardan tanlang.", menu(session));
      ctx.handled = true;
      return;
    }
    if (session.pending === "thumbnail") {
      await ctx.reply("Thumbnail uchun rasm yoki rasm faylini yuboring.");
      ctx.handled = true;
      return;
    }

    const value = ctx.text.trim();
    if (!value || value.length > 200) {
      await ctx.reply("Matn 1–200 belgi bo'lishi kerak.");
      ctx.handled = true;
      return;
    }
    if (session.pending === "filename") {
      try {
        session.filename = safeFilename(value, session.filename, session.isMp3);
      } catch (error) {
        await ctx.reply(`❌ ${error.message}`);
        ctx.handled = true;
        return;
      }
    } else if (session.pending === "artist") {
      session.artist = value;
    } else if (session.pending === "title") {
      session.title = value;
    }
    session.pending = null;
    refreshExpiry(sessions, userId, session);
    await ctx.reply("✅ Saqlandi.", menu(session));
    ctx.handled = true;
  });
}

async function sendEditedFile(bot, ctx, sessions, userId, session) {
  try {
    const original = await fs.readFile(session.filePath);
    let audioSource = original;
    if (session.convertToMp3) {
      session.convertedFilePath = path.join(session.directory, "converted.mp3");
      await transcodeToMp3(session.filePath, session.convertedFilePath);
      audioSource = await fs.readFile(session.convertedFilePath);
    }
    const cover = session.thumbnailPath
      ? await fs.readFile(session.thumbnailPath)
      : null;
    if (session.isMp3) {
      const audio = updateMp3Buffer(audioSource, {
        title: session.title,
        artist: session.artist,
        cover,
      });
      if (audio.length > MAX_FILE_SIZE) {
        throw new Error("Teglardan keyingi MP3 hajmi 20 MB dan oshdi.");
      }
      await bot.sendAudio(ctx.chat.id, audio, session.filename, {
        ...(session.title ? { title: session.title } : {}),
        ...(session.artist ? { performer: session.artist } : {}),
        ...(cover ? { thumbnail: cover } : {}),
        caption: "✅ MP3 fayli tahrirlandi.",
      });
    } else {
      await bot.sendDocument(ctx.chat.id, original, session.filename, {
        ...(cover ? { thumbnail: cover } : {}),
        caption: "✅ Fayl tayyor.",
      });
    }
    await cleanupSession(sessions, userId);
  } catch (error) {
    console.error("Faylni tahrirlab yuborib bo'lmadi:", error.message);
    await ctx.reply(`❌ Faylni yuborib bo'lmadi: ${error.message}`, menu(session));
  }
}

module.exports = registerFileEditor;
module.exports.isMp3 = isMp3;
module.exports.mp3Filename = mp3Filename;
module.exports.prepareThumbnail = prepareThumbnail;
module.exports.safeFilename = safeFilename;
module.exports.updateMp3Buffer = updateMp3Buffer;
