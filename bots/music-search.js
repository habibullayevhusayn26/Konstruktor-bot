const JAMENDO_TRACKS_URL = "https://api.jamendo.com/v3.0/tracks/";
const MAX_RESULTS = 5;
const MAX_QUERY_LENGTH = 100;
const SEARCH_CACHE_TTL = 60 * 1000;
const SEARCH_SESSION_TTL = 10 * 60 * 1000;
const MAX_SEARCH_CACHE = 100;
const MAX_SEARCH_SESSIONS = 500;
const MAX_AUDIO_FILE_IDS = 500;
const searchYouTubeVideos = require("./youtube-search");

const searchCache = new Map();
const searchSessions = new Map();
const audioFileIds = new Map();
const audioRequests = new Map();

function isCommercialCreativeCommonsLicense(value) {
  if (typeof value !== "string") return false;
  try {
    const url = new URL(value);
    if (url.hostname !== "creativecommons.org" &&
        url.hostname !== "www.creativecommons.org") {
      return false;
    }
    return (
      /^\/licenses\/by(?:-sa|-nd)?\/\d+(?:\.\d+)?\/?$/i.test(url.pathname) ||
      /^\/publicdomain\/zero\/\d+(?:\.\d+)?\/?$/i.test(url.pathname)
    );
  } catch {
    return false;
  }
}

function jamendoAudioUrl(value) {
  if (typeof value !== "string") return null;
  try {
    const url = new URL(value);
    if (
      url.protocol !== "https:" ||
      !(url.hostname === "jamendo.com" || url.hostname.endsWith(".jamendo.com"))
    ) {
      return null;
    }
    return url.toString();
  } catch {
    return null;
  }
}

function normalizeTrack(track) {
  const audio = jamendoAudioUrl(track.audio);
  if (
    !track.id ||
    typeof track.name !== "string" ||
    typeof track.artist_name !== "string" ||
    !audio ||
    !isCommercialCreativeCommonsLicense(track.license_ccurl)
  ) {
    return null;
  }
  return {
    id: String(track.id),
    name: track.name.trim(),
    artist: track.artist_name.trim(),
    duration: Number(track.duration) || 0,
    audio,
    license: track.license_ccurl,
    shareUrl: typeof track.shareurl === "string" ? track.shareurl : "",
  };
}

function readCache(cache, key) {
  const entry = cache.get(key);
  if (!entry || entry.expiresAt <= Date.now()) {
    cache.delete(key);
    return null;
  }
  cache.delete(key);
  cache.set(key, entry);
  return entry.value;
}

function writeCache(cache, key, value, ttl, maxSize) {
  cache.delete(key);
  cache.set(key, { value, expiresAt: Date.now() + ttl });
  while (cache.size > maxSize) {
    cache.delete(cache.keys().next().value);
  }
}

function rememberAudioFileId(key, fileId) {
  audioFileIds.delete(key);
  audioFileIds.set(key, fileId);
  while (audioFileIds.size > MAX_AUDIO_FILE_IDS) {
    audioFileIds.delete(audioFileIds.keys().next().value);
  }
}

function clipText(value, maxLength) {
  const characters = Array.from(value || "");
  return characters.length > maxLength
    ? `${characters.slice(0, maxLength - 1).join("")}…`
    : characters.join("");
}

function formatDuration(seconds) {
  const minutes = Math.floor(seconds / 60);
  return `${minutes}:${String(seconds % 60).padStart(2, "0")}`;
}

