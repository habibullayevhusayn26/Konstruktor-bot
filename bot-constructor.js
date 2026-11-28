const { MongoClient } = require("mongodb");
const { decoratePayload } = require("./bots/premium-emojis");

class BotConstructor {
  constructor(token, options = {}) {
    if (!token) {
      throw new Error("Telegram bot tokeni berilishi shart");
    }

    this.token = token;
    this.apiUrl = `https://api.telegram.org/bot${token}`;
    this.options = {
      pollingTimeout: options.pollingTimeout ?? 30,
      retryDelay: options.retryDelay ?? 2000,
      loadingDelay: options.loadingDelay ?? 700,
      loadingInterval: options.loadingInterval ?? 1100,
    };
    this.middlewares = [];
    this.commands = new Map();
    this.textHandlers = [];
    this.photoHandlers = [];
    this.documentHandlers = [];
    this.callbackHandlers = [];
    this.updateHandlers = new Map();
    this.running = false;
    this.mongoClient = null;
    this.db = null;
    this.premiumEmojiFallbackLogged = false;
  }

  use(middleware) {
    if (typeof middleware !== "function") {
      throw new TypeError("Middleware funksiya bo'lishi kerak");
    }
    this.middlewares.push(middleware);
    return this;
  }

  command(name, handler) {
    if (typeof name !== "string" || typeof handler !== "function") {
      throw new TypeError("Komanda nomi va handler funksiyasi kerak");
    }
    this.commands.set(name.replace(/^\/+/, "").toLowerCase(), handler);
    return this;
  }

  onText(pattern, handler) {
    if (!(pattern instanceof RegExp) && typeof pattern !== "string") {
      throw new TypeError("Matn uchun RegExp yoki qator berilishi kerak");
    }
    if (typeof handler !== "function") {
      throw new TypeError("Handler funksiya bo'lishi kerak");
    }
    this.textHandlers.push({
      pattern: typeof pattern === "string" ? new RegExp(pattern, "i") : pattern,
      handler,
    });
    return this;
  }

  onCallbackData(pattern, handler) {
    if (!(pattern instanceof RegExp) && typeof pattern !== "string") {
      throw new TypeError("Callback uchun RegExp yoki qator berilishi kerak");
    }
    if (typeof handler !== "function") {
      throw new TypeError("Handler funksiya bo'lishi kerak");
    }
    this.callbackHandlers.push({
      pattern: typeof pattern === "string" ? new RegExp(pattern, "i") : pattern,
      handler,
    });
    return this;
  }

  onPhoto(handler) {
    if (typeof handler !== "function") {
      throw new TypeError("Photo handler funksiya bo'lishi kerak");
    }
    this.photoHandlers.push(handler);
    return this;
  }

  onDocument(handler) {
    if (typeof handler !== "function") {
      throw new TypeError("Document handler funksiya bo'lishi kerak");
    }
    this.documentHandlers.push(handler);
    return this;
  }

  onUpdate(updateType, handler) {
    if (typeof updateType !== "string" || typeof handler !== "function") {
      throw new TypeError("Update turi va handler funksiya kerak");
    }
    const handlers = this.updateHandlers.get(updateType) || [];
    handlers.push(handler);
    this.updateHandlers.set(updateType, handlers);
    return this;
  }

  async api(method, payload = {}) {
    if (this.options.disablePremiumEmoji) {
      const plainPayload = { ...payload };
      if (plainPayload.reply_markup) {
        plainPayload.reply_markup = this._stripPremiumEmojiMarkup(plainPayload.reply_markup);
      }
      if (plainPayload.entities) {
        plainPayload.entities = plainPayload.entities.filter((entity) => entity.type !== "custom_emoji");
      }
      if (plainPayload.caption_entities) {
        plainPayload.caption_entities = plainPayload.caption_entities.filter((entity) => entity.type !== "custom_emoji");
      }
      return this._apiRequest(method, plainPayload);
    }
    const decorated = decoratePayload(method, payload);
    try {
      return await this._apiRequest(method, decorated.payload);
    } catch (error) {
      if (!decorated.changed || error.error_code !== 400) throw error;
      this._logPremiumEmojiFallback();
      return this._apiRequest(method, payload);
    }
  }

  async _apiRequest(method, payload) {
    const response = await fetch(`${this.apiUrl}/${method}`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(payload),
    });
    const data = await response.json();

