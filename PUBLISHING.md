# راهنمای انتشار AM Code روی گیت‌هاب

> ۱۰ دقیقه وقت می‌برد. از بالا به پایین انجام بده.

---

## ۰) قبل از هر چیز: دو مقدار را عوض کن

در فایل `package.json` این دو خط را با اطلاعات خودت جایگزین کن (چون فعلاً حدس زده‌ام):

```jsonc
"repository": { "type": "git", "url": "https://github.com/Araz0-0dev/am-code.git" },
"homepage": "https://github.com/Araz0-0dev/am-code#readme",
"publisher": "agentcode",          // ← شناسهٔ ناشر VS Code خودت (حروف کوچک، بدون فاصله)
"author": { "name": "AM Code", "url": "https://t.me/AM0_0dev" }
```

و در همان مسیر، داخل این فایل‌ها `AM0-0dev` را با نام کاربری گیت‌هابت عوض کن:

```bash
grep -rl "AM0-0dev" . --exclude-dir=node_modules --exclude-dir=.git
# سپس در هر فایل مقدار را تغییر بده (README.en.md، .github/workflows/*.yml، package.json)
```

---

## ۱) آپلود پروژه روی گیت‌هاب

### راه الف — با خط فرمان (پیشنهادی)

```bash
# محتوای فایل ZIP را باز کن، بعد در همان پوشه:
cd am-code

git init
git add .
git commit -m "feat: AM Code — agentic AI coding assistant for VS Code"

# مخزن را بساز (اگر gh نصب است):
gh repo create am-code --public --source=. --remote=origin --push

# یا دستی: اول در github.com یک مخزن خالی به نام am-code بساز، بعد:
git branch -M main
git remote add origin https://github.com/<YOUR-USER>/am-code.git
git push -u origin main
```

### راه ب — با رابط وب

1. github.com → **New repository** → نام: `am-code` → Public → **بدون** README/gitignore/LICENSE (چون خودمان داریم) → Create.
2. در صفحهٔ مخزن: **uploading an existing file** → همهٔ فایل‌ها و پوشه‌های داخل ZIP را بکش و رها کن
   (پوشهٔ `node_modules` را هرگز آپلود نکن — در ZIP نیست).
3. Commit message: `feat: initial release` → **Commit changes**.

> ✅ در ZIP این‌ها آماده‌اند: `LICENSE` (MIT)، `.gitignore`، `README.md` (فارسی)، `README.en.md` (انگلیسی)،
> `.github/workflows/ci.yml` (تست خودکار روی هر push) و `.github/workflows/release.yml` (ساخت و انتشار خودکار نسخه).

---

## ۲) ریلیز گرفتن (Release) — خودکار

ورک‌فلو `release.yml` وقتی تگ `v*.*.*` بزنی اجرا می‌شود: نصب وابستگی‌ها → تایپ‌چک → **اجرای ۳۱ تست** →
بیلد → ساخت VSIX → ساخت `panel-preview.html` → **ساخت GitHub Release با فایل‌های ضمیمه**.

```bash
npm version patch      # یا minor / major — نسخه را بالا می‌برد و خودش تگ می‌زند
git push --follow-tags
```

اجرای دستی: تب **Actions** → **Release VSIX** → **Run workflow** (بدون تگ فقط artifact می‌سازد).

نتیجه: در تب **Releases** یک نسخه با فایل‌های `am-code-0.1.2.vsix` و `panel-preview.html` و
release-notes خودکار ظاهر می‌شود. لینک همیشگی آخرین نسخه:

```
https://github.com/<YOUR-USER>/am-code/releases/latest
```

### نکته‌ها

- اگر ورک‌فلو اجازهٔ نوشتن نداشت: **Settings → Actions → General → Workflow permissions →
  Read and write permissions** را انتخاب کن.
- برای اینکه کاربران با یک کلیک نصب کنند، در README لینک مستقیم VSIX بگذار:
  `[⬇️ Download VSIX](https://github.com/<YOUR-USER>/am-code/releases/latest/download/am-code-0.1.2.vsix)`
- فایل VSIX را می‌توانی دستی هم بسازی و در Releases آپلود کنی: `npm run package`

---

## ۳) (اختیاری) انتشار در VS Code Marketplace

تا وقتی تگ‌ها را می‌زنی، پروژه «اوپن‌سورس روی گیت‌هاب» است و کاربران نسخه را از Releases نصب می‌کنند.
اگر خواستی در Marketplace هم باشد:

1. <https://marketplace.visualstudio.com/manage> → سازنده بساز → شناسه‌اش را در `package.json` → `publisher` بگذار.
2. Azure DevOps → Personal Access Token با اسکوپ **Marketplace → Manage**.
3. سپس:

```bash
npx vsce login <publisher-id>     # یک‌بار، PAT را بچسبان
npm run publish                   # بیلد + تست + انتشار
```

برای انتشار خودکار در ورک‌فلو، PAT را در مخزن به‌عنوان Secret با نام `VSCE_PAT` ذخیره کن و به انتهای
`release.yml` این را اضافه کن:

```yaml
      - name: Publish to Marketplace
        run: npx vsce publish --pat "$VSCE_PAT"
        env:
          VSCE_PAT: ${{ secrets.VSCE_PAT }}
```

**Open VSX** (جایگزین اوپن‌سورس، برای VSCodium و Gitpod):

```bash
npx ovsx publish am-code-0.1.2.vsix -p $OVSX_TOKEN
```

---

## ۴) چه چیزهایی داخل ZIP است

```
am-code/
├─ src/                     کد اکستنشن (TypeScript)
├─ test/                    ۳۱ تست در ۴ سوئیت
├─ tools/make-preview.js    ساخت دموی UI در مرورگر
├─ media/icon.png|svg       لوگو
├─ .github/workflows/       ci.yml + release.yml
├─ .vscode/                 launch.json + tasks.json (برای F5)
├─ README.md                فارسی
├─ README.en.md             انگلیسی (شامل راهنمای انتشار)
├─ LICENSE                  MIT
├─ .gitignore .vscodeignore package.json tsconfig.json esbuild.js
└─ package-lock.json
```

`node_modules/`، `dist/` و `*.vsix` عمداً داخل ZIP نیستند (در `.gitignore` هستند و در گیت‌هاب لازم نیستند).

---

## ۵) چک‌لیست سریع

- [ ] `package.json`: مقدار `publisher` و آدرس `repository` را عوض کردم.
- [ ] `AM0-0dev` را در READMEها و ورک‌فلوها با نام کاربری خودم عوض کردم.
- [ ] `npm install && npm test && npm run build` بدون خطا اجرا شد.
- [ ] پروژه را push کردم و تب **Actions** سبز است.
- [ ] `npm version patch && git push --follow-tags` زدم و در **Releases** فایل VSIX آمد.
- [ ] لینک `releases/latest` را در README گذاشتم.

---

سؤالی بود: تلگرام **[@AM0_0dev](https://t.me/AM0_0dev)**
