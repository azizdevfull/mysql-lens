# MySQL Studio

VS Code uchun MySQL / MariaDB extension. Ulanishlar soni cheklanmagan.

## Imkoniyatlar

- **Ulanishlar**: soni cheklanmagan; SSH tunnel (parol, private key, agent), SSL/TLS,
  read-only rejim, rang belgisi (masalan, production uchun qizil). Parollar OS keychain'da
  (VS Code SecretStorage) saqlanadi. `mysql://user:pass@host/db` URL'ini forma ichiga
  joylashtirsangiz, maydonlar avtomatik to'ldiriladi.
- **Daraxt (tree)**: database → jadval / view / procedure / function / trigger → ustunlar va indekslar.
  Ulanishlarni drag & drop bilan tartiblash mumkin.
- **SQL editor**: `Ctrl+Enter` kursor turgan statement'ni (yoki belgilangan qismni) bajaradi,
  `Ctrl+Shift+Enter` hammasini. Har bir editor o'z sessiyasiga ega (USE, SET, tranzaksiyalar saqlanadi).
  Status bar'da ulanish va database tanlanadi. Jadval/ustun nomlari, alias'lar va funksiyalar uchun autocomplete bor.
  `WHERE`siz UPDATE/DELETE, DROP va TRUNCATE oldidan tasdiq so'raladi.
- **Natijalar**: virtual grid (millionlab katak sekinlashmaydi), bir nechta result set,
  qidiruv, saralash, ustun kengligini o'zgartirish, Sum/Avg, nusxalash formatlari
  (TSV, CSV, JSON, SQL INSERT, Markdown, `IN (...)`), so'rovni bekor qilish (`KILL QUERY`).
- **Jadval tahrirlash**: sahifalash, WHERE filtri, server tomonda saralash, inline tahrirlash,
  qator qo'shish / nusxalash / o'chirish, Excel'dan paste, NULL qo'yish, JSON/uzun matn dialogi.
  Saqlashdan oldin SQL ko'rsatiladi va hammasi bitta tranzaksiyada bajariladi.
- **Export**: natija yoki jadvalni CSV, TSV, Excel (.xlsx), JSON, SQL INSERT yoki Markdown'ga.
  Database'ni SQL dump qilish (.sql yoki .sql.gz): struktura va/yoki data, view, procedure,
  function, trigger. Dump DEFINER'siz yoziladi.
- **Import**: .sql / .sql.gz faylni streaming bilan bajarish (DELIMITER qo'llanadi, xatoda
  Skip / Skip All / Stop tanlanadi). CSV/TSV, JSON/JSONL va Excel'dan jadvalga import:
  ustunlarni moslash, yangi jadval yaratish (tiplar avtomatik aniqlanadi), INSERT / IGNORE / REPLACE.
  Import bitta tranzaksiyada ishlaydi.
- **Query history** va ulanishlarni JSON'ga export/import qilish (parollarsiz).

## O'rnatish

```bash
npm install
npm run package          # mysql-studio-0.1.0.vsix
code --install-extension mysql-studio-0.1.0.vsix
```

## Ishlab chiqish

```bash
npm run watch            # VS Code'da F5 → Extension Development Host
npm run typecheck
npm test                 # haqiqiy MySQL'ga qarshi integration testlar (MSTUDIO_* env)
```