    if (!response.ok || !data.ok) {
      const error = new Error(
        data.description || `Telegram API xatosi: ${response.status}`,
      );
      error.parameters = data.parameters;
      error.error_code = data.error_code || response.status;
      throw error;
    }
    return data.result;
  }

  _stripPremiumEmojiMarkup(markup) {
    if (!markup || typeof markup !== "object") return markup;
    const result = { ...markup };
    for (const field of ["inline_keyboard", "keyboard"]) {
      if (!Array.isArray(result[field])) continue;
      result[field] = result[field].map((row) =>
        Array.isArray(row)
          ? row.map((button) => {
              if (!button || typeof button !== "object") return button;
              const plain = { ...button };
              delete plain.icon_custom_emoji_id;
              return plain;
            })
          : row,
      );
    }
    return result;
  }

  _logPremiumEmojiFallback() {
    if (this.premiumEmojiFallbackLogged) return;
    this.premiumEmojiFallbackLogged = true;
    console.warn(
      "Telegram custom emoji ruxsat bermadi; xabar oddiy emoji bilan yuborildi.",
    );
  }

  async sendMessage(chatId, text, options = {}) {
    return this.api("sendMessage", { chat_id: chatId, text, ...options });
  }

  async sendPhoto(chatId, photo, filename, options = {}) {
    return this._sendFileUpload(
      "sendPhoto",
      "photo",
      "image/png",
      chatId,
      photo,
      filename,
      options,
    );
  }

  async sendDocument(chatId, document, filename, options = {}) {
    return this._sendFileUpload(
      "sendDocument",
      "document",
      "application/octet-stream",
      chatId,
      document,
      filename,
      options,
    );
  }

  async sendAudio(chatId, audio, filename, options = {}) {
    return this._sendFileUpload(
      "sendAudio",
      "audio",
      "audio/mpeg",
      chatId,
      audio,
      filename,
      options,
    );
  }

  async _sendFileUpload(method, field, mimeType, chatId, file, filename, options) {
    if (this.options.disablePremiumEmoji) {
      const plainOptions = { ...options };
      delete plainOptions.disablePremiumEmoji;
      if (plainOptions.reply_markup) {
        plainOptions.reply_markup = this._stripPremiumEmojiMarkup(plainOptions.reply_markup);
      }
      if (plainOptions.caption_entities) {
        plainOptions.caption_entities = plainOptions.caption_entities.filter((entity) => entity.type !== "custom_emoji");
      }
      options = plainOptions;
    }
    const decorated = decoratePayload(method, options);
    const upload = async (uploadOptions) => {
      const form = new FormData();
      form.set("chat_id", String(chatId));
      form.set(field, new Blob([file], { type: mimeType }), filename);
      const fields = { ...uploadOptions };
      if (fields.thumbnail) {
        form.set(
          "thumbnail",
          new Blob([fields.thumbnail], { type: "image/jpeg" }),
          "thumbnail.jpg",
        );
        delete fields.thumbnail;
      }
      for (const [key, value] of Object.entries(fields)) {
        form.set(key, typeof value === "string" ? value : JSON.stringify(value));
      }

      const response = await fetch(`${this.apiUrl}/${method}`, {
        method: "POST",
        body: form,
      });
      const data = await response.json();
      if (!response.ok || !data.ok) {
        const error = new Error(
          data.description || `Telegram API xatosi: ${response.status}`,
        );
        error.error_code = data.error_code || response.status;
        throw error;
      }
      return data.result;
    };

    try {
      return await upload(decorated.payload);
    } catch (error) {
      if (!decorated.changed || error.error_code !== 400) throw error;
      this._logPremiumEmojiFallback();
      return upload(options);
    }
  }

  async downloadFile(filePath) {
    const response = await fetch(
      `https://api.telegram.org/file/bot${this.token}/${filePath}`,
    );
    if (!response.ok) {
      throw new Error(`Telegram faylini yuklab bo'lmadi: ${response.status}`);
    }
    return Buffer.from(await response.arrayBuffer());
  }

  async editMessageText(chatId, messageId, text, options = {}) {
    return this.api("editMessageText", {
      chat_id: chatId,
      message_id: messageId,
      text,
      ...options,
    });
  }

  async answerCallbackQuery(callbackQueryId, options = {}) {
    return this.api("answerCallbackQuery", {
      callback_query_id: callbackQueryId,
      ...options,
    });
  }

  async connectDatabase(uri, options = {}) {
    if (!uri) {
      throw new Error("MONGODB_URI berilishi shart");
    }
    if (this.mongoClient) {
      throw new Error("MongoDB ulanishi allaqachon ochilgan");
    }

    const client = new MongoClient(uri, options.clientOptions);
    try {
      await client.connect();
      const database = client.db(
        options.dbName || process.env.MONGODB_DB || "telegram_bot",
      );
      await database.command({ ping: 1 });
      this.mongoClient = client;
      this.db = database;
      return database;
    } catch (error) {
      try {
        await client.close();
      } catch (closeError) {
        console.error("MongoDB ulanishini yopib bo'lmadi:", closeError.message);
      }
      throw error;
    }
  }

  collection(name) {
    if (!this.db) {
      throw new Error("Avval connectDatabase() orqali MongoDB'ga ulaning");
    }
    return this.db.collection(name);
  }

  async closeDatabase() {
    if (!this.mongoClient) return;
    const client = this.mongoClient;
    this.mongoClient = null;
    this.db = null;
    await client.close();
  }

  async _runWithLoading(handler, context, ...args) {
    const isPrivateChat =
      context.chat?.type === "private" && Boolean(context.from);
    const isChannelPost = Boolean(context.update?.channel_post);
    if (!isPrivateChat && !isChannelPost) {
      return handler(context, ...args);
    }

    let loadingMessage;
    let loadingChatId;
    let animation;
    let loadingRequest;
    let stopAnimation;
    const timer = setTimeout(() => {
      loadingChatId =
        context.loadingChatId || (isPrivateChat ? context.chat.id : null);
      if (loadingChatId === null || loadingChatId === undefined) return;
      loadingRequest = this.sendMessage(
        loadingChatId,
        `⏳ ${context.loadingText || "Amal bajarilmoqda"}`,
      )
        .then((message) => {
          loadingMessage = message;
          if (!message?.message_id) return;

          const animationState = {
            stopped: false,
            wake: null,
          };
          stopAnimation = () => {
            animationState.stopped = true;
            animationState.wake?.();
          };
          animation = this._animateLoading(
            loadingChatId,
            message.message_id,
            context.loadingText || "Amal bajarilmoqda",
            animationState,
          );
        })
        .catch((error) => {
          console.error("Loading xabarini ko'rsatib bo'lmadi:", error.message);
        });
    }, this.options.loadingDelay);

    try {
      return await handler(context, ...args);
    } finally {
      clearTimeout(timer);
      if (loadingRequest) {
        await loadingRequest;
        stopAnimation?.();
        await animation;
        if (loadingMessage?.message_id) {
          try {
            await this.api("deleteMessage", {
              chat_id: loadingChatId,
              message_id: loadingMessage.message_id,
            });
          } catch (error) {
            console.error("Loading xabarini o'chirib bo'lmadi:", error.message);
          }
        }
      }
    }
  }

  async _animateLoading(chatId, messageId, label, state) {
    const frames = ["", ".", "..", "..."];
    let frame = 0;
    while (!state.stopped) {
      await new Promise((resolve) => {
        const timer = setTimeout(() => {
          state.wake = null;
          resolve();
        }, this.options.loadingInterval);
        state.wake = () => {
          clearTimeout(timer);
          state.wake = null;
          resolve();
        };
      });
      if (state.stopped) return;

      try {
        await this.editMessageText(
          chatId,
          messageId,
          `⏳ ${label}${frames[frame]}`,
        );
      } catch (error) {
        console.error("Loading animatsiyasini yangilab bo'lmadi:", error.message);
        return;
      }
      frame = (frame + 1) % frames.length;
    }
  }

  async processUpdate(update) {
    const preCheckoutQuery = update.pre_checkout_query;
    if (preCheckoutQuery) {
      const context = {
        update,
        preCheckoutQuery,
        from: preCheckoutQuery.from,
        chat: { id: preCheckoutQuery.from.id, type: "private" },
        text: "",
        api: this.api.bind(this),
        reply: (text, options = {}) =>
          this.sendMessage(preCheckoutQuery.from.id, text, options),
        answerPreCheckout: (ok, errorMessage) =>
          this.api("answerPreCheckoutQuery", {
            pre_checkout_query_id: preCheckoutQuery.id,
            ok,
            ...(errorMessage ? { error_message: errorMessage } : {}),
          }),
      };

      for (const middleware of this.middlewares) {
        await this._runWithLoading(middleware, context);
        if (context.handled) return;
      }
      for (const handler of this.updateHandlers.get("pre_checkout_query") || []) {
        await this._runWithLoading(handler, context);
        if (context.handled) return;
      }
      return;
    }

    const callbackQuery = update.callback_query;
    if (callbackQuery) {
      const message = callbackQuery.message;
      const context = {
        update,
        callbackQuery,
        from: callbackQuery.from,
        chat: message?.chat,
        message,
        text: callbackQuery.data || "",
        api: this.api.bind(this),
        reply: (text, options = {}) =>
          this.sendMessage(message?.chat?.id, text, options),
        edit: (text, options = {}) =>
          this.editMessageText(
            message?.chat?.id,
            message?.message_id,
            text,
            options,
          ),
        answer: (options = {}) =>
          this.answerCallbackQuery(callbackQuery.id, options),
      };

      for (const middleware of this.middlewares) {
        await this._runWithLoading(middleware, context);
        if (context.handled) return;
      }

      for (const item of this.callbackHandlers) {
        item.pattern.lastIndex = 0;
        const match = item.pattern.exec(context.text);
        if (match) {
          await this._runWithLoading(item.handler, context, match);
          break;
        }
      }
      return;
    }

    const isChannelPost = Boolean(update.channel_post);
    const message = update.message || update.channel_post;
    if (!message) return;

    const context = {
      update,
      message,
      from: message.from,
      chat: message.chat,
      text: message.text || message.caption || "",
      api: this.api.bind(this),
      reply: (text, options = {}) => this.sendMessage(message.chat.id, text, options),
    };

    for (const middleware of this.middlewares) {
      await this._runWithLoading(middleware, context);
      if (context.handled) return;
    }

    if (message.successful_payment) {
      for (const handler of this.updateHandlers.get("successful_payment") || []) {
        await this._runWithLoading(handler, context);
        if (context.handled) return;
      }
      return;
    }

    if (isChannelPost) {
      for (const handler of this.updateHandlers.get("channel_post") || []) {
        await this._runWithLoading(handler, context);
      }
      return;
    }

    if (message.text?.startsWith("/")) {
      const commandText = message.text.slice(1).split(/\s+/)[0];
      const command = commandText.split("@")[0].toLowerCase();
      const handler = this.commands.get(command);
      if (handler) {
        await this._runWithLoading(handler, context);
        return;
      }
    }

    for (const handler of this.updateHandlers.get("message") || []) {
      await this._runWithLoading(handler, context);
      if (context.handled) return;
    }

    for (const item of this.textHandlers) {
      item.pattern.lastIndex = 0;
      const match = item.pattern.exec(context.text);
      if (match) {
        await this._runWithLoading(item.handler, context, match);
        return;
      }
    }

    if (message.photo?.length) {
      for (const handler of this.photoHandlers) {
        await this._runWithLoading(handler, context);
      }
      return;
    }

    if (message.document) {
      for (const handler of this.documentHandlers) {
        await this._runWithLoading(handler, context);
      }
    }
  }

  async launch() {
    if (this.running) return;
    this.running = true;
    let offset = 0;

    while (this.running) {
      try {
        const updates = await this.api("getUpdates", {
          offset,
          timeout: this.options.pollingTimeout,
          allowed_updates: [
            "message",
            "callback_query",
            "channel_post",
            "pre_checkout_query",
          ],
        });

        for (const update of updates) {
          if (!this.running) break;
          offset = update.update_id + 1;
          try {
            await this.processUpdate(update);
          } catch (error) {
            console.error(`Update ${update.update_id} bajarilmadi:`, error.message);
          }
        }
      } catch (error) {
        if (!this.running) break;
        console.error("Telegram polling xatosi:", error.message);
        await new Promise((resolve) =>
          setTimeout(resolve, this.options.retryDelay),
        );
      }
    }
  }

  stop() {
    this.running = false;
  }

  async setWebhook(url, options = {}) {
    return this.api("setWebhook", { url, ...options });
  }

  async deleteWebhook(dropPendingUpdates = false) {
    return this.api("deleteWebhook", {
      drop_pending_updates: dropPendingUpdates,
    });
  }
}

module.exports = { BotConstructor };
