"use strict";

const fs = require("node:fs");
const path = require("node:path");

const DEFAULT_GROUP = Object.freeze({
  welcomeText: "Xush kelibsiz, {name}!",
  captchaEnabled: true,
  captchaTimeoutSeconds: 60,
  floodLimit: 5,
  floodWindowSeconds: 10,
  muteSeconds: 300,
  bannedWords: [],
});

const GROUP_COLUMNS = Object.freeze({
  title: "title",
  welcomeText: "welcome_text",
  captchaEnabled: "captcha_enabled",
  captchaTimeoutSeconds: "captcha_timeout_seconds",
  floodLimit: "flood_limit",
  floodWindowSeconds: "flood_window_seconds",
  muteSeconds: "mute_seconds",
  bannedWords: "banned_words",
});

function mapGroup(row) {
  if (!row) return null;
  return {
    botId: row.bot_id,
    chatId: row.chat_id,
    title: row.title,
    ownerId: row.owner_id,
    welcomeText: row.welcome_text,
    captchaEnabled: Boolean(row.captcha_enabled),
    captchaTimeoutSeconds: row.captcha_timeout_seconds,
    floodLimit: row.flood_limit,
    floodWindowSeconds: row.flood_window_seconds,
    muteSeconds: row.mute_seconds,
    bannedWords: JSON.parse(row.banned_words),
  };
}

function mapSupabaseGroup(row) {
  if (!row) return null;
  return {
    botId: row.bot_id,
    chatId: row.chat_id,
    title: row.title,
    ownerId: row.owner_id,
    welcomeText: row.welcome_text,
    captchaEnabled: row.captcha_enabled,
    captchaTimeoutSeconds: row.captcha_timeout_seconds,
    floodLimit: row.flood_limit,
    floodWindowSeconds: row.flood_window_seconds,
    muteSeconds: row.mute_seconds,
    bannedWords: Array.isArray(row.banned_words)
      ? row.banned_words
      : JSON.parse(row.banned_words || "[]"),
  };
}

class GuardDatabase {
  constructor(database) {
    this.database = database;
    this._createSchema();
  }

  _createSchema() {
    this.database.pragma("foreign_keys = ON");
    this.database.exec(`
      CREATE TABLE IF NOT EXISTS guard_groups (
        bot_id INTEGER NOT NULL,
        chat_id TEXT NOT NULL,
        title TEXT NOT NULL,
        owner_id INTEGER NOT NULL,
        welcome_text TEXT NOT NULL DEFAULT '${DEFAULT_GROUP.welcomeText}',
        captcha_enabled INTEGER NOT NULL DEFAULT 1,
        captcha_timeout_seconds INTEGER NOT NULL DEFAULT 60,
        flood_limit INTEGER NOT NULL DEFAULT 5,
        flood_window_seconds INTEGER NOT NULL DEFAULT 10,
        mute_seconds INTEGER NOT NULL DEFAULT 300,
        banned_words TEXT NOT NULL DEFAULT '[]',
        PRIMARY KEY (bot_id, chat_id)
      );
      CREATE TABLE IF NOT EXISTS guard_admins (
        bot_id INTEGER NOT NULL,
        chat_id TEXT NOT NULL,
        user_id INTEGER NOT NULL,
        added_by INTEGER NOT NULL,
        created_at INTEGER NOT NULL,
        PRIMARY KEY (bot_id, chat_id, user_id),
        FOREIGN KEY (bot_id, chat_id)
          REFERENCES guard_groups(bot_id, chat_id) ON DELETE CASCADE
      );
      CREATE TABLE IF NOT EXISTS guard_warnings (
        bot_id INTEGER NOT NULL,
        chat_id TEXT NOT NULL,
        user_id INTEGER NOT NULL,
        count INTEGER NOT NULL DEFAULT 0,
        updated_at INTEGER NOT NULL,
        PRIMARY KEY (bot_id, chat_id, user_id),
        FOREIGN KEY (bot_id, chat_id)
          REFERENCES guard_groups(bot_id, chat_id) ON DELETE CASCADE
      );
      CREATE TABLE IF NOT EXISTS guard_captchas (
        bot_id INTEGER NOT NULL,
        chat_id TEXT NOT NULL,
        user_id INTEGER NOT NULL,
        expires_at INTEGER NOT NULL,
        PRIMARY KEY (bot_id, chat_id, user_id),
        FOREIGN KEY (bot_id, chat_id)
          REFERENCES guard_groups(bot_id, chat_id) ON DELETE CASCADE
      );
      CREATE TABLE IF NOT EXISTS guard_events (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        bot_id INTEGER NOT NULL,
        chat_id TEXT NOT NULL,
        user_id INTEGER NOT NULL,
        event_type TEXT NOT NULL,
        created_at INTEGER NOT NULL,
        FOREIGN KEY (bot_id, chat_id)
          REFERENCES guard_groups(bot_id, chat_id) ON DELETE CASCADE
      );
      CREATE TABLE IF NOT EXISTS guard_activity (
        bot_id INTEGER NOT NULL,
        chat_id TEXT NOT NULL,
        user_id INTEGER NOT NULL,
        activity_date TEXT NOT NULL,
        message_count INTEGER NOT NULL DEFAULT 0,
        PRIMARY KEY (bot_id, chat_id, user_id, activity_date),
        FOREIGN KEY (bot_id, chat_id)
          REFERENCES guard_groups(bot_id, chat_id) ON DELETE CASCADE
      );
      CREATE INDEX IF NOT EXISTS guard_events_stats
        ON guard_events(bot_id, chat_id, created_at);
      CREATE INDEX IF NOT EXISTS guard_activity_daily
        ON guard_activity(bot_id, chat_id, activity_date);
    `);
  }

