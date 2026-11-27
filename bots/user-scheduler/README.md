# User Bot — rejalashtirilgan postlar

Marketdan **User Bot — rejalashtirilgan postlar** turini yarating va botning
shaxsiy chatida `/start` yuboring. Akkauntni QR orqali ulash uchun Telegram
ilovasida **Sozlamalar → Qurilmalar → Qurilmani ulash** ni tanlang. QR kodni
boshqalarga yubormang. Bot 2FA parolini so'rasa, yuborilgan chat xabari darhol
o'chiriladi va bazaga yozilmaydi.

Serverda `TELEGRAM_API_ID` va `TELEGRAM_API_HASH` ni
[my.telegram.org](https://my.telegram.org) dan olib sozlash shart. Saqlangan
akkaunt sessiyasi mavjud `TOKEN_SECRET` kaliti bilan shifrlanib MongoDB'da
saqlanadi. Kalit yo'qolsa yoki almashtirilsa, sessiyani tiklab bo'lmaydi.

Panel faqat akkaunt egasi yoki admini bo'lgan guruh va kanallarni ko'rsatadi.
Xabar, manzillar va intervalni tanlab, oldindan ko'rib, tasdiqlagandan keyin
birinchi post darhol yuboriladi; keyingilari 01:00 dan 30 kungacha tanlangan
intervalda takrorlanadi. **Jadvalni to'xtatish** keyingi yuborishlarni to'xtatadi;
allaqachon yuborilayotgan xabar tugashi mumkin. Akkauntni uzish Telegram
sessiyasini ham bekor qiladi.

Render deployida `TELEGRAM_API_ID` va `TELEGRAM_API_HASH` ni environment
secrets sifatida kiriting. `TELEGRAM_BOT_TOKEN`, `MONGODB_URI` va
`TOKEN_SECRET` ham sozlangan bo'lishi kerak.