function licenseLabel(url) {
  if (url.includes("/publicdomain/zero/")) return "CC0";
  const match = url.match(/\/licenses\/(by(?:-sa|-nd)?)\//i);
  return match ? `CC ${match[1].toUpperCase()}` : "Creative Commons";
}

async function searchJamendo(query, clientId, fetchImpl) {
  const cacheKey = `${clientId}:${query.toLowerCase()}`;
  const cached = readCache(searchCache, cacheKey);
  if (cached) return cached;

  const url = new URL(JAMENDO_TRACKS_URL);
  url.search = new URLSearchParams({
    client_id: clientId,
    format: "json",
    namesearch: query,
    limit: String(MAX_RESULTS),
    audioformat: "mp31",
  });
  const response = await fetchImpl(url, {
    signal: AbortSignal.timeout(5000),
  });
  if (!response.ok) {
    throw new Error(`Jamendo API HTTP ${response.status}`);
  }
  const payload = await response.json();
  if (payload.headers?.status === "failed") {
    throw new Error(payload.headers.error_message || "Jamendo API so'rovni rad etdi.");
  }
  if (!Array.isArray(payload.results)) {
    throw new Error("Jamendo API javobi noto'g'ri formatda.");
  }

  const tracks = payload.results
    .map(normalizeTrack)
    .filter(Boolean)
    .slice(0, MAX_RESULTS);
  writeCache(searchCache, cacheKey, tracks, SEARCH_CACHE_TTL, MAX_SEARCH_CACHE);
  return tracks;
}

function audioMetadata(track, botUsername) {
  return {
    title: clipText(track.name, 64),
    performer: clipText(track.artist, 64),
    caption: `👉 @${botUsername}`,
  };
}

async function getAudioFileId(bot, botId, track, chatId, botUsername) {
  const cacheKey = `${botId}:${track.id}`;
  const cachedFileId = audioFileIds.get(cacheKey);
  if (cachedFileId) {
    audioFileIds.delete(cacheKey);
    audioFileIds.set(cacheKey, cachedFileId);
    return { fileId: cachedFileId, alreadySent: false };
  }

  const pendingRequest = audioRequests.get(cacheKey);
  if (pendingRequest) {
    return { fileId: await pendingRequest, alreadySent: false };
  }

  const request = bot.api("sendAudio", {
    chat_id: chatId,
    audio: track.audio,
    ...audioMetadata(track, botUsername),
  }).then((message) => {
    const fileId = message.audio?.file_id;
    if (!fileId) {
      throw new Error("Telegram javobida audio file_id topilmadi.");
    }
    rememberAudioFileId(cacheKey, fileId);
    return fileId;
  });
  audioRequests.set(cacheKey, request);
  try {
    const fileId = await request;
    return { fileId, alreadySent: true };
  } finally {
    audioRequests.delete(cacheKey);
  }
}

function registerMusicSearchBot(bot, {
  doc,
  clientId = process.env.JAMENDO_CLIENT_ID,
  youtubeApiKey = process.env.YOUTUBE_API_KEY,
  fetchImpl = globalThis.fetch,
}) {
  bot.command("start", async (ctx) => {
    await ctx.reply(
      "🎵 Musiqa nomi yoki ijrochi nomini yozing.\n" +
        "Jamendo'dan ochiq litsenziyali MP3 yoki YouTube'dan rasmiy video havolalarini topaman.",
    );
  });

  bot.onCallbackData(/^music:play:(\d+)$/, async (ctx) => {
    await ctx.answer();
    const userId = ctx.from.id;
    const sessionKey = `${doc._id}:${userId}`;
    const session = readCache(searchSessions, sessionKey);
    const index = Number(ctx.text.split(":").at(-1));
    const track = session?.[index];
    if (!track || track.source !== "jamendo") {
      await ctx.reply("Qidiruv natijalari eskirgan. Musiqa nomini qayta yuboring.");
      return;
    }

    try {
      const { fileId, alreadySent } = await getAudioFileId(
        bot,
        doc._id,
        track,
        ctx.chat.id,
        doc.username,
      );
      if (!alreadySent) {
        await bot.api("sendAudio", {
          chat_id: ctx.chat.id,
          audio: fileId,
          ...audioMetadata(track, doc.username),
        });
      }
    } catch (error) {
      await ctx.reply(`❌ MP3 yuborilmadi: ${error.message}`);
    }
  });

  bot.onUpdate("message", async (ctx) => {
    const query = ctx.message.text?.trim();
    if (!query || query.startsWith("/")) return;
    if (query.length > MAX_QUERY_LENGTH) {
      await ctx.reply(`Qidiruv so'rovi ${MAX_QUERY_LENGTH} belgidan oshmasin.`);
      return;
    }
    try {
      const sources = [
        {
          id: "jamendo",
          name: "Jamendo",
          search: clientId
            ? searchJamendo(query, clientId, fetchImpl)
            : Promise.resolve([]),
        },
        {
          id: "youtube",
          name: "YouTube",
          search: youtubeApiKey
            ? searchYouTubeVideos(query, youtubeApiKey, fetchImpl)
            : Promise.resolve([]),
        },
      ];
      const outcomes = await Promise.allSettled(sources.map((source) => source.search));
      const results = [];
      outcomes.forEach((outcome, index) => {
        if (outcome.status === "rejected") {
          console.error(`${sources[index].name} qidiruvi bajarilmadi:`, outcome.reason.message);
          return;
        }
        results.push(...outcome.value.map((result) => ({
          ...result,
          source: sources[index].id,
        })));
      });
      if (!results.length) {
        await ctx.reply("Topilmadi, qayta urinib ko'ring.");
        return;
      }

      const sessionKey = `${doc._id}:${ctx.from.id}`;
      writeCache(
        searchSessions,
        sessionKey,
        results,
        SEARCH_SESSION_TTL,
        MAX_SEARCH_SESSIONS,
      );
      const description = results.map((result, index) =>
        result.source === "youtube"
          ? `${index + 1}. ▶️ ${result.title} — ${result.channel}`
          : `${index + 1}. 🎵 ${result.name} — ${result.artist}\n` +
            `⏱ ${formatDuration(result.duration)} · ${licenseLabel(result.license)}`
      ).join("\n\n");
      await ctx.reply(`🎵 Natijalar:\n\n${description}\n\nJamendo trekni tanlang yoki YouTube videosini oching:`, {
        reply_markup: {
          inline_keyboard: results.map((result, index) => [
            result.source === "youtube"
              ? {
                  text: `▶️ ${clipText(`${result.title} — ${result.channel}`, 60)}`,
                  url: result.url,
                }
              : {
                  text: `🎵 ${clipText(`${result.name} — ${result.artist}`, 60)}`,
                  callback_data: `music:play:${index}`,
                },
          ]),
        },
      });
    } catch (error) {
      console.error("Musiqa qidiruvi bajarilmadi:", error.message);
      await ctx.reply("Topilmadi, qayta urinib ko'ring.");
    }
  });

  return {};
}

module.exports = registerMusicSearchBot;