  getGroup(botId, chatId) {
    return mapGroup(this.database.prepare(
      "SELECT * FROM guard_groups WHERE bot_id = ? AND chat_id = ?",
    ).get(botId, String(chatId)));
  }

  claimGroup(botId, chatId, title, ownerId) {
    const id = String(chatId);
    const row = this.database.prepare(`
      INSERT INTO guard_groups (bot_id, chat_id, title, owner_id)
      VALUES (?, ?, ?, ?)
      ON CONFLICT(bot_id, chat_id) DO UPDATE SET title = excluded.title
      WHERE guard_groups.owner_id = excluded.owner_id
      RETURNING *
    `).get(botId, id, String(title || id), ownerId);
    if (!row) {
      throw new Error("Bu guruh allaqachon boshqa bot adminiga biriktirilgan.");
    }
    return mapGroup(row);
  }

  listGroups(botId, userId) {
    return this.database.prepare(`
      SELECT g.*
      FROM guard_groups g
      LEFT JOIN guard_admins a
        ON a.bot_id = g.bot_id AND a.chat_id = g.chat_id AND a.user_id = ?
      WHERE g.bot_id = ? AND (g.owner_id = ? OR a.user_id IS NOT NULL)
      ORDER BY g.title COLLATE NOCASE
    `).all(userId, botId, userId).map(mapGroup);
  }

  canManageGroup(botId, chatId, userId) {
    const group = this.getGroup(botId, chatId);
    if (!group) return false;
    if (group.ownerId === userId) return true;
    return Boolean(this.database.prepare(`
      SELECT 1 FROM guard_admins
      WHERE bot_id = ? AND chat_id = ? AND user_id = ?
    `).get(botId, String(chatId), userId));
  }

