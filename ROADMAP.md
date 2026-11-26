# MySQL Lens — Reja (Roadmap)

Bu fayl desktop ilova (`app/`, Tauri + Rust) uchun keyingi ishlarni jamlaydi.
Holat belgilari: ⬜ rejada · 🟡 jarayonda · ✅ tayyor.

---

## Navbatdagi versiya (0.3.0)

### ✅ 1. Avtomatik yangilanish (0.3.0)

**Maqsad:** yangi versiya chiqsa, ilova o'zi xabar beradi va bir tugma bilan yangilanadi. Exe'ni qo'lda yuklab o'tirish kerak bo'lmaydi.

**Qanday ishlaydi:**
- Ilova ochilganda (va menyudan qo'lda) GitHub Releases'dagi eng oxirgi versiya tekshiriladi.
- Yangi versiya bo'lsa, pastda xabar chiqadi: *"MySQL Lens 0.3.0 chiqdi — Yangilash"*. Bosilganda yuklab olinadi, o'rnatiladi va ilova qayta ishga tushadi.
- "Keyinroq" tugmasi ham bo'ladi. O'tkazib yuborilgan versiya haqida qayta bezovta qilinmaydi.

**Texnik reja:**
- `tauri-plugin-updater` va `tauri-plugin-process` (qayta ishga tushirish uchun).
- Yangilanish fayllari kalit bilan imzolanadi. Imzolash kaliti GitHub Secrets'da saqlanadi (`TAURI_SIGNING_PRIVATE_KEY`), ochiq kalit esa `tauri.conf.json`ga yoziladi. Bu Windows kod imzosidan alohida narsa va bepul.
- CI release'ga `latest.json` va `.sig` fayllarini qo'shadi (`createUpdaterArtifacts`).
- Yangilanish manzili: `https://github.com/azizdevfull/mysql-lens/releases/latest/download/latest.json`

**Tayyor deb hisoblanadi, agar:**
- 0.3.0 o'rnatilgan kompyuterda 0.3.1 chiqarilganda, ilova o'zi taklif qilsa va bir bosishda yangilansa.
- Internet bo'lmasa yoki GitHub javob bermasa, ilova jim ishlashda davom etsa.
- Imzosi noto'g'ri fayl o'rnatilmasa.

---

### ✅ 2. Sessiyani tiklash (0.5.0)

**Maqsad:** ilova yopilib qayta ochilganda hamma narsa qolgan joyida turadi.

**Nima tiklanadi:**
- Ochiq tablar (jadvallar va SQL so'rovlar) va qaysi biri faol bo'lgani.
- Har bir SQL tab'dagi yozilgan, lekin saqlanmagan matn.
- Har bir tab qaysi ulanish va bazaga bog'langani.
- Jadval tab'larida filtr, sort va sahifa raqami.
- Panel o'lchamlari, Explorer'da ochilgan tugunlar, tema.

**Texnik reja:**
- Holat ilova papkasidagi JSON faylga (`session.json`) yoziladi: o'zgarishlardan ~1 soniya keyin va ilova yopilayotganda.
- Ochilishda ulanishlarga avtomatik ulanilmaydi. Tab birinchi marta ochilganda ulanadi, shuning uchun ishga tushish sekinlashmaydi va parol so'rovlari chiqmaydi.
- O'chirilgan ulanish yoki jadvalga tegishli tablar jimgina tashlab ketiladi.
- Sozlamalarda o'chirib qo'yish imkoniyati: "Ochilishda oldingi sessiyani tiklash".
- 0.5.0 da qilingani: tablar, faol tab, SQL matn, jadval sahifa/sort/filtri. Panel o'lchamlari va tema avvaldan saqlanadi. Explorer'dagi ochiq tugunlar hali tiklanmaydi (ular ulanishni talab qiladi). O'chirish: `Ctrl+K` → "Stop reopening tabs on startup".

**Tayyor deb hisoblanadi, agar:**
- 3 ta SQL tab'ga matn yozib, ilovani yopib qayta ochganda matnlar va faol tab joyida bo'lsa.
- Ilova kutilmaganda yopilsa ham (crash), ko'pi bilan oxirgi ~1 soniyalik o'zgarish yo'qolsa.
- Ochilish vaqti sezilarli darajada oshmasa.

---

### ✅ 3. Foreign key bo'ylab yurish (0.6.0)

**Maqsad:** bog'langan ma'lumotlarga bir bosishda o'tish.

**Qanday ishlaydi:**
- **Oldinga:** `orders.customer_id = 294` katakchasida havola belgisi chiqadi. `Ctrl+bosish` (yoki o'ng tugma → "customers'dagi qatorni ochish") `customers` jadvalini `id = 294` filtri bilan ochadi.
- **Orqaga:** Row Inspector'da "Bu qatorga havola qilganlar" bo'limi chiqadi, masalan *orders — 12 ta qator*. Bosilganda `orders` jadvali `customer_id = 294` filtri bilan ochiladi.
- Foreign key ustunlarining sarlavhasida maxsus belgi bo'ladi, ustiga kelganda qaysi jadvalga bog'langani ko'rsatiladi.
- Bir nechta ustunli (composite) foreign key'lar ham ishlaydi.

**Texnik reja:**
- Rust (`lens-core`): `information_schema.KEY_COLUMN_USAGE` va `REFERENTIAL_CONSTRAINTS` dan jadvalning chiquvchi va kiruvchi bog'lanishlarini o'qiydigan `foreign_keys(db, table)` funksiyasi. Natija schema bilan birga keshlanadi.
- Orqa havolalar soni faqat tanlangan qator uchun, kerak bo'lganda hisoblanadi (`SELECT COUNT(*) … LIMIT`), shuning uchun katta jadvallarda sekinlashmaydi.
- UI: grid'da foreign key katakchalari uchun havola ko'rinishi, context menu bandlari, Inspector'da yangi bo'lim.
- Foreign key e'lon qilinmagan bazalar (masalan, faqat nom bo'yicha `user_id`) uchun keyinroq ixtiyoriy "taxminiy bog'lanish" rejimi qo'shish mumkin.
- 0.6.0 da qilingani: grid'da link ko'rinishi va `Ctrl+bosish`, o'ng tugma menyusi, Inspector'da maydon ostida havola va "Referenced by" bo'limi (1000 tagacha sanaydi). Allaqachon ochiq jadval tab'i yangi filtr bilan qayta yuklanadi. SQL query natijalarida havolalar hali yo'q (ustunlar qaysi jadvalga tegishli ekani aniq emas).

**Tayyor deb hisoblanadi, agar:**
- `orders` → `customers` va teskari yo'nalishda bir bosishda o'tish ishlasa.
- Composite foreign key bo'yicha to'g'ri filtr tuzilsa.
- Foreign key'i yo'q jadvalda hech narsa buzilmasa va ortiqcha so'rov yuborilmasa.

---

## Tayyor bo'lganlar (0.4.0)

- ✅ So'rovlar tarixi (`Ctrl+H`): har bir bajarilgan so'rov ulanish, baza, vaqt va davomiylik bilan `history.jsonl`ga yoziladi (oxirgi 1000 ta). Qidiruv, yangi tab'da ochish, o'chirish.
- ✅ Explorer: jadval, view, routine va trigger uchun "Show DDL"; jadval uchun SELECT / INSERT / UPDATE / DELETE shablonlari.
- ✅ Ulanishlar ro'yxatini export/import qilish (parollarsiz). Fayl formati VS Code kengaytmasi bilan bir xil.

## Tayyor bo'lganlar (0.4.1)

- ✅ Cancel haqiqatan ishlaydi: serverda `KILL QUERY`, qolgan statementlar bajarilmaydi.
- ✅ Editor so'rovlarni bo'lingan holda yuboradi, shuning uchun procedure/trigger tanasi (`DELIMITER`) butun bajariladi.
- ✅ Xavfsizlik: WHERE'siz UPDATE/DELETE, DROP, TRUNCATE tasdiq so'raydi. Qizil (production) ulanishda har qanday yozish tasdiq so'raydi, xavflilari uchun ulanish nomini yozish kerak; ish maydoni qizil ramkada.

---

## Tayyor bo'lganlar (0.6.0)

- ✅ Foreign key bo'ylab yurish (yuqoridagi 3-band).
- ✅ SQL formatter: `Shift+Alt+F` yoki tayoqcha tugmasi. Tanlangan qism yoki butun matn formatlanadi, `DELIMITER` qatorlari va procedure/trigger tanalari o'zgarmaydi. `sql-formatter` faqat birinchi ishlatilganda yuklanadi.
- ✅ Qiymat muharriri (JSON/BLOB): JSON formatlanadi va tekshiriladi (noto'g'ri JSON saqlanmaydi), rasmlar (PNG, JPEG, GIF, WEBP, BMP, ICO) preview qilinadi, qolgani hex dump ko'rinishida chiqadi. Faylga saqlash, fayldan yuklash (32 MB gacha).
- ✅ Windows'da bir buyruq bilan o'rnatish: `irm https://raw.githubusercontent.com/azizdevfull/mysql-lens/main/install.ps1 | iex`.

## Tayyor bo'lganlar (0.7.0)

- ✅ Transaction rejimi: query tab'da "Auto-commit" ↔ "Manual commit". Manual rejimda tab o'zining alohida ulanishida (`autocommit = 0`) ishlaydi, Commit/Rollback tugmalari va "N uncommitted · M rows" belgisi bor. DDL va boshqa implicit commit qiladigan statementlardan keyin xabar chiqadi. Commit qilinmagan tab yopilganda yoki ulanish almashtirilganda tasdiq so'raladi, keyin rollback qilinadi. Hisob UI'da statementlarning birinchi so'ziga qarab yuritiladi (mysql_async transaction holatini ochiq bermaydi).
- ✅ Saqlangan so'rovlar: query tab'da `Ctrl+S` saqlaydi (`Ctrl+Shift+S` yangi nom bilan), `Ctrl+K` da "Saved queries" guruhi, "Saved queries…" dialogida qidirish, nomini o'zgartirish, o'chirish. `snippets.json` ilova papkasida, buzilgan fayl `.bak` qilib saqlanadi.
- ✅ ER diagramma: bazaning jadvallari, ustunlari va foreign key'lari (dagre layout, faqat ochilganda yuklanadi). Sudrash, zoom, jadvalni tanlab bog'lanishlarini ajratish, ikki marta bosib ochish, qidiruv, "Keys only" rejimi. Explorer'da bazaga o'ng tugma yoki `Ctrl+K` → "ER diagram".

## Keyinroq (g'oyalar)

- ER diagrammani PNG/SVG sifatida eksport qilish, joylashuvni saqlab qolish
- Query natijalarida ham FK havolalari (`org_table` orqali)
- Jadval strukturasini tahrirlash (ustun, indeks, foreign key) — `ALTER TABLE` preview bilan
- Schema compare: staging ↔ production, farqni tuzatadigan SQL bilan
- Server monitori: processlist va KILL, sekin so'rovlar, holat grafiklari
- EXPLAIN vizualizatori
- Avtomatik backup (jadval bo'yicha dump)
- AI yordamchi: o'zbekcha savoldan SQL
- So'rov natijasidan grafik
- Laravel generator: jadvaldan Eloquent model va migration
- winget paketi (`winget install MySQLLens`): `microsoft/winget-pkgs` ga manifest PR yuborish kerak
- Windows kod imzosi (SignPath Foundation) — Smart App Control / SmartScreen ogohlantirishlarini yo'qotish uchun
