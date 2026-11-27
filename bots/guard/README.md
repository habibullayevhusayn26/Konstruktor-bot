# Telegram Qorovul Bot

Guard Bot is a grammY bot served through a per-bot Telegram webhook on the
constructor's existing HTTPS server. On Render, it automatically uses the
service's `RENDER_EXTERNAL_URL`, so no public URL needs to be entered manually.
For other hosting providers, set `PUBLIC_API_URL` to the public HTTPS base URL.
An optional URL path prefix is supported. Telegram still needs a reachable
public HTTPS endpoint; local testing requires a tunnel or equivalent.

## Setup

1. Select **Telegram Qorovul Bot** in the constructor market and submit its
   BotFather token.
2. Add the bot to the group as an administrator with **Delete messages** and
   **Restrict members** permissions.
3. The group creator sends `/claim` in the group, then opens the private admin
   panel using the button the bot sends.
4. Group owners can grant or revoke panel access by Telegram user ID.

## Moderation and panel

- New members are restricted until they press their personal captcha button;
  they are kicked if the configured timeout expires. Pending captcha deadlines
  are stored and restored after a service restart.
- Messages containing links, forwarded advertisements, and configured banned
  words are deleted. Admins are exempt from automatic deletion and flood mute.
- Flood settings accept `messages/seconds` (3–30 messages / 3–120 seconds).
  Flooding members are muted for the configured default duration.
- Reply to a member's message with `/ban`, `/mute [seconds]`, `/unmute`,
  `/kick`, `/warn [reason]`, or `/unwarn`. Three warnings trigger a ban.
- The private-chat inline panel controls captcha, flood limits, banned words,
  welcome text (`{name}` and `{group}` placeholders), stats, and extra admins.
- `/start`, `/admin`, and `/cancel` are shown in private chat. Moderation
  commands are shown in groups; panel input can be canceled and returns to the
  selected group's settings.

The keyboard uses grammY `InlineKeyboard` with Telegram button styles. Replace
`PLACEHOLDER_ID_*` values in `emojis.js` with numeric custom emoji IDs to use
premium custom emojis; until then the configured ordinary emoji fallbacks are
used.

## Database

Local development uses SQLite at `GUARD_DATABASE_PATH`, defaulting to
`data/guard-bot.sqlite`.

Render's free filesystem is ephemeral. For durable settings and moderation
history, configure both `SUPABASE_URL` and `SUPABASE_SERVICE_ROLE_KEY` on the
service and execute `schema.sql` once in the Supabase SQL Editor. Keep the
service-role key private. If neither Supabase variable is set, the SQLite
fallback is used; configuring only one is an explicit startup error.

Unlike the polling-based templates, Guard Bot is attached directly to the
shared webhook server and does not create a generated polling-handler file.