  updateGroup(botId, chatId, updates) {
    const entries = Object.entries(updates);
    if (!entries.length) return this.getGroup(botId, chatId);
    for (const [field] of entries) {
      if (!Object.hasOwn(GROUP_COLUMNS, field)) {
        throw new Error(`Guruh sozlamasi noma'lum: ${field}`);
      }
    }

    const assignments = entries.map(([field]) => `${GROUP_COLUMNS[field]} = ?`);
    const values = entries.map(([field, value]) =>
      field === "bannedWords" ? JSON.stringify(value) :
        field === "captchaEnabled" ? Number(Boolean(value)) : value,
    );
    this.database.prepare(
      `UPDATE guard_groups SET ${assignments.join(", ")} WHERE bot_id = ? AND chat_id = ?`,
    ).run(...values, botId, String(chatId));
    return this.getGroup(botId, chatId);
  }

  listAdmins(botId, chatId) {
    return this.database.prepare(`
      SELECT user_id AS userId, added_by AS addedBy, created_at AS createdAt
      FROM guard_admins WHERE bot_id = ? AND chat_id = ? ORDER BY created_at
    `).all(botId, String(chatId));
  }

  addAdmin(botId, chatId, userId, addedBy) {
    this.database.prepare(`
      INSERT INTO guard_admins (bot_id, chat_id, user_id, added_by, created_at)
      VALUES (?, ?, ?, ?, ?)
      ON CONFLICT(bot_id, chat_id, user_id) DO NOTHING
    `).run(botId, String(chatId), userId, addedBy, Date.now());
  }

  removeAdmin(botId, chatId, userId) {
    return this.database.prepare(
      "DELETE FROM guard_admins WHERE bot_id = ? AND chat_id = ? AND user_id = ?",
    ).run(botId, String(chatId), userId).changes > 0;
  }

  incrementWarn(botId, chatId, userId) {
    this.database.prepare(`
      INSERT INTO guard_warnings (bot_id, chat_id, user_id, count, updated_at)
      VALUES (?, ?, ?, 1, ?)
      ON CONFLICT(bot_id, chat_id, user_id)
      DO UPDATE SET count = count + 1, updated_at = excluded.updated_at
    `).run(botId, String(chatId), userId, Date.now());
    return this.getWarnCount(botId, chatId, userId);
  }

  decrementWarn(botId, chatId, userId) {
    this.database.prepare(`
      UPDATE guard_warnings
      SET count = MAX(0, count - 1), updated_at = ?
      WHERE bot_id = ? AND chat_id = ? AND user_id = ?
    `).run(Date.now(), botId, String(chatId), userId);
    return this.getWarnCount(botId, chatId, userId);
  }

  getWarnCount(botId, chatId, userId) {
    return this.database.prepare(`
      SELECT count FROM guard_warnings
      WHERE bot_id = ? AND chat_id = ? AND user_id = ?
    `).get(botId, String(chatId), userId)?.count || 0;
  }

  setCaptcha(botId, chatId, userId, expiresAt) {
    this.database.prepare(`
      INSERT INTO guard_captchas (bot_id, chat_id, user_id, expires_at)
      VALUES (?, ?, ?, ?)
      ON CONFLICT(bot_id, chat_id, user_id)
      DO UPDATE SET expires_at = excluded.expires_at
    `).run(botId, String(chatId), userId, expiresAt);
  }

  getCaptcha(botId, chatId, userId) {
    return this.database.prepare(`
      SELECT expires_at AS expiresAt FROM guard_captchas
      WHERE bot_id = ? AND chat_id = ? AND user_id = ?
    `).get(botId, String(chatId), userId) || null;
  }

  clearCaptcha(botId, chatId, userId) {
    this.database.prepare(`
      DELETE FROM guard_captchas
      WHERE bot_id = ? AND chat_id = ? AND user_id = ?
    `).run(botId, String(chatId), userId);
  }

  listCaptchas(botId) {
    return this.database.prepare(`
      SELECT chat_id AS chatId, user_id AS userId, expires_at AS expiresAt
      FROM guard_captchas WHERE bot_id = ?
    `).all(botId);
  }

  logEvent(botId, chatId, userId, eventType, timestamp = Date.now()) {
    this.database.prepare(`
      INSERT INTO guard_events (bot_id, chat_id, user_id, event_type, created_at)
      VALUES (?, ?, ?, ?, ?)
    `).run(botId, String(chatId), userId, eventType, timestamp);
  }

