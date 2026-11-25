# Telegram bot konstruktori

## Bot yaratish

Foydalanuvchi konstruktor botda tayyor turini tanlaydi va BotFather tokenini
yuboradi. Qolgan sozlamalar avtomatik bajariladi:

Uzoq davom etadigan shaxsiy chat amallarida bot nuqtalari o'zgarib turadigan
loading matnini ko'rsatib, amal tugagach xabarni o'chiradi. Yangi bot tokenini
tekshirish va ishga tushirish paytida ham loading ko'rsatiladi.

- QR generator / scanner: standart qora-oq QR-kod yaratadi va rasm ichidagi
  QR-kodni ham o'qiydi.
- Nakrutka / SMM bot: SMM panel API orqali xizmatlar ro'yxatini, so'mdagi
  narxlarni, balans va cheklar orqali to'lovni hamda buyurtma holatini boshqaradi.
- Musiqa qidiruv bot: Jamendo'dan tijoriy foydalanishga ruxsat beruvchi Creative
  Commons litsenziyali treklarni qidirib MP3 yuboradi, YouTube'dan esa video
  qidirib rasmiy havolalarni ko'rsatadi. Yuklangan Telegram `file_id` jarayon
  xotirasida keshlanadi.
- Nickname shrift generator: 17 xil Unicode variantini alohida bosiladigan,
  clipboard'ga nusxa oluvchi tugmalar bilan ko'rsatadi.
- Kanal postiga matn qo'shish: havola, format va emoji mavjud matnni tanlangan
  kanalning har bir yangi matnli postiga yoki media caption'iga qo'shadi.
- Watermark bot: bosh menyuda **Shablonlar** va **Pechat bosish** tugmalari
  mavjud. Yangi shablon yaratayotganda nom kiriting; mavjud shablon nomini ham
  o'zgartirish mumkin. Shablonni o'chirish uchun tasdiqlash talab qilinadi. Har
  bir shablon ichida logo, shakl, logo o'lchami (8%, 10%, 20%, 30%) va joylashuv
  alohida sozlanadi. Buyruqsiz yuborilgan rasm uchun bot ishlatiladigan shablonni
  so'raydi. Rasmni Telegram photo yoki PNG/JPG/WebP kabi image fayl qilib
  yuborish mumkin.
- Fayl tahrirlovchi: hujjat, rasm, video yoki audio fayl nomini va Telegram
  thumbnail rasmini o'zgartiradi. Audio MP3 sifatida qaytariladi; MP3 faylda
  ijrochi, musiqa nomi hamda ichki cover ID3 teglari yangilanadi, boshqa audio
  formatlari MP3 ga aylantiriladi. Boshqa fayllar hujjat sifatida yuboriladi.
  MP3 turi fayl nomi, MIME turi va audio imzosi orqali aniqlanadi; rasmni photo
  yoki MIME turi noma'lum document sifatida yuborish mumkin. Kiruvchi fayllar
  20 MB gacha qabul qilinadi.
- Rasm sarlavhasi tahrirlovchi: `images/uzum.png` shabloniga O'tkazildi yozuvi
  ostida beshta alohida yozuv so'raydi — `10 000 quti`, `Katta Mahsulot`,
  `1728`, `1:42` va `50`; tayyor rasmda tahrirlash tugmalari ham mavjud.

Kanal-footer botni ishga tushirgach `/start` yuboring, tag matnini o'rnating,
kanal tanlash tugmasini bosing va admin bo'lgan kanalingizni tanlang. Telegram
botni kanalga `can_edit_messages` huquqi bilan admin sifatida qo'shishni
tasdiqlashni so'raydi. Odatda botga admin huquqlarini berish uchun kanalda
`can_promote_members` huquqi talab qilinadi. Botni qo'shishni Telegram ichida
o'zingiz tasdiqlaysiz. O'rnatish, ko'rish, o'chirish va yoqib/o'chirish tugmalari
bot ichida mavjud.

Watermark botda `/start` yuboring. **Shablonlar** bo'limida Namuna1, Namuna2
**Shablonlar** bo'limida yangi shablon qo'shib, unga nom bering; nomini keyin
ham o'zgartira olasiz. Kerak bo'lmagan shablonni tasdiqlash oynasi orqali
o'chiring. Har bir shablon ichida logo, shakl, o'lcham (8%, 10%, 20%, 30%) va
joylashuvini sozlang. **Pechat bosish** tugmasi orqali shablonni tanlab rasm
yuboring. Rasmni buyruqsiz yuborsangiz ham bot shablon tanlashni taklif qiladi.
Tugmalarda rangli emoji ishlatiladi; ularning fon rangi Telegram tomonidan
boshqariladi.

## Balans, trial va tariflar

Har bir yangi bot 3 kunlik bepul sinov bilan ishga tushadi. Trial tugaganda
boshlang'ich va birinchi oylik to'lov balansdan olinadi; keyingi to'lovlar
kalendar oyida bir marta olinadi. Standart narx barcha bot turlari uchun
10 000 so'm boshlang'ich va 1 000 so'm/oy. Balans yetmasa bot vaqtincha
to'xtaydi; mablag' tushib, qarzdorlik yechilgach bot avtomatik qayta ishga tushadi.
Tariflar bot yaratilgan paytda belgilanadi, adminning keyingi tarif o'zgarishi
faqat yangi yaratiladigan botlarga ta'sir qiladi.

