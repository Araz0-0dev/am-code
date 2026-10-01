# گذاشتن ورژن‌ها روی گیت‌هاب (نسخه‌بندی و Release)

> راهنمای کوتاه و عملی. نسخهٔ فعلی پروژه **0.1.2** است.

---

## ۱) سه مفهوم که نباید قاطی شوند

| اصطلاح | چیست | کجاست |
| --- | --- | --- |
| **Commit** | یک تغییر کد (هر چند بار در روز) | تب **Commits** |
| **Tag** | برچسب نسخه روی یک commit، مثل `v0.1.2` | تب **Tags** (کنار Releases) |
| **Release** | صفحهٔ قابل‌دانلود روی یک تگ، با فایل ضمیمه (VSIX) و توضیحات | تب **Releases** |

یعنی: کد را کامیت می‌کنی → وقتی آماده شد یک **تگ** می‌زنی → گیت‌هاب از آن تگ یک **Release** می‌سازد
که کاربران فایل `.vsix` را از آن دانلود می‌کنند.

---

## ۲) کدام شماره را بالا ببرم؟ (Semantic Versioning)

نسخه سه بخش دارد: `MAJOR.MINOR.PATCH` → مثلاً `0.1.2`

| تغییر | دستور | مثال |
| --- | --- | --- |
| رفع باگ، اصلاح متن، پولیش | `npm version patch` | `0.1.2 → 0.1.3` |
| قابلیت جدید (سازگار با قبل) | `npm version minor` | `0.1.3 → 0.2.0` |
| تغییر ناسازگار (حذف/تغییر تنظیمات) | `npm version major` | `0.2.0 → 1.0.0` |
| نسخهٔ آزمایشی | `npm version prerelease --preid=beta` | `0.2.0 → 0.2.1-beta.0` |

قبل از ۱.۰.۰ هستیم؛ خیلی‌ها برای ابزارهای نو `0.x.y` می‌مانند تا API تثبیت شود.

---

## ۳) روش اصلی: یک دستور (خودکار)

```bash
# ۱. تغییرات را کامیت کن
git add -A
git commit -m "fix: handle empty model list in the models screen"

# ۲. نسخه را بالا ببر (package.json + commit + tag خودکار)
npm version patch          # یا minor / major

# ۳. تگ را بفرست؛ ورک‌فلو بقیهٔ کارها را می‌کند
git push --follow-tags
```

`npm version patch` این کارها را خودش انجام می‌دهد (خروجی واقعی):

```
$ npm version patch
v0.1.3                       ← تگ ساخته شد

$ git log --oneline
cebbe59 0.1.3                ← یک کامیت خودکار برای بالا بردن نسخه
947c578 feat: first version

$ node -p require('./package.json').version
0.1.3                        ← package.json هم به‌روز شد
```

بعد از `git push --follow-tags` ورک‌فلو `.github/workflows/release.yml` اجرا می‌شود و:

1. وابستگی‌ها را نصب و **تایپ‌چک + ۳۱ تست** را اجرا می‌کند (اگر خراب باشد ریلیس نمی‌شود)
2. اکستنشن را بیلد می‌کند و `am-code-0.1.3.vsix` می‌سازد
3. `panel-preview.html` را می‌سازد
4. یک **GitHub Release** با تگ `v0.1.3` می‌سازد، release-notes خودکار از کامیت‌ها، و VSIX را ضمیمه می‌کند

> اگر تگ حاوی `-` باشد (مثل `v0.2.1-beta.0`) به‌صورت **Pre-release** منتشر می‌شود و در صفحهٔ عادی
> Releases نمایش داده نمی‌شود مگر روی «Include pre-releases» بزنی.

### اگر ورک‌فلو اجازهٔ نوشتن نداشت
**Settings → Actions → General → Workflow permissions → Read and write permissions** را انتخاب کن.

---

## ۴) روش دستی (بدون خط فرمان)

1. کد را با رابط وب/دسکتاپ گیت‌هاب آپلود کن.
2. در `package.json` مقدار `"version"` را دستی عوض کن (مثلاً `0.1.3`) و کامیت کن.
3. تب **Releases** → **Draft a new release** → **Choose a tag** → تایپ کن `v0.1.3` → **Create new tag on publish**.
4. عنوان: `AM Code 0.1.3` · توضیحات: تغییرات این نسخه (یا دکمهٔ **Generate release notes**).
5. فایل VSIX را با کشیدن‌ورها کردن در کادر «Attach binaries» اضافه کن (از `npm run package` ساخته می‌شود).
6. **Publish release**.

---

## ۵) بعد از هر ریلیس

- **لینک همیشه-آخرین-نسخه** را در README بگذار:
  `https://github.com/<USER>/am-code/releases/latest/download/am-code-0.1.2.vsix`
  (در ریلیس‌های بعدی فقط شماره را عوض کن، یا از `releases/latest` بدون شماره استفاده کن.)
- **چنج‌لاگ** را به‌روز کن: فایل `CHANGELOG.md` را ویرایش و زیر همان نسخه بنویس چه چیزی اضافه/درست شد
  (الگو در همان فایل هست). بعد `git commit -m "docs: changelog for 0.1.3"`.
- **بج نسخه** در README (اختیاری):
  `![version](https://img.shields.io/github/v/release/<USER>/am-code)`
- **ویرایش/حذف ریلیس منتشرشده**: تب Releases → آیکن مداد (ویرایش) یا منوی `…` → Delete.
  (تگ را هم می‌توانی از تب Tags حذف/جابه‌جا کنی.)
- **اشتباه در شمارهٔ نسخه؟** اگر هنوز push نکرده‌ای: `npm version` را دوباره اجرا کن یا
  `git tag -d v0.1.3 && git reset --hard HEAD~1`. اگر push کرده‌ای، یک نسخهٔ جدید بزن (تگ منتشرشده را
  جابه‌جا نکن — کاربران ممکن است دانلود کرده باشند).

---

## ۶) انتشار در Marketplace (اختیاری، بعد از ریلیس گیت‌هاب)

```bash
npx vsce login <publisher-id>     # یک‌بار؛ PAT از Azure DevOps با اسکوپ Marketplace→Manage
npm run publish                   # بیلد + انتشار در market.visualstudio.com
```

برای خودکارسازی: PAT را در **Settings → Secrets and variables → Actions** با نام `VSCE_PAT` ذخیره کن
و به انتهای `release.yml` اضافه کن:

```yaml
      - name: Publish to Marketplace
        run: npx vsce publish --pat "$VSCE_PAT"
        env:
          VSCE_PAT: ${{ secrets.VSCE_PAT }}
```

---

## ۷) چک‌لیست هر نسخه

```bash
git add -A && git commit -m "feat: ..."     # ۱) تغییرات
npm test                                    # ۲) تست‌ها سبز (۳۱/۳۱)
#   CHANGELOG.md را ویرایش کن                # ۳) ثبت تغییرات
npm version patch                           # ۴) نسخه + تگ
git push --follow-tags                      # ۵) آپلود → ریلیس خودکار
# ۶) در تب Releases چک کن VSIX ضمیمه شده
```

---

تلگرام: **[@AM0_0dev](https://t.me/AM0_0dev)**