  recordActivity(botId, chatId, userId, timestamp = Date.now()) {
    const activityDate = new Date(timestamp).toISOString().slice(0, 10);
    this.database.prepare(`
      INSERT INTO guard_activity (bot_id, chat_id, user_id, activity_date, message_count)
      VALUES (?, ?, ?, ?, 1)
      ON CONFLICT(bot_id, chat_id, user_id, activity_date)
      DO UPDATE SET message_count = message_count + 1
    `).run(botId, String(chatId), userId, activityDate);
  }

  getStats(botId, chatId, now = Date.now()) {
    const rows = this.database.prepare(`
      SELECT event_type AS eventType, COUNT(*) AS count
      FROM guard_events
      WHERE bot_id = ? AND chat_id = ? AND created_at >= ?
      GROUP BY event_type
    `).all(botId, String(chatId), now - 24 * 60 * 60 * 1000);
    const activity = this.database.prepare(`
      SELECT COALESCE(SUM(message_count), 0) AS count
      FROM guard_activity
      WHERE bot_id = ? AND chat_id = ? AND activity_date = ?
    `).get(botId, String(chatId), new Date(now).toISOString().slice(0, 10));
    const stats = { bans: 0, mutes: 0, kicks: 0, warnings: 0, dailyActivity: 0 };
    for (const row of rows) {
      if (row.eventType === "ban") stats.bans = row.count;
      if (row.eventType === "mute") stats.mutes = row.count;
      if (row.eventType === "kick") stats.kicks = row.count;
      if (row.eventType === "warn") stats.warnings = row.count;
    }
    stats.dailyActivity = activity.count;
    return stats;
  }

  deleteBot(botId) {
    this.database.prepare("DELETE FROM guard_groups WHERE bot_id = ?").run(botId);
  }

  close() {
    this.database.close();
  }
}

class SupabaseGuardDatabase {
  constructor(client) {
    this.client = client;
  }

  async _data(request) {
    const { data, error } = await request;
    if (error) throw new Error(`Supabase Guard DB: ${error.message}`);
    return data;
  }

  async getGroup(botId, chatId) {
    const row = await this._data(this.client.from("guard_groups")
      .select("*")
      .eq("bot_id", botId)
      .eq("chat_id", String(chatId))
      .maybeSingle());
    return mapSupabaseGroup(row);
  }

  async claimGroup(botId, chatId, title, ownerId) {
    const result = await this._data(this.client.rpc("guard_claim_group", {
      p_bot_id: botId,
      p_chat_id: String(chatId),
      p_title: String(title || chatId),
      p_owner_id: ownerId,
    }));
    const claimed = Array.isArray(result) ? result[0] : result;
    if (!claimed?.chat_id) throw new Error("Supabase Guard DB: guruh claim natijasi bo'sh.");
    return mapSupabaseGroup(claimed);
  }

  async listGroups(botId, userId) {
    const [owned, admins] = await Promise.all([
      this._data(this.client.from("guard_groups")
        .select("*").eq("bot_id", botId).eq("owner_id", userId)),
      this._data(this.client.from("guard_admins")
        .select("chat_id").eq("bot_id", botId).eq("user_id", userId)),
    ]);
    const chats = new Set(owned.map((group) => group.chat_id));
    const additional = await Promise.all(admins
      .filter((admin) => !chats.has(admin.chat_id))
      .map((admin) => this.getGroup(botId, admin.chat_id)));
    return [...owned.map(mapSupabaseGroup), ...additional.filter(Boolean)]
      .sort((a, b) => a.title.localeCompare(b.title));
  }

  async canManageGroup(botId, chatId, userId) {
    const group = await this.getGroup(botId, chatId);
    if (!group) return false;
    if (group.ownerId === userId) return true;
    const row = await this._data(this.client.from("guard_admins")
      .select("user_id")
      .eq("bot_id", botId)
      .eq("chat_id", String(chatId))
      .eq("user_id", userId)
      .maybeSingle());
    return Boolean(row);
  }