Konstruktor admini (`ADMIN_IDS`) `/start` → **Admin panel** → **Tariflar va
to'lovlar** bo'limida bot turlarini yoqib/o'chiradi, narxlarni
`boshlang'ich/oylik` shaklida o'zgartiradi, Stars kursini hamda karta orqali
to'lov ko'rsatmalarini sozlaydi. Shu tugmalar orqali bot turini marketga
qo'yish yoki marketdan olib tashlash mumkin. Standart Stars kursi 100
Stars = 25 000 so'm. Har bir bot turi uchun admin namuna bot username'ini yoki
`t.me` havolasini ham sozlaydi; foydalanuvchi marketda tavsifni va namuna botni
ko'radi. Namuna botni o'chirish uchun admin `/clear` yuboradi.

Ishlash tezligi uchun obunachi yozuvlari va foydalanuvchi profillari qisqa
muddat keshda saqlanadi, kanal a'zoligi qayta-qayta tekshirilmaydi va saqlangan
botlar cheklangan parallelizm bilan ishga tushiriladi.

Foydalanuvchi balansni Telegram Stars bilan avtomatik yoki karta o'tkazmasi
qilib, chekni yuborish orqali to'ldiradi. Karta o'tkazmasi admin tomonidan
tekshirilib tasdiqlanmaguncha balansga qo'shilmaydi. Stars to'lovlari Telegram
invoice orqali tekshiriladi. Chek va tasdiqlash xabari admin bilan shaxsiy
chatda pin qilinadi.

Foydalanuvchi **Profil** bo'limida Telegram ID'si, balansi va ishlayotgan
botlari sonini ko'radi. Konstruktor admin panelida foydalanuvchini ID orqali
topib, balansini o'rnatish, botlarini ko'rish, foydalanuvchini bloklash yoki
unga xabar yuborish mumkin. Admin yuborgan xabarlar Telegram `copyMessage`
orqali ko'chiriladi; format, media va custom emoji entitilari saqlanadi.

Botning matnlari va tugmalarida sozlangan Telegram custom emoji ID'lari
ishlatiladi. Inline tugmalar `icon_custom_emoji_id`, matnlar esa HTML
`<tg-emoji>` tegi orqali bezatiladi. Telegram bu emojilarni qabul qilmasa,
bot xabarni oddiy emoji bilan qayta yuboradi. Premium emoji ko'rsatish uchun
bot egasida Telegram Premium yoki Fragment orqali olingan qo'shimcha username
bo'lishi kerak.

Har bir yaratilgan bot uchun `bots/generated/<bot-id>.js` fayli hosil bo'ladi.
Token bu faylga yozilmaydi; u MongoDB'da shifrlangan holda saqlanadi. Fayl deploy
yoki restart'dan keyin bazadagi bot yozuvidan qayta yaratiladi. Tayyor bot
shablonlari `bots/qr-generator.js` va `bots/nickname-font.js` fayllarida.

## Bot admin paneli

Har bir tayyor bot egasi o'z botida `/admin` yuborib:

- foydalanuvchilar statistikasini ko'radi;
- salomlashuv matnini o'zgartiradi;
- obunachilarga xabar yuboradi;
- majburiy obuna kanalini sozlaydi yoki o'chiradi.

Majburiy obuna uchun admin panelda kanalning `@username` yoki ID'sini yuboring.
Bot o'sha kanalga administrator qilib qo'shilgan bo'lishi kerak. Shunda bot
foydalanuvchi kanal a'zoligini tekshiradi.

## Lokal ishga tushirish

1. `.env.example` faylidan `.env` nusxa oling:
   `Copy-Item .env.example .env`.
2. `TELEGRAM_BOT_TOKEN`, `MONGODB_URI`, `TOKEN_SECRET` va `CRON_SECRET`
   qiymatlarini kiriting. `CRON_SECRET` uchun
   `node -e "console.log(require('crypto').randomBytes(32).toString('hex'))"`
   bajaring.
   `TOKEN_SECRET` yaratish uchun:
   `node -e "console.log(require('crypto').randomBytes(32).toString('hex'))"`.
   Kalitni doimiy saqlang; almashtirilsa bazadagi tokenlarni ochib bo'lmaydi.
3. Ixtiyoriy `ADMIN_IDS` qiymatiga konstruktor adminlarining Telegram ID'larini
   vergul bilan yozing.
4. `npm install`, so'ng `npm start` bajaring (Node.js 20.9 yoki yangiroq).
5. Musiqa bot uchun Jamendo developer hisobidan `JAMENDO_CLIENT_ID` va YouTube
   Data API v3 uchun `YOUTUBE_API_KEY` oling va `.env` fayliga kiriting.

## Render va cron

Render Blueprint'ni `render.yaml` orqali yarating. `TELEGRAM_BOT_TOKEN`,
`MONGODB_URI` va `TOKEN_SECRET` secret'larini Render sozlamalariga kiriting.
`TOKEN_SECRET` lokal `.env` va Render'da bir xil bo'lishi kerak.
Musiqa bot yaratish uchun Render environment variables ichiga `JAMENDO_CLIENT_ID`
va `YOUTUBE_API_KEY` qo'shing. Audio fayl Render'ga yuklab olinmaydi; Telegram
Jamendo URL'idan oladi, Telegram qaytargan `file_id` esa ilova xotirasida keshlanadi.
YouTube natijalari MP3 emas, rasmiy video havolalari sifatida ko'rsatiladi.

Cron-job.org'da har 14 daqiqada HTTP GET so'rovini
`https://<render-xizmati>.onrender.com/cron` manziliga yuboring va
`X-Cron-Secret` header'iga Render'dagi `CRON_SECRET` qiymatini kiriting. Endpoint
kechikkan trial va oylik to'lovlarni tekshiradi hamda balansni yechadi. `/health`
Render health check uchun; u billing amalini bajarmaydi.
#   K o n s t r u k t o r - b o t  
 