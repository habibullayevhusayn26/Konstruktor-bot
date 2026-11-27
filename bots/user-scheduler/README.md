# User Bot — rejalashtirilgan postlar

Marketdan **User Bot — rejalashtirilgan postlar** turini yarating va yangi
botning shaxsiy chatida `/start` yuboring. **Mini App orqali akkauntni ulash**
tugmasini bosib, telefon raqamingizni xalqaro formatda kiriting. Telegram
yuborgan bir martalik login kodini Mini App ichiga yozing; 2FA yoqilgan bo'lsa,
parol ham shu Mini App'da so'raladi. Kod va parol bot chatiga yuborilmaydi.

Mini App login kodi va 2FA parolini ulanish vaqtida serverga uzatadi. Ulangan
akkaunt sessiyasi mavjud `TOKEN_SECRET` kaliti bilan shifrlanib MongoDB'da
saqlanadi. Mini App rozilik tasdig'ini talab qiladi, Telegram `initData` ni
serverda tekshiradi, login ma'lumotlari log yoki bazaga yozilmaydi. Kalit yo'qolsa
yoki almashtirilsa, sessiyani tiklab bo'lmaydi. Akkaunt egasi bo'lmagan
foydalanuvchi akkauntini ulamasligi kerak.

Mini App Telegram ichida ochiladi va ommaviy **HTTPS** manzil talab qiladi.
Render'da `RENDER_EXTERNAL_URL` avtomatik ishlatiladi; boshqa hostingda
`PUBLIC_API_URL` ni sozlang. Lokal sinov uchun HTTPS tunnel kerak.

Serverda `TELEGRAM_API_ID` va `TELEGRAM_API_HASH` ni
[my.telegram.org](https://my.telegram.org) dan olib sozlang. Render deployida
`TELEGRAM_API_ID`, `TELEGRAM_API_HASH`, `TELEGRAM_BOT_TOKEN`, `MONGODB_URI` va
`TOKEN_SECRET` environment secrets sifatida kiriting.

Chat tanlash bo'limida Telegram'ning guruh va kanal tanlash tugmalari chiqadi.
Telegram ro'yxatidan tanlangan chat botga `chat_shared` orqali yuboriladi;
akkaunt chat a'zosi bo'lishi kifoya, admin huquqi talab qilinmaydi. Tanlangan
chatni qayta tanlash uni jadvaldan olib tashlaydi. Telegram akkauntda yozish
huquqi bo'lmagan joyga post yuborilmasligi mumkin; xato egasiga bildiriladi.

Takrorlanadigan xabar uchun matn, media, fayl yoki forwardni botga yuboring.
Xabar nusxasi o'rniga uning shaxsiy chatdagi Telegram xabar ID'si saqlanadi;
yuborishda Telegram'ning native copy/forward amallari ishlatiladi. Shuning
uchun media va formatlash saqlanadi, boshqa foydalanuvchidan forward qilingan
xabar forward holida qoladi, akkaunt egasining o'z xabari esa forward belgisisiz
nusxalanadi. Premium emoji va manba xabaridagi tugmalar ham Telegram native
copy/forward amallari orqali uzatiladi. Albom bir nechta xabar ID'si bilan birga
saqlanadi. Manba xabar o'chirilgan yoki Telegram tomonidan nusxalashga ruxsat
berilmagan bo'lsa, yuborish xato sifatida egasiga bildiriladi.

Xabar, manzillar va intervalni tanlab, oldindan ko'rib, tasdiqlagandan keyin
birinchi post darhol yuboriladi; keyingilari 10 soniyadan 30 kungacha tanlangan
intervalda takrorlanadi. **Jadvalni to'xtatish** keyingi yuborishlarni to'xtatadi;
allaqachon yuborilayotgan xabar tugashi mumkin. Akkauntni uzish Telegram
sessiyasini ham bekor qiladi.

Intervalni `soat:daqiqa:soniya` formatida kiriting (masalan, `00:00:10`).
Telegram tez-tez yuborishni cheklashi mumkin; 10 soniyalik oraliq qo'yilgan
bo'lsa ham, Telegram tomonidan vaqtinchalik limit qo'llanishi ehtimoli bor.