  async updateGroup(botId, chatId, updates) {
    const columns = {
      title: "title",
      welcomeText: "welcome_text",
      captchaEnabled: "captcha_enabled",
      captchaTimeoutSeconds: "captcha_timeout_seconds",
      floodLimit: "flood_limit",
      floodWindowSeconds: "flood_window_seconds",
      muteSeconds: "mute_seconds",
      bannedWords: "banned_words",
    };
    const values = {};
    for (const [field, value] of Object.entries(updates)) {
      if (!Object.hasOwn(columns, field)) {
        throw new Error(`Guruh sozlamasi noma'lum: ${field}`);
      }
      values[columns[field]] = value;
    }
    if (Object.keys(values).length) {
      await this._data(this.client.from("guard_groups")
        .update(values)
        .eq("bot_id", botId)
        .eq("chat_id", String(chatId)));
    }
    return this.getGroup(botId, chatId);
  }

  async listAdmins(botId, chatId) {
    const rows = await this._data(this.client.from("guard_admins")
      .select("user_id,added_by,created_at")
      .eq("bot_id", botId)
      .eq("chat_id", String(chatId))
      .order("created_at"));
    return rows.map((row) => ({
      userId: row.user_id,
      addedBy: row.added_by,
      createdAt: row.created_at,
    }));
  }

  async addAdmin(botId, chatId, userId, addedBy) {
    await this._data(this.client.from("guard_admins").upsert({
      bot_id: botId,
      chat_id: String(chatId),
      user_id: userId,
      added_by: addedBy,
    }, { onConflict: "bot_id,chat_id,user_id", ignoreDuplicates: true }));
  }

  async removeAdmin(botId, chatId, userId) {
    const rows = await this._data(this.client.from("guard_admins")
      .delete()
      .eq("bot_id", botId)
      .eq("chat_id", String(chatId))
      .eq("user_id", userId)
      .select("user_id"));
    return rows.length > 0;
  }

  async incrementWarn(botId, chatId, userId) {
    const count = await this._data(this.client.rpc("guard_increment_warning", {
      p_bot_id: botId,
      p_chat_id: String(chatId),
      p_user_id: userId,
    }));
    return Number(count);
  }

  async decrementWarn(botId, chatId, userId) {
    const count = await this._data(this.client.rpc("guard_decrement_warning", {
      p_bot_id: botId,
      p_chat_id: String(chatId),
      p_user_id: userId,
    }));
    return Number(count) || 0;
  }

  async getWarnCount(botId, chatId, userId) {
    const row = await this._data(this.client.from("guard_warnings")
      .select("count")
      .eq("bot_id", botId)
      .eq("chat_id", String(chatId))
      .eq("user_id", userId)
      .maybeSingle());
    return row?.count || 0;
  }

  async setCaptcha(botId, chatId, userId, expiresAt) {
    await this._data(this.client.from("guard_captchas").upsert({
      bot_id: botId,
      chat_id: String(chatId),
      user_id: userId,
      expires_at: new Date(expiresAt).toISOString(),
    }, { onConflict: "bot_id,chat_id,user_id" }));
  }

  async getCaptcha(botId, chatId, userId) {
    const row = await this._data(this.client.from("guard_captchas")
      .select("expires_at")
      .eq("bot_id", botId)
      .eq("chat_id", String(chatId))
      .eq("user_id", userId)
      .maybeSingle());
    return row
      ? { expiresAt: new Date(row.expires_at).getTime() }
      : null;
  }

  async clearCaptcha(botId, chatId, userId) {
    await this._data(this.client.from("guard_captchas")
      .delete()
      .eq("bot_id", botId)
      .eq("chat_id", String(chatId))
      .eq("user_id", userId));
  }

  async listCaptchas(botId) {
    const rows = await this._data(this.client.from("guard_captchas")
      .select("chat_id,user_id,expires_at")
      .eq("bot_id", botId));
    return rows.map((row) => ({
      chatId: row.chat_id,
      userId: row.user_id,
      expiresAt: new Date(row.expires_at).getTime(),
    }));
  }

  async logEvent(botId, chatId, userId, eventType, timestamp = Date.now()) {
    await this._data(this.client.from("guard_events").insert({
      bot_id: botId,
      chat_id: String(chatId),
      user_id: userId,
      event_type: eventType,
      created_at: new Date(timestamp).toISOString(),
    }));
  }

  async getStats(botId, chatId, now = Date.now()) {
    const [rows, activity] = await Promise.all([
      this._data(this.client.rpc("guard_event_stats", {
        p_bot_id: botId,
        p_chat_id: String(chatId),
        p_since: new Date(now - 24 * 60 * 60 * 1000).toISOString(),
      })),
      this._data(this.client.from("guard_activity")
        .select("message_count")
        .eq("bot_id", botId)
        .eq("chat_id", String(chatId))
        .eq("activity_date", new Date(now).toISOString().slice(0, 10))),
    ]);
    const stats = { bans: 0, mutes: 0, kicks: 0, warnings: 0, dailyActivity: 0 };
    for (const row of rows) {
      if (row.event_type === "ban") stats.bans = Number(row.event_count);
      if (row.event_type === "mute") stats.mutes = Number(row.event_count);
      if (row.event_type === "kick") stats.kicks = Number(row.event_count);
      if (row.event_type === "warn") stats.warnings = Number(row.event_count);
    }
    stats.dailyActivity = activity.reduce(
      (total, row) => total + Number(row.message_count),
      0,
    );
    return stats;
  }

  async recordActivity(botId, chatId, userId, timestamp = Date.now()) {
    const today = new Date(timestamp).toISOString().slice(0, 10);
    await this._data(this.client.rpc("guard_record_activity", {
      p_bot_id: botId,
      p_chat_id: String(chatId),
      p_user_id: userId,
      p_activity_date: today,
    }));
  }

  async deleteBot(botId) {
    await this._data(this.client.from("guard_groups")
      .delete().eq("bot_id", botId));
  }
}

let defaultDatabasePromise;

function openGuardDatabase(filename = process.env.GUARD_DATABASE_PATH || path.join(
  process.cwd(),
  "data",
  "guard-bot.sqlite",
)) {
  const Database = require("better-sqlite3");
  if (filename !== ":memory:") {
    fs.mkdirSync(path.dirname(path.resolve(filename)), { recursive: true });
  }
  const database = new Database(filename);
  if (filename !== ":memory:") database.pragma("journal_mode = WAL");
  return new GuardDatabase(database);
}

async function getGuardDatabase() {
  if (!defaultDatabasePromise) {
    const url = process.env.SUPABASE_URL || "";
    const key = process.env.SUPABASE_SERVICE_ROLE_KEY || "";
    if (Boolean(url) !== Boolean(key)) {
      throw new Error("SUPABASE_URL va SUPABASE_SERVICE_ROLE_KEY ikkalasi ham sozlanishi kerak.");
    }
    if (url) {
      const { createClient } = require("@supabase/supabase-js");
      defaultDatabasePromise = Promise.resolve(new SupabaseGuardDatabase(
        createClient(url, key, {
          auth: { autoRefreshToken: false, persistSession: false },
        }),
      ));
    } else {
      defaultDatabasePromise = Promise.resolve(openGuardDatabase());
    }
  }
  return defaultDatabasePromise;
}

async function closeGuardDatabase() {
  if (!defaultDatabasePromise) return;
  const database = await defaultDatabasePromise;
  database.close?.();
  defaultDatabasePromise = null;
}

module.exports = {
  DEFAULT_GROUP,
  GuardDatabase,
  SupabaseGuardDatabase,
  closeGuardDatabase,
  getGuardDatabase,
  openGuardDatabase,
};
